"""R-C6: each note's deterministic features, the inputs of its impact score.

Pure: the inventory, the note's cached extraction, the git facts and the
retrieval counts in, integers out. Nothing here reads a store or calls a judge.

* ``commits``: frontmatter ``commits:`` entries that name exactly one commit in
  the git facts by a sha prefix of 7 or more hex (an ambiguous or unknown prefix
  counts nothing, as the ledger's fix references). When a **main session** lists
  none, the commits of the collection's repo dated the same UTC day as the
  session instead: older notes predate the hook's ``commits:``. Subagents,
  notes and decisions get no fallback, because a worker that lists no commits
  would otherwise inherit its whole day's, and never look condensable.
* ``prs``: frontmatter ``prs:`` numbers that are pull requests in the git facts.
* ``decisions``, ``issues_found``, ``issues_fixed``, ``requirement_refs``: the
  accepted items of the note's extraction by type; an issue item claimed
  ``fixed`` is fixed, any other claim (found, workaround, wontfix) is found.
* ``citations``: later-dated notes of the collection whose body names this note
  by its id or its filename stem (the session UUID), as a whole token. A stem
  shorter than :data:`MIN_BARE_TOKEN_CHARS` (``plan``) counts only inside a
  wikilink, so an ordinary word is not a citation.
* ``retrievals``, ``used``: ``rag.retrieval_events`` counts by note id.
* ``children``: the subagents nested under a main session.
* ``body_chars``: the body's length (not weighted; the prune rule reads it).

Without git facts, ``commits`` and ``prs`` are 0: nothing can confirm them.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import PurePosixPath
from typing import Any

from .extract_plan import collection_notes
from .extract_schema import TYPE_DECISION, TYPE_ISSUE, TYPE_REQUIREMENT
from .inventory import Inventory
from .note_records import ROLE_SESSION, NoteRecord
from .store_models import Extraction, to_utc_iso

MIN_SHA_PREFIX = 7
MIN_BARE_TOKEN_CHARS = 8
CLAIM_FIXED = "fixed"
SAME_DAY_ROLES = (ROLE_SESSION,)

_SHA_PREFIX = re.compile(r"[0-9a-f]{7,40}")
_TOKEN_CHARS = "A-Za-z0-9_-"


@dataclass(frozen=True)
class NoteFeatures:
    commits: int = 0
    prs: int = 0
    decisions: int = 0
    issues_found: int = 0
    issues_fixed: int = 0
    requirement_refs: int = 0
    citations: int = 0
    retrievals: int = 0
    used: int = 0
    children: int = 0
    body_chars: int = 0

    def as_dict(self) -> dict[str, int]:
        return asdict(self)


def scored_records(inventory: Inventory) -> tuple[NoteRecord, ...]:
    """Every note of the collection in timeline order, the first file per note id."""
    seen: set[str] = set()
    chosen: list[NoteRecord] = []
    for record in collection_notes(inventory):
        if record.note_id not in seen:
            seen.add(record.note_id)
            chosen.append(record)
    return tuple(chosen)


def extract_features(inventory: Inventory, extractions_by_note_id: Mapping[str, Extraction], git: Any,
                     retrieval_counts_map: Mapping[str, tuple[int, int]]) -> dict[str, NoteFeatures]:
    """note id -> its features, for every note :func:`scored_records` yields."""
    records = scored_records(inventory)
    children: dict[str, int] = {}
    for group in inventory.sessions:
        children.setdefault(group.session.note_id, len(group.subagents))
    shas = _Shas(str(_field(c, "sha") or "").lower() for c in _field(git, "commits") or ())
    per_day = Counter(day for c in _field(git, "commits") or () if (day := utc_day(_field(c, "date"))))
    pr_numbers = {_field(p, "number") for p in _field(git, "prs") or ()}
    dated = [(when, record) for record in records if (when := instant(record.date)) is not None]

    found: dict[str, NoteFeatures] = {}
    for record in records:
        items = extractions_by_note_id[record.note_id].result if record.note_id in extractions_by_note_id else ()
        retrievals, used = retrieval_counts_map.get(record.note_id, (0, 0))
        found[record.note_id] = NoteFeatures(
            commits=_commits(record, shas, per_day) if git is not None else 0,
            prs=len({number for number in record.prs if number in pr_numbers}),
            decisions=_count(items, TYPE_DECISION),
            issues_found=sum(1 for i in items if i.get("type") == TYPE_ISSUE and i.get("claim") != CLAIM_FIXED),
            issues_fixed=sum(1 for i in items if i.get("type") == TYPE_ISSUE and i.get("claim") == CLAIM_FIXED),
            requirement_refs=_count(items, TYPE_REQUIREMENT),
            citations=_citations(record, dated),
            retrievals=retrievals,
            used=used,
            children=children.get(record.note_id, 0),
            body_chars=len(record.body),
        )
    return found


# -- commits ------------------------------------------------------------------------------------


class _Shas:
    """Full shas indexed by their first 7 hex, for prefix lookups."""

    def __init__(self, shas: Iterable[str]) -> None:
        self._by_head: dict[str, list[str]] = {}
        for sha in shas:
            if len(sha) >= MIN_SHA_PREFIX:
                self._by_head.setdefault(sha[:MIN_SHA_PREFIX], []).append(sha)

    def resolve(self, prefix: str) -> str | None:
        """The one sha ``prefix`` names, or None for no match or several."""
        named = {sha for sha in self._by_head.get(prefix[:MIN_SHA_PREFIX], ()) if sha.startswith(prefix)}
        return named.pop() if len(named) == 1 else None


def _commits(record: NoteRecord, shas: _Shas, per_day: Counter) -> int:
    if record.commits:
        prefixes = (entry.strip().lower() for entry in record.commits)
        resolved = {shas.resolve(p) for p in prefixes if _SHA_PREFIX.fullmatch(p)}
        return len(resolved - {None})
    if record.role not in SAME_DAY_ROLES:
        return 0
    day = utc_day(record.date)
    return per_day.get(day, 0) if day else 0


# -- extraction items ---------------------------------------------------------------------------


def _count(items: Iterable[Mapping[str, Any]], item_type: str) -> int:
    return sum(1 for item in items if item.get("type") == item_type)


# -- citations ----------------------------------------------------------------------------------


def _citations(record: NoteRecord, dated: list[tuple[datetime, NoteRecord]]) -> int:
    when = instant(record.date)
    if when is None:
        return 0
    patterns = [_citation_pattern(token) for token in _tokens(record)]
    return sum(1 for other_when, other in dated
               if other_when > when and other.note_id != record.note_id
               and any(p.search(other.body) for token, p in patterns if token in other.body))


def _tokens(record: NoteRecord) -> tuple[str, ...]:
    stem = PurePosixPath(record.path).stem
    return tuple(dict.fromkeys(token for token in (record.note_id, stem) if token.strip()))


def _citation_pattern(token: str) -> tuple[str, re.Pattern[str]]:
    """A whole-token match, or for a short token only a wikilink target."""
    escaped = re.escape(token)
    if len(token) >= MIN_BARE_TOKEN_CHARS:
        return token, re.compile(rf"(?<![{_TOKEN_CHARS}]){escaped}(?![{_TOKEN_CHARS}])")
    return token, re.compile(rf"\[\[(?:[^\]|#\n]*/)?{escaped}(?:\.md)?(?=[\]|#])")


# -- dates --------------------------------------------------------------------------------------


def instant(value: str | None) -> datetime | None:
    """A note or commit date as an aware UTC datetime, or None when absent or unparseable."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(to_utc_iso(value))
    except ValueError:
        return None


def utc_day(value: str | None) -> str | None:
    """``YYYY-MM-DD`` of the UTC day a date falls on."""
    moment = instant(value)
    return moment.date().isoformat() if moment is not None else None


def _field(value: Any, name: str) -> Any:
    return value.get(name) if isinstance(value, dict) else getattr(value, name, None)
