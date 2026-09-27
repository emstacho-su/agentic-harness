"""R-C3: the ledger's inputs and its stored facts — issue items in, events out.

**Items.** Every ``type: issue`` item of every cached extraction at the current
extractor version, for the notes of one collection. Its key is
``f"{note_id}|{content_hash}|{version}|{item_index}"``; its effective date is
its note's date (``started_at``, else ``date``). Items are processed in
``(effective date, note path, item_index)`` order, so a run is deterministic.
A note with no extraction yet is reported ("not extracted yet"), never an
error; an issue item whose note has no usable date cannot be placed.

**Events** (append-only; a rerun re-derives the same ones and the store's
unique key inserts nothing):

* per member item, by claim: found -> ``found``/open; fixed ->
  ``claim-fixed``/claimed-fixed; workaround and wontfix -> annotations. Cause:
  the note, at its date, with the item's evidence (cut to
  :data:`EVIDENCE_LIMIT`).
* per issue, per ``fix:`` commit after the issue was first seen whose files
  match one of the issue's files: ``fix-commit``/claimed-fixed, at the commit
  date, with its subject.
* per claimed-fixed item whose ``fix_ref`` resolves: ``#<n>`` or ``PR <n>``
  naming a merged PR -> ``merged-pr``/verified at the merge date; else a sha
  prefix (7 or more hex) naming exactly one commit on main -> ``fix-commit``/
  verified. An unresolvable ref is counted, not stored.

**File matching.** Both sides become posix paths without ``./`` or a leading
``/``; they match when one ends with the other on a path-segment boundary, so
``store.py`` matches ``ingest/store.py`` but never ``restore.py``.

**One key, two claims.** The store's unique key is ``(issue, kind, cause type,
cause ref)`` without the state, so a commit matched by its files (claimed-fixed)
and named by a note's ``fix_ref`` (verified) is one key. Within a run the
verified one wins; if the claimed-fixed one was stored by an earlier run, the
verified one cannot be added and the run reports it as a conflict.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .extract_plan import collection_notes
from .extract_schema import TYPE_ISSUE
from .inventory import Inventory
from .note_records import NoteRecord
from .store_models import Extraction, ExtractionKey, Issue, IssueEvent, to_utc_iso

EVIDENCE_LIMIT = 300
MIN_SHA_PREFIX = 7
FIX_COMMIT_TYPE = "fix"
MERGED = "MERGED"

NOT_EXTRACTED = "not extracted yet — run curate extract"
NO_DATE = "note has no usable date"
MALFORMED_ITEM = "malformed issue item"

# claim -> (event kind, to_state)
CLAIM_EVENTS: dict[str, tuple[str, str | None]] = {
    "found": ("found", "open"),
    "fixed": ("claim-fixed", "claimed-fixed"),
    "workaround": ("claim-workaround", None),
    "wontfix": ("claim-wontfix", None),
}
# Which of two events with the same unique key is kept.
_STATE_RANK = {"verified": 3, "claimed-fixed": 2, "regressed": 1, "open": 1, None: 0}

_SHA = re.compile(r"(?<![0-9A-Za-z])[0-9a-fA-F]{7,40}(?![0-9A-Za-z])")
_PR = re.compile(r"(?:#|\bPR\s*#?\s*)(\d+)\b", re.IGNORECASE)

Lookup = Callable[[Sequence[ExtractionKey]], Mapping[ExtractionKey, Extraction]]


@dataclass(frozen=True)
class LedgerItem:
    """One extracted issue item, placed in time."""

    note_id: str
    content_hash: str
    version: str
    item_index: int
    note_path: str
    effective_at: str  # UTC ISO
    kind: str | None
    summary: str
    files: tuple[str, ...]
    claim: str
    evidence: str
    fix_ref: str | None

    @property
    def item_key(self) -> str:
        return f"{self.note_id}|{self.content_hash}|{self.version}|{self.item_index}"

    @property
    def member_key(self) -> tuple[str, str, str, int]:
        return (self.note_id, self.content_hash, self.version, self.item_index)


@dataclass(frozen=True)
class Problem:
    path: str
    reason: str


@dataclass(frozen=True)
class CollectedItems:
    items: tuple[LedgerItem, ...]
    notes: int
    extracted: int
    not_extracted: tuple[str, ...]  # note paths
    unplaced: tuple[Problem, ...]
    note_index: dict[str, tuple[str, str]]  # note id -> (path, effective_at)


def collect_items(inventory: Inventory, lookup: Lookup, version: str) -> CollectedItems:
    """Every issue item of the collection's cached extractions, in processing order."""
    records = collection_notes(inventory)
    cached = lookup([(r.note_id, r.content_hash, version) for r in records])
    items: list[tuple[datetime, LedgerItem]] = []
    not_extracted: list[str] = []
    unplaced: list[Problem] = []
    note_index: dict[str, tuple[str, str]] = {}
    seen: set[tuple[str, str]] = set()
    extracted = 0
    for record in records:
        when = _effective(record)
        if when is not None:
            note_index.setdefault(record.note_id, (record.path, when))
        extraction = cached.get((record.note_id, record.content_hash, version))
        if extraction is None:
            not_extracted.append(record.path)
            continue
        if (record.note_id, record.content_hash) in seen:
            continue  # a second file with the same id and content: one note
        seen.add((record.note_id, record.content_hash))
        extracted += 1
        issue_items = [(i, item) for i, item in enumerate(extraction.result) if item.get("type") == TYPE_ISSUE]
        if issue_items and when is None:
            unplaced.extend(Problem(record.path, NO_DATE) for _ in issue_items)
            continue
        for index, raw in issue_items:
            item = _item(record, version, index, raw, when)
            if item is None:
                unplaced.append(Problem(record.path, MALFORMED_ITEM))
            else:
                items.append((datetime.fromisoformat(item.effective_at), item))
    ordered = tuple(item for _, item in sorted(items, key=lambda p: (p[0], p[1].note_path, p[1].item_index)))
    return CollectedItems(ordered, len(records), extracted, tuple(not_extracted), tuple(unplaced), note_index)


