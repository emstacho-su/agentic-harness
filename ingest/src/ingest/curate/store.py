"""Persistence for the curator: the ``curate`` schema (R-C2 cache, R-C3 ledger).

Import everything from here. Every curator stage talks to the
:class:`CurateStore` protocol; tests use :class:`InMemoryCurateStore` (both
defined in ``store_models``), which keeps the same keys, on-conflict rules, id
format and ordering as :class:`PostgresCurateStore`, the only place SQL is
written. Every statement is parameterized; no value is ever formatted into SQL.

Nothing is deleted or updated in place. Writes are inserts that do nothing on
a conflicting key, so a rerun with no new input writes nothing, apart from the
issue counter, which only moves when an issue is created.

Issue ids come from ``curate.issue_counters``, one row per collection, bumped
by ``INSERT .. ON CONFLICT DO UPDATE .. RETURNING`` in the same transaction as
the issue insert. The row lock serializes two allocators for one collection and
a rollback returns the number. ``max(seq) + 1`` cannot do that: Postgres
refuses ``FOR UPDATE`` on an aggregate, and two concurrent readers would pick
the same seq.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Sequence
from dataclasses import replace
from typing import Any, TypeVar
from urllib.parse import urlsplit

from ..config import DbSettings
from ..errors import ConfigError, StoreError
from ..jsonutil import dumps
from ..store import connect_kwargs
from .store_models import (
    CurateStore,
    Extraction,
    ExtractionKey,
    InMemoryCurateStore,
    Issue,
    IssueEvent,
    IssueMember,
    format_issue_id,
    new_issue,
)

__all__ = [
    "CurateStore", "Extraction", "ExtractionKey", "InMemoryCurateStore", "Issue",
    "IssueEvent", "IssueMember", "PostgresCurateStore", "format_issue_id",
]

log = logging.getLogger(__name__)

T = TypeVar("T")

_EXTRACTION_COLUMNS = (
    "note_id, content_hash, extractor_version, realm, collection, note_path, "
    "result, rejected, model, input_tokens, output_tokens, created_at"
)

_SELECT_EXTRACTION = f"""
SELECT {_EXTRACTION_COLUMNS} FROM curate.extractions
WHERE note_id = %s AND content_hash = %s AND extractor_version = %s
"""

# One round trip for a batch: the keys travel as three parallel arrays.
_SELECT_EXTRACTIONS_BATCH = f"""
SELECT {_EXTRACTION_COLUMNS} FROM curate.extractions
JOIN unnest(%s::text[], %s::text[], %s::text[]) AS k(note_id, content_hash, extractor_version)
USING (note_id, content_hash, extractor_version)
"""

_INSERT_EXTRACTION = f"""
INSERT INTO curate.extractions ({_EXTRACTION_COLUMNS})
VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s, coalesce(%s::timestamptz, now()))
ON CONFLICT (note_id, content_hash, extractor_version) DO NOTHING
"""

_NEXT_ISSUE_SEQ = """
INSERT INTO curate.issue_counters (collection, last_seq) VALUES (%s, 1)
ON CONFLICT (collection) DO UPDATE SET last_seq = curate.issue_counters.last_seq + 1
RETURNING last_seq
"""

_INSERT_ISSUE = """
INSERT INTO curate.issues (issue_id, collection, seq, kind, summary, files, first_seen_at)
VALUES (%s, %s, %s, %s, %s, %s::text[], %s::timestamptz)
RETURNING created_at
"""

_SELECT_ISSUES = """
SELECT issue_id, collection, seq, kind, summary, files, first_seen_at, created_at
FROM curate.issues WHERE collection = %s ORDER BY seq
"""

_INSERT_MEMBER = """
INSERT INTO curate.issue_members (issue_id, note_id, content_hash, extractor_version, item_index)
VALUES (%s, %s, %s, %s, %s)
ON CONFLICT (note_id, content_hash, extractor_version, item_index) DO NOTHING
RETURNING issue_id
"""

_SELECT_MEMBERS = """
SELECT m.issue_id, m.note_id, m.content_hash, m.extractor_version, m.item_index
FROM curate.issue_members m JOIN curate.issues i USING (issue_id)
WHERE i.collection = %s
ORDER BY i.seq, m.note_id, m.content_hash, m.extractor_version, m.item_index
"""

_INSERT_EVENT = """
INSERT INTO curate.issue_events
    (issue_id, to_state, event_kind, effective_at, recorded_at, cause_type, cause_ref, evidence)
VALUES (%s, %s, %s, %s::timestamptz, coalesce(%s::timestamptz, now()), %s, %s, %s)
ON CONFLICT (issue_id, event_kind, cause_type, cause_ref) DO NOTHING
RETURNING id
"""

_SELECT_EVENTS = """
SELECT e.id, e.issue_id, e.to_state, e.event_kind, e.effective_at, e.recorded_at,
       e.cause_type, e.cause_ref, e.evidence
