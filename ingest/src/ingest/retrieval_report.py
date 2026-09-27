"""What the sessions searched for, and what came back (R-P3).

Reads ``rag.retrieval_events`` (one row per result of one search; an empty
result is one row with a null rank) and ``rag.documents``. Every number is
computed by a pure function over plain rows, so the arithmetic is tested
without a database; ``fetch_report`` is the one place that runs SQL.

Read-only. ``--since`` bounds every section except ``never_retrieved``, which
is about the whole store: a document is never retrieved only if no event, at
any time, names it.
"""

from __future__ import annotations

import json
import math
import re
import statistics
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

from .errors import ConfigError, StoreError
from .store import RETRIEVAL_EVENTS_TABLE

CHANNELS = ("tool", "session-start")
NO_COLLECTION = "(none)"

# Similarity histogram: 0.05 buckets from 0.50 to 1.00, one below, one for null.
BUCKET_WIDTH = 0.05
BUCKET_FLOOR = 0.50
BUCKETS_PER_UNIT = 20  # 1 / BUCKET_WIDTH, as an integer so boundaries are exact
FLOOR_INDEX = 10  # BUCKET_FLOOR * BUCKETS_PER_UNIT
TOP_INDEX = 19  # the 0.95-1.00 bucket; 1.00 itself belongs to it
BELOW_LABEL = "<0.50"
NULL_LABEL = "n/a"

_DAYS_BACK = re.compile(r"^([1-9][0-9]{0,4})d$")

TABLE_EXISTS_SQL = f"select to_regclass('{RETRIEVAL_EVENTS_TABLE}')"

READ_ONLY_SQL = "set transaction read only"

# The session note's collection is e.collection; the retrieved document's own
# collection and title come from rag.documents, when it still exists.
EVENTS_SQL = f"""
select e.session_id, e.note_external_id, e.retrieval_index, e.collection, e.channel,
       e.tool, e.query, e.filters, e.retrieved_at, e.rank, e.source, e.external_id,
       e.similarity, d.title, d.collection
from {RETRIEVAL_EVENTS_TABLE} e
left join rag.documents d on d.source = e.source and d.external_id = e.external_id
where %s::timestamptz is null or e.retrieved_at >= %s::timestamptz
order by e.retrieved_at, e.note_external_id, e.retrieval_index, e.rank
"""

# Whole store, never bounded by --since.
NEVER_RETRIEVED_SQL = f"""
select d.source, d.external_id, d.title, d.collection
from rag.documents d
where not exists (
  select 1 from {RETRIEVAL_EVENTS_TABLE} r
  where r.source = d.source and r.external_id = d.external_id
)
order by d.collection nulls first, d.external_id
"""


@dataclass(frozen=True)
class EventRow:
    """One row of rag.retrieval_events, plus the retrieved document's title and collection."""

    session_id: str
    note_external_id: str
    retrieval_index: int
    collection: str | None  # the session note's collection
    channel: str
    tool: str
    query: str
    filters: Mapping[str, Any] | str
    retrieved_at: datetime
    rank: int | None
    source: str | None
    external_id: str | None
    similarity: float | None
    title: str | None
    doc_collection: str | None

    @property
    def retrieval_key(self) -> tuple[str, int]:
        return (self.note_external_id, self.retrieval_index)

    @property
    def is_result(self) -> bool:
        return self.rank is not None


@dataclass(frozen=True)
class DocumentRow:
    source: str
    external_id: str
    title: str | None
    collection: str | None


# --------------------------------------------------------------------------
# --since
# --------------------------------------------------------------------------


def parse_since(value: str, now: datetime) -> datetime:
    """An ISO date (midnight UTC), an ISO datetime (naive read as UTC), or ``<N>d``."""
    text = value.strip()
    days = _DAYS_BACK.match(text)
    if days:
        return now - timedelta(days=int(days.group(1)))
    try:
        if len(text) == len("YYYY-MM-DD"):
            day = date.fromisoformat(text)
            return datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ConfigError(
            f"--since {value!r}: expected an ISO date (2026-09-10), an ISO datetime "
            "(2026-09-10T08:00:00Z) or a number of days back (14d)"
        ) from exc
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# --------------------------------------------------------------------------
# sections: pure functions over rows
# --------------------------------------------------------------------------


