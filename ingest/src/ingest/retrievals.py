"""Parse a session note's ``retrievals:`` frontmatter into retrieval events.

The capture hook records every search a session made in the note it writes
(contract SC-1)::

    retrievals:
      - at: '2026-09-24T14:03:11Z'
        channel: tool                    # tool | session-start
        tool: search_context             # search_context | get_document | session-start
        query: 'redacted query text'
        filters: {collection: agentic-harness, limit: 10}
        results: ['obsidian:session-1a2b@0.8123', 'claude-mem:461@0.8540']
        chunks: ['1849/4752@0.016393', '581/783@0.016393']

Markdown first, store second: the note is the record, and ingest projects it
into ``rag.retrieval_events`` — one event per result, in rank order, or one
event with a null rank when the search found nothing.

Token grammar:

* a ``results`` token splits on its FIRST ``:`` for the source (external ids
  such as ``summary:12`` contain colons) and on its LAST ``@`` for the
  similarity. A suffix that is not a number belongs to the id, so a vault path
  holding ``@`` survives; a token without one has a null similarity.
* a ``chunks`` token is ``doc_id[/chunk_id][@rrf]``, aligned with ``results``
  by index. The list may be shorter than ``results``, or absent.

Pure: no I/O, no logging. A malformed entry is dropped with a warning naming
its index and the reason; it never fails the note that carries it.
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any, Mapping

from .config import SOURCE_OBSIDIAN
from .errors import IngestError
from .jsonutil import json_safe
from .models import RetrievalEvent

CHANNELS = frozenset({"tool", "session-start"})

# A similarity or RRF score as the hook formats it: a plain decimal.
_NUMBER = r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?"
_SIMILARITY = re.compile(rf"^{_NUMBER}$")
_CHUNK_TOKEN = re.compile(rf"^(?P<doc>\d+)(?:/(?P<chunk>\d+))?(?:@(?P<rrf>{_NUMBER}))?$")

SESSION_KEYS = ("session_id", "parent_session", "machine", "collection", "realm")


class _Malformed(ValueError):
    """One entry cannot be read; the message says why."""


def session_fields_from(
    frontmatter: Mapping[str, Any], *, collection: str | None, realm: str | None
) -> dict[str, str | None]:
    """The session columns every event of one note shares.

    ``collection`` and ``realm`` come from the loader — the note's derived
    collection and its ``_ingest.realm`` — not from raw frontmatter, so the
    events file under the same collection as the document itself.
    """
    return {
        "session_id": _text_or_none(frontmatter.get("session_id")),
        "parent_session": _text_or_none(frontmatter.get("parent_session")),
        "machine": _text_or_none(frontmatter.get("machine")),
        "collection": _text_or_none(collection),
        "realm": _text_or_none(realm),
    }


def parse_retrievals(
    frontmatter_value: Any,
    *,
    note_external_id: str,
    session_fields: Mapping[str, Any],
    note_source: str = SOURCE_OBSIDIAN,
) -> tuple[list[RetrievalEvent], list[str]]:
    """Every event in ``frontmatter_value``, and a warning per dropped entry."""
    if frontmatter_value is None:
        return [], []
    if not isinstance(frontmatter_value, list):
        return [], [f"retrievals is a {type(frontmatter_value).__name__}, not a list; ignored"]
    if not frontmatter_value:
        return [], []

    session = {key: _text_or_none(session_fields.get(key)) for key in SESSION_KEYS}
    if session["session_id"] is None:
        return [], [
            f"retrievals present but the note has no session_id; "
            f"{len(frontmatter_value)} entr{'y' if len(frontmatter_value) == 1 else 'ies'} dropped"
        ]

    events: list[RetrievalEvent] = []
    warnings: list[str] = []
    for index, raw in enumerate(frontmatter_value):
        try:
            events.extend(_parse_entry(raw, index, note_source, note_external_id, session))
        except _Malformed as exc:
            warnings.append(f"retrievals[{index}] dropped: {exc}")
    return events, warnings


# -- one entry --------------------------------------------------------------


def _parse_entry(
    raw: Any,
    index: int,
    note_source: str,
    note_external_id: str,
    session: dict[str, str | None],
) -> list[RetrievalEvent]:
    if not isinstance(raw, dict):
        raise _Malformed(f"entry is a {type(raw).__name__}, not a mapping")

    channel = raw.get("channel")
    if channel not in CHANNELS:
        raise _Malformed(f"channel {channel!r} is not one of {sorted(CHANNELS)}")
    tool = raw.get("tool")
    if not isinstance(tool, str) or not tool.strip():
        raise _Malformed("tool is missing or blank")
    query = raw.get("query")
    if query is not None and not isinstance(query, str):
        raise _Malformed(f"query is a {type(query).__name__}, not text")
    filters = _filters(raw.get("filters"))
    results = _list_of(raw.get("results"), "results")
    chunks = _list_of(raw.get("chunks"), "chunks")

    shared = dict(
        note_source=note_source,
        note_external_id=note_external_id,
        **session,
        channel=channel,
        tool=tool.strip(),
        query=query or "",
        filters=filters,
        limit=_limit(filters),
        retrieval_index=index,
        retrieved_at=_timestamp(raw.get("at")),
    )
    if not results:
        return [RetrievalEvent(**shared)]

    events = []
    for position, token in enumerate(results):
        source, external_id, similarity = _result_token(token, position)
        chunk_id, rrf = _chunk_token(chunks[position] if position < len(chunks) else None, position)
        events.append(
            RetrievalEvent(
                **shared,
                rank=position + 1,
                source=source,
                external_id=external_id,
                chunk_id=chunk_id,
                similarity=similarity,
                rrf=rrf,
            )
        )
    return events


def _result_token(token: Any, position: int) -> tuple[str, str, float | None]:
    label = f"result {position + 1}"
    if not isinstance(token, str):
        raise _Malformed(f"{label} is a {type(token).__name__}, not text")
    source, colon, rest = token.partition(":")
    if not colon or not source.strip():
        raise _Malformed(f"{label} {token!r} has no 'source:' prefix")

    external_id, similarity = rest, None
    head, at, tail = rest.rpartition("@")
    if at and _SIMILARITY.match(tail):
        external_id, similarity = head, _finite(tail, label)
    if not external_id.strip():
        raise _Malformed(f"{label} {token!r} has no external id")
    return source.strip(), external_id, similarity


def _chunk_token(token: Any, position: int) -> tuple[int | None, float | None]:
    if token is None or token == "":
        return None, None
    label = f"chunk {position + 1}"
    match = _CHUNK_TOKEN.match(str(token).strip()) if isinstance(token, (str, int)) else None
    if match is None:
        raise _Malformed(f"{label} {token!r} is not doc_id[/chunk_id][@rrf]")
    chunk = match["chunk"]
    rrf = match["rrf"]
    return (int(chunk) if chunk else None), (_finite(rrf, label) if rrf else None)


# -- fields -----------------------------------------------------------------


def _timestamp(raw: Any) -> datetime:
    """``at`` as an aware datetime. A naive time is read as UTC, which the hook writes."""
    if isinstance(raw, datetime):
        moment = raw
    elif isinstance(raw, str) and raw.strip():
        text = raw.strip()
        try:
            moment = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
        except ValueError as exc:
            raise _Malformed(f"at {raw!r} is not an ISO-8601 time") from exc
    else:
        raise _Malformed("at is missing")
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _filters(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise _Malformed(f"filters is a {type(raw).__name__}, not a mapping")
    try:
        return json_safe(raw)
    except IngestError as exc:
        # Nested past json_safe's cap: one bad entry, not a note the loader skips.
        raise _Malformed(f"filters: {exc}") from exc


def _limit(filters: dict[str, Any]) -> int | None:
    value = filters.get("limit")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _list_of(raw: Any, name: str) -> list[Any]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise _Malformed(f"{name} is a {type(raw).__name__}, not a list")
    return raw


def _finite(text: str, label: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise _Malformed(f"{label} score {text!r} is not finite")
    return value


def _text_or_none(value: Any) -> str | None:
    """A blank or absent value is null; the hook writes ``''`` for "unknown"."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None
