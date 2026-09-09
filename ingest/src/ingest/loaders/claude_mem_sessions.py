"""`sdk_sessions.json` — read for enrichment, never ingested as documents.

The file is pure session metadata (timestamps, status, worker port); there is
nothing in it to embed. It is used to attach session context to the records that
*are* ingested, joined on whichever session id that record carries:

* observations and summaries carry ``memory_session_id``
* user prompts carry ``content_session_id``

Measured on the 2026-09-09 export: ``content_session_id`` is unique across all
103 rows, but only 18 rows carry a ``memory_session_id``. Every session
referenced by an ingested record resolves (14/14 memory ids, 80/80 content ids),
so a miss means a genuinely orphaned record, not a normal case.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)

SESSIONS_FILE = "sdk_sessions.json"

# Copied onto enriched records. worker_port is deliberately excluded: it is an
# ephemeral local detail with no retrieval value.
SESSION_FIELDS = (
    "content_session_id",
    "memory_session_id",
    "project",
    "status",
    "started_at",
    "completed_at",
    "custom_title",
    "prompt_counter",
)


@dataclass(frozen=True)
class SessionIndex:
    """Two lookups over the same session rows."""

    by_memory_id: dict[str, dict[str, Any]] = field(default_factory=dict)
    by_content_id: dict[str, dict[str, Any]] = field(default_factory=dict)

    def __len__(self) -> int:
        return len(self.by_content_id)

    def for_memory_session(self, memory_session_id: Any) -> dict[str, Any] | None:
        return self._get(self.by_memory_id, memory_session_id)

    def for_content_session(self, content_session_id: Any) -> dict[str, Any] | None:
        return self._get(self.by_content_id, content_session_id)

    @staticmethod
    def _get(index: dict[str, dict[str, Any]], key: Any) -> dict[str, Any] | None:
        if key is None:
            return None
        return index.get(str(key).strip())


def build_session_index(rows: list[dict[str, Any]]) -> SessionIndex:
    """Index session rows by both id columns.

    A duplicate id keeps the first row and logs the collision, so enrichment is
    deterministic regardless of file order.
    """
    by_memory: dict[str, dict[str, Any]] = {}
    by_content: dict[str, dict[str, Any]] = {}

    for row in rows:
        summary = {key: row.get(key) for key in SESSION_FIELDS}
        _index(by_content, row.get("content_session_id"), summary, "content_session_id")
        _index(by_memory, row.get("memory_session_id"), summary, "memory_session_id")

    log.debug(
        "Session index: %d by content_session_id, %d by memory_session_id",
        len(by_content),
        len(by_memory),
    )
    return SessionIndex(by_memory_id=by_memory, by_content_id=by_content)


def _index(
    target: dict[str, dict[str, Any]], key: Any, value: dict[str, Any], label: str
) -> None:
    if key is None:
        return
    text = str(key).strip()
    if not text:
        return
    if text in target:
        log.warning("Duplicate %s in %s: %s — keeping the first", label, SESSIONS_FILE, text)
        return
    target[text] = value