def build_report(
    events: Iterable[EventRow],
    never: Iterable[DocumentRow],
    *,
    since: datetime | None,
    limit: int,
) -> dict[str, Any]:
    rows = tuple(events)
    return {
        "totals": totals(rows, since=since),
        "most_retrieved": most_retrieved(rows, limit=limit),
        "never_retrieved": never_retrieved(tuple(never), limit=limit),
        "empty_queries": empty_queries(rows, limit=limit),
        "similarity_distribution": similarity_distribution(rows),
        "per_collection": per_collection(rows),
        "cross_collection": cross_collection(rows, limit=limit),
    }


def totals(events: Iterable[EventRow], *, since: datetime | None) -> dict[str, Any]:
    rows = tuple(events)
    times = [r.retrieved_at for r in rows]
    return {
        "events": len(rows),
        "retrievals": len({r.retrieval_key for r in rows}),
        "sessions": len({r.session_id for r in rows}),
        "first": _iso(min(times)) if times else None,
        "last": _iso(max(times)) if times else None,
        "since": _iso(since),
    }


def most_retrieved(events: Iterable[EventRow], *, limit: int) -> list[dict[str, Any]]:
    """Documents by result rows, then by distinct sessions."""
    groups: dict[tuple[str, str], list[EventRow]] = {}
    for row in events:
        if row.is_result:
            groups.setdefault((row.source or "", row.external_id or ""), []).append(row)
    ranked = sorted(
        groups.items(),
        key=lambda item: (-len(item[1]), -len({r.session_id for r in item[1]}), item[0]),
    )
    return [
        {
            "source": source,
            "external_id": external_id,
            "title": rows[0].title,
            "collection": rows[0].doc_collection,
            "count": len(rows),
            "sessions": len({r.session_id for r in rows}),
        }
        for (source, external_id), rows in ranked[:limit]
    ]


def never_retrieved(documents: Iterable[DocumentRow], *, limit: int) -> dict[str, Any]:
    ordered = sorted(documents, key=lambda d: (d.collection is not None, d.collection or "", d.external_id))
    counts = Counter(d.collection or NO_COLLECTION for d in ordered)
    return {
        "total": len(ordered),
        "by_collection": dict(sorted(counts.items(), key=lambda item: (-item[1], item[0]))),
        "sample": [
            {"source": d.source, "external_id": d.external_id, "title": d.title, "collection": d.collection}
            for d in ordered[:limit]
        ],
    }


def empty_queries(events: Iterable[EventRow], *, limit: int) -> dict[str, Any]:
    empties = sorted((r for r in events if not r.is_result), key=lambda r: r.retrieved_at, reverse=True)
    return {
        "total": len(empties),
        "queries": [
            {
                "retrieved_at": _iso(r.retrieved_at),
                "session_id": r.session_id,
                "collection": r.collection,
                "tool": r.tool,
                "query": r.query,
                "filters": _filters(r.filters),
            }
            for r in empties[:limit]
        ],
    }


def similarity_distribution(events: Iterable[EventRow]) -> dict[str, Any]:
    results = [r for r in events if r.is_result]
    labels = [BELOW_LABEL, *(_bucket_label(i) for i in range(FLOOR_INDEX, TOP_INDEX + 1)), NULL_LABEL]
    counts = Counter(_bucket_of(r.similarity) for r in results)
    values = sorted(r.similarity for r in results if r.similarity is not None)
    total = len(results)
    return {
        "results": total,
        "buckets": [
            {"bucket": label, "count": counts[label], "share": counts[label] / total if total else 0.0}
            for label in labels
        ],
        "min": values[0] if values else None,
        "median": statistics.median(values) if values else None,
        "max": values[-1] if values else None,
    }


