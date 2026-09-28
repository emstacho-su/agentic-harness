"""R-C6's condense and prune candidates, and R-C7's no-loss verifier. Nothing is applied.

Pure: the inventory, each note's cached extraction (current content, current
extractor version), the ledger's members and the week's scores in; candidates out.

**Condense** (a subagent note folded into its parent, next sprint): the note is
a subagent whose parent session is in the inventory (an orphan has nowhere to
go), has no commit and no PR, and every accepted item of its extraction is
represented elsewhere (:func:`verify_no_loss`):

* an issue item is a member of a ledger issue (ledger.md keeps it);
* a decision, status claim or open question has the same normalised summary,
  claim or question (:func:`normalise`) among the parent's items of that type;
* a requirement id, alone or on a status claim, is among the parent's
  requirement ids (its requirement items and its status claims' ids).

A subagent that fails only the representation check is not a candidate at all,
so every condense candidate has ``no_loss`` True.

**Prune** (archived next sprint): any note whose impact features
(:data:`IMPACT_FEATURES`) are all zero and which either ran in a scratchpad
(:func:`is_scratchpad`) or has a body under :data:`SHORT_BODY_CHARS`. Its
``no_loss`` is True only when its extraction has no accepted item at all.

A note is never both: condense wins. A note with no cached extraction or no
score is never a candidate: its features are not known yet. Curator notes and
hubs never reach the inventory, so they are never candidates. Reasons are fixed
phrases and counts, never note text.
"""

from __future__ import annotations

import re
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .extract_schema import (
    FIELD_REQUIREMENT_ID,
    TYPE_DECISION,
    TYPE_ISSUE,
    TYPE_OPEN_QUESTION,
    TYPE_REQUIREMENT,
    TYPE_STATUS_CLAIM,
)
from .inventory import Inventory
from .note_records import NoteRecord
from .scores import WEIGHTS, CollectionScores
from .score_features import scored_records
from .store_models import Extraction

ACTION_CONDENSE = "condense"
ACTION_PRUNE = "prune"

SHORT_BODY_CHARS = 400
# Matched against the cwd lowercased with every backslash turned into a slash.
SCRATCHPAD_MARKERS = ("appdata/local/temp/claude", "/.claude/projects/")
IMPACT_FEATURES = tuple(WEIGHTS)  # commits, prs, decisions, issues, requirement refs, citations, usage, children
NO_ACTIVITY_FEATURES = ("commits", "prs")

# The text field each representable item type is compared on.
TEXT_FIELD = {TYPE_DECISION: "summary", TYPE_STATUS_CLAIM: "claim", TYPE_OPEN_QUESTION: "question"}

REASON_NO_COMMIT = "no commit or PR"
REASON_REPRESENTED = "every item represented in the parent or ledger"
REASON_QUIET = "no commit, PR, decision, issue, citation or retrieval"
REASON_SCRATCHPAD = "scratchpad cwd"

ItemKey = tuple[str, str, str, int]  # IssueMember.item_key

_PUNCTUATION = re.compile(r"[^\w\s]")
_WHITESPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class Candidate:
    note_id: str
    action: str  # condense | prune
    collection: str
    reasons: tuple[str, ...]
    no_loss: bool
    path: str  # vault-relative, from the inventory


def normalise(text: Any) -> str:
    """Lowercase, punctuation removed, whitespace collapsed: how two items are compared."""
    if not isinstance(text, str):
        return ""
    return _WHITESPACE.sub(" ", _PUNCTUATION.sub("", text.lower())).strip()


def is_scratchpad(cwd: str | None) -> bool:
    """True for a Claude temp or projects folder, whichever slashes and case it is written in."""
    if not cwd:
        return False
    folded = cwd.replace("\\", "/").lower()
    return any(marker in folded for marker in SCRATCHPAD_MARKERS)


