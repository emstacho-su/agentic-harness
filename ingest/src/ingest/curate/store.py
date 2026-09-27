"""Persistence for the curator: the ``curate`` schema (R-C2 cache, R-C3 ledger,
R-C5 history cache, R-C6 scores and proposals, R-C7 decisions).

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

``curate.decisions`` is the one table with no natural key: it is an append-only
log of Stack's ticks and unticks, and a row lands only when it changes the
latest decision for its proposal. That read and the insert share a transaction
that first takes ``SHARE ROW EXCLUSIVE`` on the table, a mode that conflicts
with itself but not with readers, so two recorders cannot both see the same
"latest" and both append.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Sequence
from dataclasses import replace
from datetime import date
from typing import Any, TypeVar
from urllib.parse import urlsplit

from ..config import DbSettings
from ..errors import ConfigError, StoreError
from ..jsonutil import dumps
from ..store import connect_kwargs
from .store_models import (
    CurateStore,
    Decision,
    Extraction,
    ExtractionKey,
    HistoryWeek,
    ImportanceJudgement,
    InMemoryCurateStore,
    Issue,
    IssueEvent,
    IssueMember,
    NoteScore,
    Proposal,
    format_issue_id,
    new_issue,
    to_iso_day,
)

__all__ = [
    "CurateStore", "Decision", "Extraction", "ExtractionKey", "HistoryWeek",
    "ImportanceJudgement", "InMemoryCurateStore", "Issue", "IssueEvent", "IssueMember",
    "NoteScore", "PostgresCurateStore", "Proposal", "format_issue_id",
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
ON CONFLICT (issue_id, event_kind, cause_type, cause_ref, to_state) DO NOTHING
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

_HISTORY_WEEK_COLUMNS = (
    "collection, week_start, input_hash, history_version, narrative, titles, model, "
    "input_tokens, output_tokens, created_at"
)

_SELECT_HISTORY_WEEK = f"""
SELECT {_HISTORY_WEEK_COLUMNS} FROM curate.history_weeks
WHERE collection = %s AND week_start = %s::date AND input_hash = %s AND history_version = %s
"""

_INSERT_HISTORY_WEEK = f"""
INSERT INTO curate.history_weeks ({_HISTORY_WEEK_COLUMNS})
VALUES (%s, %s::date, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s, coalesce(%s::timestamptz, now()))
ON CONFLICT (collection, week_start, input_hash, history_version) DO NOTHING
"""

_NOTE_SCORE_COLUMNS = (
    "note_id, scorer_version, run_day, content_hash, realm, collection, impact, relevance, "
    "features, importance, created_at"
)

_INSERT_NOTE_SCORE = f"""
INSERT INTO curate.note_scores ({_NOTE_SCORE_COLUMNS})
VALUES (%s, %s, %s::date, %s, %s, %s, %s, %s, %s::jsonb, %s, coalesce(%s::timestamptz, now()))
ON CONFLICT (note_id, scorer_version, run_day) DO NOTHING
RETURNING note_id
"""

_SELECT_NOTE_SCORES = f"""
SELECT {_NOTE_SCORE_COLUMNS} FROM curate.note_scores
WHERE collection = %s AND run_day = %s::date
ORDER BY note_id, scorer_version
"""

_SELECT_IMPORTANCE = """
SELECT note_id, content_hash, scorer_version, importance, model, created_at
FROM curate.importance_judgements
WHERE note_id = %s AND content_hash = %s AND scorer_version = %s
"""

_INSERT_IMPORTANCE = """
INSERT INTO curate.importance_judgements
    (note_id, content_hash, scorer_version, importance, model, created_at)
