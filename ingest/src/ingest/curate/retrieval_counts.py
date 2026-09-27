"""R-C6's usage features: how often each vault note was retrieved, and used.

``rag.retrieval_events`` (R-P2) holds one row per result of one search. A vault
note is a result row with ``source = 'obsidian'`` and ``external_id`` = the
note's external id, which is its ``note_id`` here: the frontmatter ``id``, else
the vault-relative path, exactly as ingest keys documents.

One search can return several chunks of the same note (``rag.search``'s
``max_per_document``), so a retrieval is counted once per search, not per row:
distinct ``(note_source, note_external_id, retrieval_index)``. ``used`` counts
the retrievals with at least one row whose ``used`` is true; null (not judged
yet) counts as not used.

Read-only: one parameterized query in a ``read only`` transaction that is
always rolled back. A missing table, a refused query or a malformed row is a
:class:`~ingest.errors.StoreError`, never a silent zero: a zero here would read
as "never retrieved" and push a note toward pruning.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from typing import Protocol

from ..config import DbSettings
from ..errors import ConfigError, StoreError
from ..store import connect_kwargs
from .store import _redact

log = logging.getLogger(__name__)

OBSIDIAN_SOURCE = "obsidian"
UNDEFINED_TABLE = "UndefinedTable"

READ_ONLY_SQL = "set transaction read only"

COUNTS_SQL = """
SELECT external_id,
       count(DISTINCT (note_source, note_external_id, retrieval_index)),
       count(DISTINCT (note_source, note_external_id, retrieval_index)) FILTER (WHERE used)
FROM rag.retrieval_events
WHERE source = %s AND external_id = ANY(%s)
GROUP BY external_id
"""

Counts = tuple[int, int]  # (retrievals, used)


class RetrievalCounts(Protocol):
    """What the scores need from the retrieval record."""

    def counts(self, external_ids: Sequence[str]) -> dict[str, Counts]:
        """external id -> (retrievals, used), for the ids that were ever retrieved."""
        ...


def _check(external_id: str, retrievals: int, used: int) -> Counts:
    for name, value in (("retrievals", retrievals), ("used", used)):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f"{name} of {external_id} must be a non-negative integer")
    if used > retrievals:
        raise ValueError(f"{external_id} is used more often than it was retrieved")
    return (retrievals, used)


class DictRetrievalCounts:
    """A :class:`RetrievalCounts` over a fixed mapping, for tests; records every ask."""

    def __init__(self, mapping: Mapping[str, Counts]) -> None:
        self._counts = {key: _check(key, *value) for key, value in mapping.items()}
        self.asked: list[tuple[str, ...]] = []

    def counts(self, external_ids: Sequence[str]) -> dict[str, Counts]:
        self.asked.append(tuple(external_ids))
        return {key: self._counts[key] for key in external_ids if key in self._counts}

    def close(self) -> None:
        return None


class PostgresRetrievalCounts:
    """psycopg-backed :class:`RetrievalCounts`: one query per call, read-only."""

    def __init__(self, connection, database_url: str | None = None) -> None:
        self._conn = connection
        self._database_url = database_url

    @classmethod
    def from_settings(cls, settings: DbSettings) -> "PostgresRetrievalCounts":
        if not settings.can_connect:
            raise ConfigError("DATABASE_URL is not set; retrieval counts come from the database.")
        import psycopg

        options = connect_kwargs(settings)  # ConfigError before any I/O
        try:
            connection = psycopg.connect(settings.database_url, **options)
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            message = _redact(str(exc), settings.database_url)
            raise StoreError(f"Could not connect to the database: {message}") from None
        return cls(connection, database_url=settings.database_url)

    def counts(self, external_ids: Sequence[str]) -> dict[str, Counts]:
        wanted = list(dict.fromkeys(external_ids))
        if not wanted:
            return {}
        try:
            with self._conn.cursor() as cur:
                cur.execute(READ_ONLY_SQL)
                cur.execute(COUNTS_SQL, (OBSIDIAN_SOURCE, wanted))
                rows = cur.fetchall()
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            raise StoreError(self._describe(exc)) from exc
        finally:
            self._safe_rollback()
        try:
            return {str(row[0]): _check(str(row[0]), row[1], row[2]) for row in rows}
        except (ValueError, TypeError, IndexError) as exc:
            raise StoreError(f"retrieval counts returned a malformed row: {exc}") from exc

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception as exc:  # noqa: BLE001 - logged, not raised on teardown
            log.warning("Closing the database connection failed: %s", _redact(str(exc), self._database_url))

    def _describe(self, exc: Exception) -> str:
        if type(exc).__name__ == UNDEFINED_TABLE:
            return "retrieval counts failed: rag.retrieval_events does not exist; run `uv run ingest db migrate`"
        return f"retrieval counts failed: {_redact(str(exc), self._database_url)}"

    def _safe_rollback(self) -> None:
        try:
            self._conn.rollback()
        except Exception as exc:  # noqa: BLE001 - the original error is what matters
            log.debug("Rollback failed: %s", _redact(str(exc), self._database_url))