FROM curate.issue_events e JOIN curate.issues i USING (issue_id)
WHERE i.collection = %s
ORDER BY e.effective_at, e.id
"""

_SELECT_CONFIRMATION = """
SELECT same FROM curate.judge_confirmations
WHERE item_key = %s AND issue_id = %s AND extractor_version = %s
"""

_INSERT_CONFIRMATION = """
INSERT INTO curate.judge_confirmations (item_key, issue_id, extractor_version, same, model)
VALUES (%s, %s, %s, %s, %s)
ON CONFLICT (item_key, issue_id, extractor_version) DO NOTHING
"""

# Keys per batched lookup, so one huge collection never becomes one huge statement.
_BATCH_SIZE = 500


def _json_column(raw: Any) -> list[Any]:
    """A jsonb array column, whether the driver decoded it or not."""
    value = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(value, list):
        raise StoreError(f"expected a JSON array in curate.extractions, got {type(value).__name__}")
    return value


def _extraction_from_row(row: tuple) -> Extraction:
    return Extraction(
        note_id=row[0], content_hash=row[1], extractor_version=row[2], realm=row[3],
        collection=row[4], note_path=row[5], result=tuple(_json_column(row[6])),
        rejected=tuple(_json_column(row[7])), model=row[8], input_tokens=row[9],
        output_tokens=row[10], created_at=row[11],
    )


def _issue_from_row(row: tuple) -> Issue:
    return Issue(row[0], row[1], int(row[2]), row[3], row[4], tuple(row[5] or ()), row[6], row[7])


def _event_from_row(row: tuple) -> IssueEvent:
    return IssueEvent(issue_id=row[1], to_state=row[2], event_kind=row[3], effective_at=row[4],
                      recorded_at=row[5], cause_type=row[6], cause_ref=row[7], evidence=row[8],
                      id=int(row[0]))


def _connection_lost(exc: Exception) -> bool:
    """A dead connection is worth one reconnect; a query error is not."""
    return type(exc).__name__ in {"OperationalError", "InterfaceError"} or "connection is closed" in str(exc)


class PostgresCurateStore:
    """psycopg-backed :class:`CurateStore`. One explicit transaction per call.

    Judge calls leave the connection idle for minutes, so a dropped connection is
    reconnected once and the call retried, except for ``create_issue``: if the
    commit's reply is what got lost, a retry would allocate a second id.
    """

    def __init__(self, connection, database_url: str | None = None,
                 connect_options: dict[str, object] | None = None) -> None:
        self._conn = connection
        self._database_url = database_url
        self._connect_options = dict(connect_options or {"autocommit": False})

    @classmethod
    def from_settings(cls, settings: DbSettings) -> "PostgresCurateStore":
        if not settings.can_connect:
            raise ConfigError("DATABASE_URL is not set; the curator's store is the database.")
        import psycopg

        options = connect_kwargs(settings)  # ConfigError before any I/O
        try:
            connection = psycopg.connect(settings.database_url, **options)
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            message = _redact(str(exc), settings.database_url)
            raise StoreError(f"Could not connect to the database: {message}") from None
        return cls(connection, database_url=settings.database_url, connect_options=options)

    # -- reads ---------------------------------------------------------------

    def get_extraction(self, note_id: str, content_hash: str, extractor_version: str) -> Extraction | None:
        found = self._select("extraction lookup", _SELECT_EXTRACTION,
                             (note_id, content_hash, extractor_version), _extraction_from_row)
        return found[0] if found else None

    def get_extractions(self, keys: Sequence[ExtractionKey]) -> dict[ExtractionKey, Extraction]:
        found: dict[ExtractionKey, Extraction] = {}
        wanted = [tuple(key) for key in keys]
        for start in range(0, len(wanted), _BATCH_SIZE):
            batch = wanted[start:start + _BATCH_SIZE]
            params = tuple([key[i] for key in batch] for i in range(3))
            for extraction in self._select("extraction batch lookup", _SELECT_EXTRACTIONS_BATCH,
                                           params, _extraction_from_row):
                found[extraction.key] = extraction
        return found

    def list_issues(self, collection: str) -> tuple[Issue, ...]:
        return self._select("issue list", _SELECT_ISSUES, (collection,), _issue_from_row)

    def members(self, collection: str) -> tuple[IssueMember, ...]:
        return self._select("issue members", _SELECT_MEMBERS, (collection,),
                            lambda r: IssueMember(r[0], r[1], r[2], r[3], int(r[4])))

    def events(self, collection: str) -> tuple[IssueEvent, ...]:
        return self._select("issue events", _SELECT_EVENTS, (collection,), _event_from_row)

    def get_confirmation(self, item_key: str, issue_id: str, extractor_version: str) -> bool | None:
        found = self._select("judge confirmation", _SELECT_CONFIRMATION,
                             (item_key, issue_id, extractor_version), lambda r: bool(r[0]))
        return found[0] if found else None

    # -- writes --------------------------------------------------------------

    def put_extraction(self, extraction: Extraction) -> None:
        e = extraction
        self._write(f"extraction of {e.note_id}", _INSERT_EXTRACTION, (
            e.note_id, e.content_hash, e.extractor_version, e.realm, e.collection, e.note_path,
            dumps(list(e.result)), dumps(list(e.rejected)), e.model, e.input_tokens,
            e.output_tokens, e.created_at,
        ))

    def create_issue(self, collection: str, kind: str | None, summary: str,
                     files: Sequence[str], first_seen_at: str) -> Issue:
        new_issue(collection, 1, kind, summary, files, first_seen_at)  # validate before any I/O

        def allocate_and_insert() -> Issue:
            with self._conn.cursor() as cur:
                cur.execute(_NEXT_ISSUE_SEQ, (collection,))
                seq = int(cur.fetchone()[0])
                issue = new_issue(collection, seq, kind, summary, files, first_seen_at)
                cur.execute(_INSERT_ISSUE, (issue.issue_id, collection, seq, kind, summary,
                                            list(issue.files), issue.first_seen_at))
                created = cur.fetchone()
            self._conn.commit()
            return replace(issue, created_at=created[0] if created else None)

        return self._run(f"creating an issue in {collection}", allocate_and_insert, retry=False)

    def add_member(self, member: IssueMember) -> bool:
        m = member
        return self._write(f"member of {m.issue_id}", _INSERT_MEMBER, (
            m.issue_id, m.note_id, m.content_hash, m.extractor_version, m.item_index))

    def add_event(self, event: IssueEvent) -> bool:
        e = event
        return self._write(f"{e.event_kind} event of {e.issue_id}", _INSERT_EVENT, (
            e.issue_id, e.to_state, e.event_kind, e.effective_at, e.recorded_at,
            e.cause_type, e.cause_ref, e.evidence))

    def put_confirmation(self, item_key: str, issue_id: str, extractor_version: str,
                         same: bool, model: str | None) -> None:
        self._write(f"confirmation for {issue_id}", _INSERT_CONFIRMATION,
                    (item_key, issue_id, extractor_version, bool(same), model))

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception as exc:  # noqa: BLE001 - logged, not raised on teardown
            log.warning("Closing the database connection failed: %s", self._redact(str(exc)))

    # -- plumbing ------------------------------------------------------------

    def _select(self, what: str, sql: str, params: tuple[Any, ...],
                build: Callable[[tuple], T]) -> tuple[T, ...]:
        def read() -> list[tuple]:
            with self._conn.cursor() as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
            self._conn.rollback()  # end the implicit read transaction
            return rows

        rows = self._run(what, read)
        try:
            return tuple(build(row) for row in rows)
        except (ValueError, TypeError, IndexError) as exc:
            raise StoreError(f"{what} returned a malformed row: {exc}") from exc

    def _write(self, what: str, sql: str, params: tuple[Any, ...]) -> bool:
        """Run one insert and commit. True when a row landed (for RETURNING statements)."""
        def write() -> bool:
            with self._conn.cursor() as cur:
                cur.execute(sql, params)
                landed = "RETURNING" in sql and cur.fetchone() is not None
            self._conn.commit()
            return landed

        return self._run(what, write)

    def _run(self, what: str, operation: Callable[[], T], *, retry: bool = True) -> T:
        try:
            return operation()
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            self._safe_rollback()
            if not (retry and _connection_lost(exc) and self._reconnect()):
                raise StoreError(f"{what} failed: {self._redact(str(exc))}") from exc
        log.warning("%s hit a dropped connection; reconnected and retrying.", what)
        try:
            return operation()
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            self._safe_rollback()
            raise StoreError(f"{what} failed after a reconnect: {self._redact(str(exc))}") from exc

    def _reconnect(self) -> bool:
        if not self._database_url:
            return False
        import psycopg

        try:
            self._conn.close()
        except Exception as exc:  # noqa: BLE001 - the old connection is already dead
            log.debug("Closing the dropped connection failed: %s", self._redact(str(exc)))
        try:
            self._conn = psycopg.connect(self._database_url, **self._connect_options)
        except Exception as exc:  # noqa: BLE001 - reported, and the caller raises
            log.error("Reconnect failed: %s", self._redact(str(exc)))
            return False
        return True

    def _safe_rollback(self) -> None:
        try:
            self._conn.rollback()
        except Exception as exc:  # noqa: BLE001 - the original error is what matters
            log.debug("Rollback failed: %s", self._redact(str(exc)))

    def _redact(self, text: str) -> str:
        return _redact(text, self._database_url)


def _redact(text: str, database_url: str | None) -> str:
    """``text`` with the connection string and its password masked."""
    if not database_url:
        return text
    redacted = text.replace(database_url, "<DATABASE_URL>")
    try:
        password = urlsplit(database_url).password
    except ValueError:
        password = None
    return redacted.replace(password, "***") if password else redacted
