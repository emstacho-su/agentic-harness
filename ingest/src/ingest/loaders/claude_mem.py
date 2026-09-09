"""claude-mem export loader.

Reads the JSON exported from the retired claude-mem SQLite store and emits
documents for the same pipeline the vault uses.

Three record types, one ``source='claude-mem'``, with distinct ``external_id``
prefixes so they cannot collide under ``UNIQUE (source, external_id)``:

| File | external_id | body |
| --- | --- | --- |
| ``observations.json`` (461) | ``<id>`` | ``narrative`` (legacy ``text`` fallback) |
| ``session_summaries.json`` (141) | ``summary:<id>`` | six prose columns as ``## `` sections |
| ``user_prompts.json`` (725) | ``prompt:<id>`` | ``prompt_text``, no title |

``sdk_sessions.json`` is **not** ingested — it is pure session metadata. It is
read to enrich the other three via the session-id join. See
:mod:`.claude_mem_sessions`.

Skips, all counted and reported:

* 18 observations (ids 68-164, 2026-05-07 06:09-08:27) with no narrative, no
  text and no title — failed writes from that day's data-directory migration.
* 4 session summaries whose prose fields are all blank.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from ..config import DEFAULT_AGENT, SOURCE_CLAUDE_MEM
from ..errors import SourceError
from ..jsonutil import json_safe, parse_json_text_column
from ..models import SourceDocument
from .base import LoadedSource, SkippedRecord
from .claude_mem_sessions import SESSIONS_FILE, SessionIndex, build_session_index

log = logging.getLogger(__name__)

OBSERVATIONS_FILE = "observations.json"
SUMMARIES_FILE = "session_summaries.json"
PROMPTS_FILE = "user_prompts.json"

SUMMARY_PREFIX = "summary:"
PROMPT_PREFIX = "prompt:"

# claude-mem stores these four as JSON *inside* a TEXT column, not as arrays.
JSON_TEXT_COLUMNS = ("facts", "concepts", "files_read", "files_modified")

# Ordered so the rendered summary reads as a narrative.
SUMMARY_SECTIONS = (
    ("request", "Request"),
    ("investigated", "Investigated"),
    ("learned", "Learned"),
    ("completed", "Completed"),
    ("next_steps", "Next steps"),
    ("notes", "Notes"),
)

EMPTY_OBSERVATION = "no narrative, text or title (2026-05-07 migration failure)"
EMPTY_SUMMARY = "all summary fields blank"
EMPTY_PROMPT = "blank prompt_text"


def load_claude_mem(
    export_dir: str | Path,
    *,
    include_summaries: bool = True,
    include_prompts: bool = True,
) -> LoadedSource:
    """Load every ingestable record from a claude-mem export directory."""
    root = Path(export_dir).expanduser()
    if not root.exists():
        raise SourceError(f"claude-mem export directory does not exist: {root}")
    if not root.is_dir():
        raise SourceError(f"claude-mem export path is not a directory: {root}")

    sessions = _load_session_index(root / SESSIONS_FILE)

    result = _load_observations(root / OBSERVATIONS_FILE, sessions)
    if include_summaries:
        result = result.merge(_load_summaries(root / SUMMARIES_FILE, sessions))
    if include_prompts:
        result = result.merge(_load_prompts(root / PROMPTS_FILE, sessions))
    return result


def _load_session_index(path: Path) -> SessionIndex:
    """Missing session metadata degrades enrichment; it never fails the run."""
    if not path.exists():
        log.warning("%s is absent — documents will carry no session metadata", path.name)
        return SessionIndex()
    return build_session_index(_read_rows(path))


# --------------------------------------------------------------------------
# observations
# --------------------------------------------------------------------------


def _load_observations(path: Path, sessions: SessionIndex) -> LoadedSource:
    rows = _read_rows(path)
    documents: list[SourceDocument] = []
    skipped: list[SkippedRecord] = []

    for row in rows:
        external_id = _require_id(row, path)
        body = _observation_body(row)
        if not body:
            skipped.append(SkippedRecord(external_id, EMPTY_OBSERVATION))
            continue
        try:
            documents.append(_observation_document(row, external_id, body, sessions))
        except SourceError as exc:
            log.warning("Skipping observation %s: %s", external_id, exc)
            skipped.append(SkippedRecord(external_id, str(exc)))

    return LoadedSource(tuple(documents), tuple(skipped), (_note(path, rows, documents, skipped),))


def _observation_body(row: dict[str, Any]) -> str:
    """``narrative`` is the embed source. ``text`` is legacy and NULL on modern rows."""
    for field in ("narrative", "text"):
        value = row.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _observation_document(
    row: dict[str, Any], external_id: str, body: str, sessions: SessionIndex
) -> SourceDocument:
    memory_session_id = _clean_str(row.get("memory_session_id"))
    metadata: dict[str, Any] = {
        "record_type": "observation",
        "type": _clean_str(row.get("type")),
        "project": _clean_str(row.get("project")),
        "memory_session_id": memory_session_id,
        "subtitle": _clean_str(row.get("subtitle")),
        "prompt_number": row.get("prompt_number"),
        "discovery_tokens": row.get("discovery_tokens"),
        "created_at": _clean_str(row.get("created_at")),
        "created_at_epoch": row.get("created_at_epoch"),
        # The exporter's own 16-char hash. Kept for provenance; it is NOT the
        # value written to rag.documents.content_hash (that is our sha256).
        "source_content_hash": _clean_str(row.get("content_hash")),
    }
    for column in JSON_TEXT_COLUMNS:
        metadata[column] = parse_json_text_column(
            row.get(column), field=column, external_id=external_id, default=[]
        )
    _attach_session(metadata, sessions.for_memory_session(memory_session_id))

    title = _clean_str(row.get("title")) or f"Observation {external_id}"
    return _document(external_id, body, title, metadata)


# --------------------------------------------------------------------------
# session summaries
# --------------------------------------------------------------------------


def _load_summaries(path: Path, sessions: SessionIndex) -> LoadedSource:
    rows = _read_rows(path)
    documents: list[SourceDocument] = []
    skipped: list[SkippedRecord] = []

    for row in rows:
        external_id = f"{SUMMARY_PREFIX}{_require_id(row, path)}"
        body = _summary_body(row)
        if not body:
            skipped.append(SkippedRecord(external_id, EMPTY_SUMMARY))
            continue
        try:
            documents.append(_summary_document(row, external_id, body, sessions))
        except SourceError as exc:
            log.warning("Skipping summary %s: %s", external_id, exc)
            skipped.append(SkippedRecord(external_id, str(exc)))

    return LoadedSource(tuple(documents), tuple(skipped), (_note(path, rows, documents, skipped),))


def _summary_body(row: dict[str, Any]) -> str:
    """Render the six prose columns as markdown so the chunker sees structure."""
    sections = []
    for field, heading in SUMMARY_SECTIONS:
        value = _clean_str(row.get(field))
        if value:
            sections.append(f"## {heading}\n\n{value}")
    return "\n\n".join(sections)


def _summary_document(
    row: dict[str, Any], external_id: str, body: str, sessions: SessionIndex
) -> SourceDocument:
    memory_session_id = _clean_str(row.get("memory_session_id"))
    metadata: dict[str, Any] = {
        "record_type": "session_summary",
        "project": _clean_str(row.get("project")),
        "memory_session_id": memory_session_id,
        "prompt_number": row.get("prompt_number"),
        "discovery_tokens": row.get("discovery_tokens"),
        "created_at": _clean_str(row.get("created_at")),
        "created_at_epoch": row.get("created_at_epoch"),
    }
    # Present in the schema but NULL on all 141 exported rows. Parsed anyway so
    # a future export that populates them needs no code change.
    for column in ("files_read", "files_edited"):
        metadata[column] = parse_json_text_column(
            row.get(column), field=column, external_id=external_id, default=[]
        )
    _attach_session(metadata, sessions.for_memory_session(memory_session_id))

    project = metadata["project"] or "unknown"
    request = _clean_str(row.get("request"))
    title = _truncate(request, 120) if request else f"Session summary {external_id}"
    return _document(external_id, body, f"[{project}] {title}", metadata)


# --------------------------------------------------------------------------
# user prompts
# --------------------------------------------------------------------------


def _load_prompts(path: Path, sessions: SessionIndex) -> LoadedSource:
    rows = _read_rows(path)
    documents: list[SourceDocument] = []
    skipped: list[SkippedRecord] = []

    for row in rows:
        external_id = f"{PROMPT_PREFIX}{_require_id(row, path)}"
        body = _clean_str(row.get("prompt_text"))
        if not body:
            skipped.append(SkippedRecord(external_id, EMPTY_PROMPT))
            continue
        documents.append(_prompt_document(row, external_id, body, sessions))

    return LoadedSource(tuple(documents), tuple(skipped), (_note(path, rows, documents, skipped),))


def _prompt_document(
    row: dict[str, Any], external_id: str, body: str, sessions: SessionIndex
) -> SourceDocument:
    content_session_id = _clean_str(row.get("content_session_id"))
    metadata: dict[str, Any] = {
        "record_type": "user_prompt",
        "content_session_id": content_session_id,
        "prompt_number": row.get("prompt_number"),
        "created_at": _clean_str(row.get("created_at")),
        "created_at_epoch": row.get("created_at_epoch"),
    }
    session = sessions.for_content_session(content_session_id)
    _attach_session(metadata, session)
    # Prompts carry no project column of their own; the session supplies it.
    if session and _clean_str(session.get("project")):
        metadata["project"] = _clean_str(session.get("project"))

    # Deliberately no title: a raw prompt has none, and inventing one would put
    # fabricated text into the breadcrumb of every chunk.
    return _document(external_id, body, None, metadata)


# --------------------------------------------------------------------------
# shared helpers
# --------------------------------------------------------------------------


def _document(
    external_id: str, body: str, title: str | None, metadata: dict[str, Any]
) -> SourceDocument:
    # claude-mem's `project` is this corpus's notion of a collection. Promote it
    # to a first-class column so rag.search(filter_collection => ...) can use it;
    # it stays in metadata as well for provenance.
    collection = metadata.get("project") or None
    return SourceDocument(
        source=SOURCE_CLAUDE_MEM,
        external_id=external_id,
        body=body,
        title=title,
        agent=DEFAULT_AGENT,
        collection=collection,
        metadata=json_safe(metadata),
    )


def _attach_session(metadata: dict[str, Any], session: dict[str, Any] | None) -> None:
    """Nest session metadata under ``_session`` so it cannot shadow a real column."""
    if session:
        metadata["_session"] = dict(session)


def _note(path: Path, rows: list, documents: list, skipped: list) -> str:
    return (
        f"{path.name}: {len(rows)} rows, {len(documents)} ingested, {len(skipped)} skipped"
    )


def _read_rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise SourceError(f"Expected export file is missing: {path}")
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise SourceError(f"Could not read {path}: {exc}") from exc

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SourceError(f"{path.name} is not valid JSON: {exc}") from exc

    if not isinstance(parsed, list):
        raise SourceError(
            f"{path.name} should be a JSON array of rows, got {type(parsed).__name__}"
        )
    for index, row in enumerate(parsed):
        if not isinstance(row, dict):
            raise SourceError(
                f"{path.name} row {index} is {type(row).__name__}, expected object"
            )
    return parsed


def _require_id(row: dict[str, Any], path: Path) -> str:
    value = row.get("id")
    if value is None or (isinstance(value, str) and not value.strip()):
        raise SourceError(f"{path.name}: a row has no id")
    return str(value)


def _clean_str(value: Any) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        return str(value)
    return value.strip()


def _truncate(text: str, limit: int) -> str:
    collapsed = " ".join(text.split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1].rstrip() + "…"