def _effective(record: NoteRecord) -> str | None:
    if not record.date:
        return None
    try:
        return to_utc_iso(record.date)
    except ValueError:
        return None


def _item(record: NoteRecord, version: str, index: int, raw: Mapping[str, Any], when: str) -> LedgerItem | None:
    summary, claim, evidence = raw.get("summary"), raw.get("claim"), raw.get("evidence")
    files, fix_ref, kind = raw.get("files") or [], raw.get("fix_ref"), raw.get("kind")
    if not (isinstance(summary, str) and summary.strip() and claim in CLAIM_EVENTS and isinstance(evidence, str)):
        return None
    if not isinstance(files, list) or not all(isinstance(f, str) for f in files):
        return None
    return LedgerItem(
        note_id=record.note_id, content_hash=record.content_hash, version=version, item_index=index,
        note_path=record.path, effective_at=when, kind=kind if isinstance(kind, str) else None,
        summary=summary.strip(), files=tuple(files), claim=claim, evidence=evidence,
        fix_ref=fix_ref if isinstance(fix_ref, str) and fix_ref.strip() else None,
    )


# -- file matching ------------------------------------------------------------------------------


def normalise_path(path: str) -> str:
    """Posix, no ``./`` or leading ``/``, no doubled separators."""
    segments = [part for part in path.strip().replace("\\", "/").split("/") if part not in ("", ".")]
    return "/".join(segments)


def paths_match(left: str, right: str) -> bool:
    """True when one path ends with the other on a segment boundary."""
    a, b = normalise_path(left).split("/"), normalise_path(right).split("/")
    if a == [""] or b == [""]:
        return False
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    return longer[len(longer) - len(shorter):] == shorter


def files_match(issue_files: Iterable[str], commit_files: Iterable[str]) -> bool:
    wanted = [f for f in issue_files if normalise_path(f)]
    return any(paths_match(mine, theirs) for mine in wanted for theirs in commit_files)


def issue_files(issue: Issue, items: Iterable[LedgerItem]) -> tuple[str, ...]:
    """The issue's files, then its members' files, one spelling per normalised path."""
    seen: set[str] = set()
    ordered: list[str] = []
    for name in (*issue.files, *(f for item in items for f in item.files)):
        key = normalise_path(name)
        if key and key not in seen:
            seen.add(key)
            ordered.append(name)
    return tuple(ordered)


# -- events -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class DerivedEvents:
    events: tuple[IssueEvent, ...]
    unresolved_refs: int