def per_collection(events: Iterable[EventRow]) -> list[dict[str, Any]]:
    """Per session-note collection: retrievals, result rows, empty retrievals,
    sessions, and retrievals by channel. Largest first."""
    groups: dict[str | None, list[EventRow]] = {}
    for row in events:
        groups.setdefault(row.collection, []).append(row)
    sections = [_collection_section(name, rows) for name, rows in groups.items()]
    return sorted(sections, key=lambda s: (-s["retrievals"], s["collection"] or ""))


def cross_collection(events: Iterable[EventRow], *, limit: int) -> dict[str, Any]:
    """Retrievals whose collection filter names a collection other than the note's own."""
    seen: dict[tuple[str, int], EventRow] = {}
    for row in events:
        wanted = _filters(row.filters).get("collection")
        if isinstance(wanted, str) and wanted and wanted != row.collection:
            seen.setdefault(row.retrieval_key, row)
    crossing = sorted(seen.values(), key=lambda r: r.retrieved_at, reverse=True)
    return {
        "total": len(crossing),
        "retrievals": [
            {
                "session_id": r.session_id,
                "note_collection": r.collection,
                "filter_collection": _filters(r.filters)["collection"],
                "query": r.query,
                "retrieved_at": _iso(r.retrieved_at),
            }
            for r in crossing[:limit]
        ],
    }


def _collection_section(name: str | None, rows: list[EventRow]) -> dict[str, Any]:
    retrievals = {r.retrieval_key: r.channel for r in rows}
    return {
        "collection": name,
        "retrievals": len(retrievals),
        "results": sum(1 for r in rows if r.is_result),
        "empty": len({r.retrieval_key for r in rows if not r.is_result}),
        "sessions": len({r.session_id for r in rows}),
        "channels": {channel: sum(1 for c in retrievals.values() if c == channel) for channel in CHANNELS},
    }


def _bucket_of(similarity: float | None) -> str:
    if similarity is None:
        return NULL_LABEL
    # Rounded before flooring so 0.55 (0.55000000000000004 * 20) lands in 0.55-0.60.
    index = math.floor(round(similarity * BUCKETS_PER_UNIT, 9))
    if index < FLOOR_INDEX:
        return BELOW_LABEL
    return _bucket_label(min(index, TOP_INDEX))


def _bucket_label(index: int) -> str:
    low = index / BUCKETS_PER_UNIT
    return f"{low:.2f}-{low + BUCKET_WIDTH:.2f}"


def _filters(value: Mapping[str, Any] | str | None) -> dict[str, Any]:
    """jsonb arrives as a dict from psycopg; tolerate the text form too."""
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, str) and value:
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return decoded if isinstance(decoded, dict) else {}
    return {}


def _iso(moment: datetime | None) -> str | None:
    return moment.isoformat() if moment is not None else None


# --------------------------------------------------------------------------
# the database
# --------------------------------------------------------------------------


class MissingTableError(StoreError):
    """rag.retrieval_events has not been migrated."""


def fetch_report(connection, *, since: datetime | None, limit: int) -> dict[str, Any]:
    """Run the queries in one read-only transaction and build the report.

    Raises MissingTableError when the table is absent and StoreError when the
    database refuses a query. The transaction is always rolled back."""
    import psycopg

    try:
        with connection.cursor() as cur:
            cur.execute(READ_ONLY_SQL)
            cur.execute(TABLE_EXISTS_SQL)
            found = cur.fetchone()
            if not found or found[0] is None:
                raise MissingTableError(
                    f"{RETRIEVAL_EVENTS_TABLE} does not exist; run `uv run ingest db migrate` first"
                )
            cur.execute(EVENTS_SQL, (since, since))
            events = [EventRow(*row) for row in cur.fetchall()]
            cur.execute(NEVER_RETRIEVED_SQL)
            never = [DocumentRow(*row) for row in cur.fetchall()]
    except psycopg.Error as exc:
        raise StoreError(f"retrieval report query failed: {exc}") from exc
    finally:
        connection.rollback()
    return build_report(events, never, since=since, limit=limit)