VALUES (%s, %s, %s, %s, %s, coalesce(%s::timestamptz, now()))
ON CONFLICT (note_id, content_hash, scorer_version) DO NOTHING
"""

_PROPOSAL_COLUMNS = "realm_folder, report_day, note_id, action, collection, reasons, no_loss, created_at"

_INSERT_PROPOSAL = f"""
INSERT INTO curate.proposals ({_PROPOSAL_COLUMNS})
VALUES (%s, %s::date, %s, %s, %s, %s::jsonb, %s, coalesce(%s::timestamptz, now()))
ON CONFLICT (realm_folder, report_day, note_id, action) DO NOTHING
RETURNING note_id
"""

_SELECT_PROPOSALS = f"""
SELECT {_PROPOSAL_COLUMNS} FROM curate.proposals
WHERE realm_folder = %s
ORDER BY report_day, action, note_id
"""

# Conflicts with itself, not with readers: two recorders serialize, reports still read.
_LOCK_DECISIONS = "LOCK TABLE curate.decisions IN SHARE ROW EXCLUSIVE MODE"

_SELECT_LATEST_DECISION = """
SELECT accepted FROM curate.decisions
WHERE realm_folder = %s AND report_day = %s::date AND note_id = %s AND action = %s
ORDER BY id DESC LIMIT 1
"""

# Append-only log with an identity key: nothing to conflict on. record_decision's
# read under the table lock is what keeps an unchanged decision from landing twice.
_INSERT_DECISION = """
INSERT INTO curate.decisions (realm_folder, report_day, note_id, action, accepted, recorded_at)
VALUES (%s, %s::date, %s, %s, %s, coalesce(%s::timestamptz, now()))
RETURNING id
"""

_SELECT_DECISIONS = """
SELECT id, realm_folder, report_day, note_id, action, accepted, recorded_at
FROM curate.decisions WHERE realm_folder = %s ORDER BY id
"""

_SELECT_LATEST_DECISIONS = """
SELECT DISTINCT ON (note_id, action) note_id, action, accepted
FROM curate.decisions WHERE realm_folder = %s AND report_day = %s::date
ORDER BY note_id, action, id DESC
"""

# Keys per batched lookup, so one huge collection never becomes one huge statement.
_BATCH_SIZE = 500


def _json_column(raw: Any, table: str = "curate.extractions", kind: type = list) -> Any:
    """A jsonb column of the expected ``kind`` (list or dict), whether the driver decoded it or not."""
    value = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(value, kind):
        expected = "array" if kind is list else "object"
        raise StoreError(f"expected a JSON {expected} in {table}, got {type(value).__name__}")
    return value


def _history_week_from_row(row: tuple) -> HistoryWeek:
    return HistoryWeek(
        collection=row[0], week_start=row[1], input_hash=row[2], history_version=row[3],
        narrative=tuple(_json_column(row[4], "curate.history_weeks")),
        titles=_json_column(row[5], "curate.history_weeks", dict), model=row[6],
        input_tokens=row[7], output_tokens=row[8], created_at=row[9],
    )


def _note_score_from_row(row: tuple) -> NoteScore:
    return NoteScore(
        note_id=row[0], scorer_version=row[1], run_day=row[2], content_hash=row[3], realm=row[4],
        collection=row[5], impact=row[6], relevance=row[7],
        features=_json_column(row[8], "curate.note_scores", dict),
        importance=None if row[9] is None else int(row[9]), created_at=row[10],
    )


def _proposal_from_row(row: tuple) -> Proposal:
    return Proposal(
        realm_folder=row[0], report_day=row[1], note_id=row[2], action=row[3], collection=row[4],
        reasons=tuple(_json_column(row[5], "curate.proposals")), no_loss=row[6], created_at=row[7],
    )


def _decision_from_row(row: tuple) -> Decision:
    return Decision(realm_folder=row[1], report_day=row[2], note_id=row[3], action=row[4],
                    accepted=row[5], recorded_at=row[6], id=int(row[0]))


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

    def get_history_week(self, collection: str, week_start: str | date, input_hash: str,
                         version: str) -> HistoryWeek | None:
        found = self._select("history week lookup", _SELECT_HISTORY_WEEK,
                             (collection, to_iso_day(week_start), input_hash, version),
                             _history_week_from_row)
        return found[0] if found else None

    def note_scores(self, collection: str, run_day: str | date) -> tuple[NoteScore, ...]:
        return self._select("note scores", _SELECT_NOTE_SCORES, (collection, to_iso_day(run_day)),
                            _note_score_from_row)

    def get_importance(self, note_id: str, content_hash: str, version: str) -> ImportanceJudgement | None:
        found = self._select("importance lookup", _SELECT_IMPORTANCE, (note_id, content_hash, version),
                             lambda r: ImportanceJudgement(r[0], r[1], r[2], int(r[3]), r[4], r[5]))
        return found[0] if found else None

    def proposals(self, realm_folder: str) -> tuple[Proposal, ...]:
        return self._select("proposals", _SELECT_PROPOSALS, (realm_folder,), _proposal_from_row)

    def decisions(self, realm_folder: str) -> tuple[Decision, ...]:
        return self._select("decisions", _SELECT_DECISIONS, (realm_folder,), _decision_from_row)

    def latest_decisions(self, realm_folder: str, report_day: str | date) -> dict[tuple[str, str], bool]:
        rows = self._select("latest decisions", _SELECT_LATEST_DECISIONS,
                            (realm_folder, to_iso_day(report_day)), lambda r: ((r[0], r[1]), bool(r[2])))
        return dict(rows)

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

    def put_history_week(self, week: HistoryWeek) -> None:
        w = week
        self._write(f"history week {w.week_start} of {w.collection}", _INSERT_HISTORY_WEEK, (
            w.collection, w.week_start, w.input_hash, w.history_version, dumps(list(w.narrative)),
            dumps(w.titles), w.model, w.input_tokens, w.output_tokens, w.created_at,
        ))

    def put_note_score(self, score: NoteScore) -> bool:
        s = score
        return self._write(f"score of {s.note_id}", _INSERT_NOTE_SCORE, (
            s.note_id, s.scorer_version, s.run_day, s.content_hash, s.realm, s.collection,
            s.impact, s.relevance, dumps(s.features), s.importance, s.created_at,
        ))

    def put_importance(self, judgement: ImportanceJudgement) -> None:
        j = judgement
        self._write(f"importance of {j.note_id}", _INSERT_IMPORTANCE, (
            j.note_id, j.content_hash, j.scorer_version, j.importance, j.model, j.created_at))

    def put_proposal(self, proposal: Proposal) -> bool:
        p = proposal
        return self._write(f"{p.action} proposal for {p.note_id}", _INSERT_PROPOSAL, (
            p.realm_folder, p.report_day, p.note_id, p.action, p.collection,
            dumps(list(p.reasons)), p.no_loss, p.created_at,
        ))

    def record_decision(self, decision: Decision) -> bool:
        """Retried after a dropped connection: the retry re-reads the latest under the
        lock, so a first attempt that did commit makes it a no-op, never a duplicate."""
        d = decision

        def append_if_changed() -> bool:
            with self._conn.cursor() as cur:
                cur.execute(_LOCK_DECISIONS)
                cur.execute(_SELECT_LATEST_DECISION, (d.realm_folder, d.report_day, d.note_id, d.action))
                latest = cur.fetchone()
                changed = latest is None or bool(latest[0]) != d.accepted
                if changed:
                    cur.execute(_INSERT_DECISION, (d.realm_folder, d.report_day, d.note_id, d.action,
                                                   d.accepted, d.recorded_at))
                    changed = cur.fetchone() is not None
            self._conn.commit()  # also ends an unchanged read, releasing the lock
            return changed

        return self._run(f"{d.action} decision for {d.note_id}", append_if_changed)

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