def verify_no_loss(candidate_items: Sequence[Mapping[str, Any]], remaining_items: Iterable[Mapping[str, Any]],
                   ledgered: Collection[int] = frozenset()) -> bool:
    """True when every candidate item survives in ``remaining_items`` or the ledger.

    ``ledgered`` holds the indices of ``candidate_items`` that are ledger issue
    members; an issue item survives only that way. An item of an unknown type
    never survives.
    """
    remaining = list(remaining_items)
    texts = {item_type: {normalise(item.get(field)) for item in remaining if item.get("type") == item_type}
             for item_type, field in TEXT_FIELD.items()}
    requirement_ids = {item.get(FIELD_REQUIREMENT_ID) for item in remaining
                       if item.get("type") in (TYPE_REQUIREMENT, TYPE_STATUS_CLAIM)} - {None}
    return all(_survives(index, item, texts, requirement_ids, ledgered)
               for index, item in enumerate(candidate_items))


def _survives(index: int, item: Mapping[str, Any], texts: Mapping[str, set[str]], requirement_ids: set[Any],
              ledgered: Collection[int]) -> bool:
    item_type = item.get("type")
    if item_type == TYPE_ISSUE:
        return index in ledgered
    if item_type == TYPE_REQUIREMENT:
        return item.get(FIELD_REQUIREMENT_ID) in requirement_ids
    if item_type not in TEXT_FIELD:
        return False
    text = normalise(item.get(TEXT_FIELD[item_type]))
    if not text or text not in texts[item_type]:
        return False
    named = item.get(FIELD_REQUIREMENT_ID)
    return named is None or named in requirement_ids


def propose(inventory: Inventory, extractions_by_note_id: Mapping[str, Extraction],
            members_by_item_key: Mapping[ItemKey, str], scores: CollectionScores) -> tuple[Candidate, ...]:
    """Every condense and prune candidate of the collection, by note id."""
    parents = {sub.note_id: group.session for group in inventory.sessions for sub in group.subagents}
    collection = inventory.profile.collection
    found: list[Candidate] = []
    for record in scored_records(inventory):
        extraction = extractions_by_note_id.get(record.note_id)
        score = scores.notes.get(record.note_id)
        if extraction is None or score is None:
            continue
        features = score.features
        parent = parents.get(record.note_id)
        condense = None if parent is None else _condense(
            record, parent, extraction, extractions_by_note_id.get(parent.note_id), members_by_item_key, features)
        candidate = condense or _prune(record, extraction, features)
        if candidate is not None:
            found.append(Candidate(note_id=record.note_id, collection=collection, path=record.path, **candidate))
    return tuple(sorted(found, key=lambda c: c.note_id))


def _condense(record: NoteRecord, parent: NoteRecord, extraction: Extraction, parent_extraction: Extraction | None,
              members: Mapping[ItemKey, str], features: Mapping[str, float]) -> dict[str, Any] | None:
    if any(features.get(name, 0) for name in NO_ACTIVITY_FEATURES):
        return None
    items = extraction.result
    key = (extraction.note_id, extraction.content_hash, extraction.extractor_version)
    ledgered = {index for index in range(len(items)) if (*key, index) in members}
    remaining = parent_extraction.result if parent_extraction is not None else ()
    if not verify_no_loss(items, remaining, ledgered):
        return None
    reasons = (f"subagent of {parent.note_id}", REASON_NO_COMMIT, f"{REASON_REPRESENTED} ({len(items)} items)")
    return {"action": ACTION_CONDENSE, "reasons": reasons, "no_loss": True}


def _prune(record: NoteRecord, extraction: Extraction, features: Mapping[str, float]) -> dict[str, Any] | None:
    if any(features.get(name, 0) for name in IMPACT_FEATURES):
        return None
    body_chars = int(features.get("body_chars", len(record.body)))
    scratchpad = is_scratchpad(record.cwd)
    if not scratchpad and body_chars >= SHORT_BODY_CHARS:
        return None
    reasons = [REASON_QUIET]
    if scratchpad:
        reasons.append(REASON_SCRATCHPAD)
    if body_chars < SHORT_BODY_CHARS:
        reasons.append(f"body {body_chars} chars")
    items = len(extraction.result)
    if items:
        reasons.append(f"{items} extracted items")
    return {"action": ACTION_PRUNE, "reasons": tuple(reasons), "no_loss": items == 0}