def derive_events(issues: Sequence[Issue], members: Mapping[str, Sequence[LedgerItem]], git: Any) -> DerivedEvents:
    """Every event the ledger's inputs imply, one per unique key (see the module docstring)."""
    commits = tuple(_field(git, "commits") or ())
    prs = tuple(_field(git, "prs") or ())
    derived: list[IssueEvent] = []
    unresolved = 0
    for issue in issues:
        items = members.get(issue.issue_id, ())
        derived.extend(note_event(issue.issue_id, item) for item in items)
        since = min((issue.first_seen_at, *(item.effective_at for item in items)), key=datetime.fromisoformat)
        derived.extend(commit_events(issue.issue_id, issue_files(issue, items), since, commits))
        for item in items:
            if item.claim != "fixed" or item.fix_ref is None:
                continue
            event = fix_ref_event(issue.issue_id, item.fix_ref, commits, prs)
            if event is None:
                unresolved += 1
            else:
                derived.append(event)
    return DerivedEvents(_one_per_key(derived), unresolved)


def note_event(issue_id: str, item: LedgerItem) -> IssueEvent:
    kind, to_state = CLAIM_EVENTS[item.claim]
    return IssueEvent(issue_id=issue_id, to_state=to_state, event_kind=kind, effective_at=item.effective_at,
                      cause_type="note", cause_ref=item.note_id, evidence=_cut(item.evidence))


def commit_events(issue_id: str, files: Sequence[str], since: str, commits: Iterable[Any]) -> list[IssueEvent]:
    after = datetime.fromisoformat(to_utc_iso(since))
    found = []
    for commit in commits:
        changed = _field(commit, "files") or ()
        if _field(commit, "type") != FIX_COMMIT_TYPE or not changed:
            continue
        when = _field(commit, "date")
        if datetime.fromisoformat(to_utc_iso(when)) <= after or not files_match(files, changed):
            continue
        found.append(IssueEvent(issue_id=issue_id, to_state="claimed-fixed", event_kind="fix-commit",
                                effective_at=when, cause_type="commit", cause_ref=_field(commit, "sha"),
                                evidence=_cut(_field(commit, "subject"))))
    return found


def fix_ref_event(issue_id: str, fix_ref: str, commits: Sequence[Any], prs: Sequence[Any]) -> IssueEvent | None:
    """The verified event a fix reference proves, or None when it names nothing merged."""
    for match in _PR.finditer(fix_ref):
        number = int(match.group(1))
        pr = next((p for p in prs if _field(p, "number") == number), None)
        if pr is not None and _field(pr, "state") == MERGED and _field(pr, "merged_at"):
            return IssueEvent(issue_id=issue_id, to_state="verified", event_kind="merged-pr",
                              effective_at=_field(pr, "merged_at"), cause_type="pr", cause_ref=str(number),
                              evidence=_cut(_field(pr, "title")))
    for match in _SHA.finditer(fix_ref):
        prefix = match.group(0).lower()
        named = [c for c in commits if str(_field(c, "sha") or "").lower().startswith(prefix)]
        if len(named) == 1 and _field(named[0], "on_main"):
            commit = named[0]
            return IssueEvent(issue_id=issue_id, to_state="verified", event_kind="fix-commit",
                              effective_at=_field(commit, "date"), cause_type="commit",
                              cause_ref=_field(commit, "sha"), evidence=_cut(_field(commit, "subject")))
    return None


def _one_per_key(events: Iterable[IssueEvent]) -> tuple[IssueEvent, ...]:
    """The strongest claim per unique key; on a tie, the earliest, then the first derived."""
    chosen: dict[tuple[str, str, str, str], IssueEvent] = {}
    for event in events:
        held = chosen.get(event.unique_key)
        if held is None or _stronger(event, held):
            chosen[event.unique_key] = event
    return tuple(chosen.values())


def _stronger(new: IssueEvent, held: IssueEvent) -> bool:
    if _STATE_RANK[new.to_state] != _STATE_RANK[held.to_state]:
        return _STATE_RANK[new.to_state] > _STATE_RANK[held.to_state]
    return datetime.fromisoformat(new.effective_at) < datetime.fromisoformat(held.effective_at)


def _cut(text: str | None) -> str | None:
    if text is None:
        return None
    return text if len(text) <= EVIDENCE_LIMIT else text[:EVIDENCE_LIMIT - 1] + "…"


def _field(value: Any, name: str) -> Any:
    return value.get(name) if isinstance(value, dict) else getattr(value, name, None)
