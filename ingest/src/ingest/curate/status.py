"""R-C4: each requirement of a collection's plan, matched to its evidence and given a state.

Pure: an inventory, a cache lookup, the parsed plan documents and the git facts
in; a :class:`CollectionStatus` out. No judge, no store write, no file.

**The requirements.** Every requirement heading of every plan document, in
document order (a second heading for the same id adds its checkboxes and
nothing else), then every id the notes name that no plan does, sorted, as the
"not in the plan" group (``in_plan=False``). Git never adds an id: a commit
subject is full of tokens shaped like ids (``UTF-8``), so git is only searched
for ids already known.

**Evidence** per requirement, each matched as a whole token (R-C2 never
matches R-C23):

* ``plan``: a *ticked* checkbox in the requirement's own section, a plan claim
  of done with no date. An unticked box is the plan, not evidence of work.
* ``note``: a note whose cached extraction (at the current extractor version)
  holds a ``requirement`` item or a ``status_claim`` for the id. A status claim
  with a ``state`` is also a :class:`Claim`, dated by its note
  (``NoteRecord.date``, UTC); one without a usable state is a mention only.
* ``commit``: a commit whose subject (or body, when the facts carry one) names
  the id; ``landed`` when it is on main.
* ``pr``: a pull request whose title names the id; ``landed`` when merged.

**The state rule**, in order of precedence (:func:`requirement_state`):

1. ``contradicted``: a done claim (a note claim ``done``, a ticked checkbox or
   a merged PR) and a note claim ``broken`` later than it, with no done claim
   after that break. An undated claim is the earliest of all, so an undated
   break never contradicts, and a ticked checkbox is always before a dated break.
2. ``verified``: a done claim and independent git evidence (a merged PR or a
   commit on main naming the id).
3. ``claimed done``: a done claim, no such git evidence, nothing contradicting.
4. ``in progress``: any other evidence (a mention, a commit off main, an
   unmerged PR, an in-progress, blocked or broken claim).
5. ``not started``: nothing.

Ordering is deterministic throughout: evidence by kind (plan, note, commit,
PR) then date (undated first) then ref; claims by date then note path.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from .extract_plan import collection_notes
from .extract_schema import (
    REQUIREMENT_ID_PATTERN,
    STATUS_STATES,
    TYPE_REQUIREMENT,
    TYPE_STATUS_CLAIM,
    requirement_in_body,
)
from .inventory import Inventory
from .note_records import NoteRecord
from .plan import PlanBrief, PlanCheckbox, PlanDocument, PlanRequirement, PlanSourceProblem
from .store_models import Extraction, ExtractionKey, to_utc_iso

__all__ = [
    "STATES", "OPEN_ORDER", "BriefItem", "Claim", "CollectionStatus", "Evidence", "RequirementStatus",
    "build_status", "note_index", "open_items", "requirement_state",
]

STATE_NOT_STARTED = "not started"
STATE_IN_PROGRESS = "in progress"
STATE_CLAIMED_DONE = "claimed done"
STATE_VERIFIED = "verified"
STATE_CONTRADICTED = "contradicted"
STATES = (STATE_NOT_STARTED, STATE_IN_PROGRESS, STATE_CLAIMED_DONE, STATE_VERIFIED, STATE_CONTRADICTED)
# The order open items are listed in: the most urgent first. Verified is not open.
OPEN_ORDER = (STATE_CONTRADICTED, STATE_CLAIMED_DONE, STATE_IN_PROGRESS, STATE_NOT_STARTED)

CLAIM_DONE = "done"
CLAIM_BROKEN = "broken"

EVIDENCE_PLAN = "plan"
EVIDENCE_NOTE = "note"
EVIDENCE_COMMIT = "commit"
EVIDENCE_PR = "pr"
_KIND_ORDER = {EVIDENCE_PLAN: 0, EVIDENCE_NOTE: 1, EVIDENCE_COMMIT: 2, EVIDENCE_PR: 3}

MERGED = "MERGED"
_EARLIEST = datetime.min.replace(tzinfo=UTC)
_REQUIREMENT_ID = re.compile(REQUIREMENT_ID_PATTERN)

Lookup = Callable[[Sequence[ExtractionKey]], Mapping[ExtractionKey, Extraction]]


@dataclass(frozen=True)
class Claim:
    state: str  # one of STATUS_STATES
    text: str
    note_id: str
    at: str | None  # UTC ISO, None when the note has no usable date


@dataclass(frozen=True)
class Evidence:
    kind: str  # plan | note | commit | pr
    ref: str  # plan source, note id, commit sha, PR number
    at: str | None  # UTC ISO; None for the plan and for an undated note
    detail: str | None  # checkbox text, claim text, commit subject, PR title (untrusted)
    landed: bool = False  # a commit on main, a merged PR


@dataclass(frozen=True)
class RequirementStatus:
    id: str
    title: str
    phase: str | None
    state: str
    latest_claim: Claim | None
    evidence: tuple[Evidence, ...]
    done_when: str | None
    in_plan: bool = True
    claims: tuple[Claim, ...] = ()


@dataclass(frozen=True)
class BriefItem:
    brief_id: str
    title: str
    text: str
    checked: bool


@dataclass(frozen=True)
class CollectionStatus:
    collection: str
    realm_folder: str
    folder: str
    requirements: tuple[RequirementStatus, ...]
    brief_items: tuple[BriefItem, ...]
    problems: tuple[PlanSourceProblem, ...]
    counts: dict[str, int]
    sources: tuple[str, ...] = ()  # every plan document read, as the hub names it
    notes: int = 0
    extracted: int = 0


def requirement_state(claims: Sequence[Claim], evidence: Sequence[Evidence]) -> str:
    """The state of one requirement; see the module docstring for the rule."""
    done = [c.at for c in claims if c.state == CLAIM_DONE]
    done += [e.at for e in evidence if e.kind == EVIDENCE_PLAN or (e.kind == EVIDENCE_PR and e.landed)]
    if done:
        breaks = [c.at for c in claims if c.state == CLAIM_BROKEN and c.at is not None]
        if breaks and max(map(_when, done)) < max(map(_when, breaks)):
            return STATE_CONTRADICTED
        if any(e.landed and e.kind in (EVIDENCE_COMMIT, EVIDENCE_PR) for e in evidence):
            return STATE_VERIFIED
        return STATE_CLAIMED_DONE
    return STATE_IN_PROGRESS if evidence or claims else STATE_NOT_STARTED


def _when(at: str | None) -> tuple[bool, datetime]:
    """A sort key in which undated is the earliest of all."""
    return (False, _EARLIEST) if at is None else (True, datetime.fromisoformat(to_utc_iso(at)))


# -- building -----------------------------------------------------------------------------------


@dataclass
class _Gathered:
    """One requirement's evidence while it is collected."""

    evidence: list[Evidence]
    claims: list[tuple[tuple[bool, datetime], str, int, Claim]]  # (when, note path, item index, claim)


def build_status(inventory: Inventory, lookup: Lookup, plan_docs: Iterable[PlanDocument | PlanSourceProblem],
                 git: Any, *, version: str) -> CollectionStatus:
    """The collection's status against its plan; see the module docstring."""
    loaded = tuple(plan_docs)
    documents = [doc for doc in loaded if isinstance(doc, PlanDocument)]
    problems = tuple(doc for doc in loaded if isinstance(doc, PlanSourceProblem))
    names = _source_names(inventory, documents)
    planned = _planned(documents)

    gathered: dict[str, _Gathered] = {rid: _Gathered([], []) for rid in planned}
    for rid, (_, boxes) in planned.items():
        gathered[rid].evidence.extend(
            Evidence(EVIDENCE_PLAN, names[source], None, box.text) for source, box in boxes if box.checked)
    notes, extracted = _note_evidence(inventory, lookup, version, gathered)
    _git_evidence(git, gathered)

    extra = sorted(rid for rid in gathered if rid not in planned)
    requirements = tuple(
        _status(rid, planned[rid][0] if rid in planned else None, gathered[rid]) for rid in (*planned, *extra))
    counts = {state: sum(1 for r in requirements if r.state == state) for state in STATES}
    return CollectionStatus(
        collection=inventory.profile.collection, realm_folder=inventory.folder.split("/", 1)[0],
        folder=inventory.folder, requirements=requirements, brief_items=_brief_items(documents),
        problems=problems, counts=counts, sources=tuple(names[doc.source] for doc in documents),
        notes=notes, extracted=extracted,
    )


def _source_names(inventory: Inventory, documents: Sequence[PlanDocument]) -> dict[str, str]:
    """Each document's source as the hub names it: ``given``, plus the file name for a folder."""
    names: dict[str, str] = {}
    for doc in documents:
        names[doc.source] = doc.source
        for source in inventory.profile.plan_sources:
            if doc.source == source.resolved:
                names[doc.source] = source.given
            elif source.is_dir and doc.source.startswith(source.resolved.rstrip("/") + "/"):
                names[doc.source] = f"{source.given.rstrip('/')}/{doc.source.rsplit('/', 1)[-1]}"
    return names


def _planned(documents: Sequence[PlanDocument]) -> dict[str, tuple[PlanRequirement, list[tuple[str, PlanCheckbox]]]]:
    """id -> (its first PlanRequirement, [(document source, checkbox)] across every heading for it)."""
    planned: dict[str, tuple[PlanRequirement, list[tuple[str, PlanCheckbox]]]] = {}
    for doc in documents:
        for requirement in doc.requirements:
            _, boxes = planned.setdefault(requirement.id, (requirement, []))
            boxes.extend((doc.source, box) for box in requirement.checkboxes)
    return planned


def _note_evidence(inventory: Inventory, lookup: Lookup, version: str,
                   gathered: dict[str, _Gathered]) -> tuple[int, int]:
    """Add every note's requirement mentions and claims; (notes, notes extracted)."""
    records = collection_notes(inventory)
    cached = lookup([(r.note_id, r.content_hash, version) for r in records])
    seen: set[tuple[str, str]] = set()
    for record in records:
        extraction = cached.get((record.note_id, record.content_hash, version))
        if extraction is None or (record.note_id, record.content_hash) in seen:
            continue
        seen.add((record.note_id, record.content_hash))
        at = _effective(record)
        details: dict[str, str | None] = {}  # one evidence per note and id: its first claim's text
        for index, item in enumerate(extraction.result):
            rid = _item_requirement(item)
            if rid is None:
                continue
            claim = _claim(item, record, at)
            if details.get(rid) is None:
                details[rid] = claim.text if claim is not None else None
            if claim is not None:
                gathered.setdefault(rid, _Gathered([], [])).claims.append((_when(at), record.path, index, claim))
        for rid, detail in details.items():
            gathered.setdefault(rid, _Gathered([], [])).evidence.append(
                Evidence(EVIDENCE_NOTE, record.note_id, at, detail))
    return len(records), len(seen)


def _effective(record: NoteRecord) -> str | None:
    if not record.date:
        return None
    try:
        return to_utc_iso(record.date)
    except ValueError:
        return None


def _item_requirement(item: Mapping[str, Any]) -> str | None:
    """The id a requirement or status-claim item names, when it is a well-formed id."""
    if item.get("type") not in (TYPE_REQUIREMENT, TYPE_STATUS_CLAIM):
        return None
    rid = item.get("requirement_id")
    return rid if isinstance(rid, str) and _REQUIREMENT_ID.fullmatch(rid) else None


def _claim(item: Mapping[str, Any], record: NoteRecord, at: str | None) -> Claim | None:
    if item.get("type") != TYPE_STATUS_CLAIM:
        return None
    state, text = item.get("state"), item.get("claim")
    if state not in STATUS_STATES or not isinstance(text, str) or not text.strip():
        return None
    return Claim(state=state, text=text.strip(), note_id=record.note_id, at=at)


def _git_evidence(git: Any, gathered: dict[str, _Gathered]) -> None:
    if git is None:
        return
    for commit in _field(git, "commits") or ():
        text = "\n".join(part for part in (_field(commit, "subject"), _field(commit, "body")) if isinstance(part, str))
        for rid, entry in gathered.items():
            if requirement_in_body(rid, text):
                entry.evidence.append(Evidence(EVIDENCE_COMMIT, str(_field(commit, "sha")),
                                               _utc(_field(commit, "date")), _field(commit, "subject"),
                                               landed=bool(_field(commit, "on_main"))))
    for pr in _field(git, "prs") or ():
        title = _field(pr, "title")
        if not isinstance(title, str):
            continue
        merged = _field(pr, "state") == MERGED and bool(_field(pr, "merged_at"))
        at = _utc(_field(pr, "merged_at") if merged else _field(pr, "created_at"))
        for rid, entry in gathered.items():
            if requirement_in_body(rid, title):
                entry.evidence.append(Evidence(EVIDENCE_PR, str(_field(pr, "number")), at, title, landed=merged))


def _utc(value: Any) -> str | None:
    try:
        return to_utc_iso(value) if value else None
    except ValueError:
        return None


def _status(rid: str, requirement: PlanRequirement | None, gathered: _Gathered) -> RequirementStatus:
    claims = tuple(claim for *_, claim in sorted(gathered.claims, key=lambda c: c[:3]))
    evidence = tuple(sorted(gathered.evidence, key=_evidence_key))
    return RequirementStatus(
        id=rid,
        title=requirement.title if requirement else "",
        phase=requirement.phase if requirement else None,
        state=requirement_state(claims, evidence),
        latest_claim=claims[-1] if claims else None,
        evidence=evidence,
        done_when=requirement.done_when if requirement else None,
        in_plan=requirement is not None,
        claims=claims,
    )


def _evidence_key(evidence: Evidence) -> tuple[int, tuple[bool, datetime], str, str]:
    ref = evidence.ref.zfill(12) if evidence.kind == EVIDENCE_PR and evidence.ref.isdigit() else evidence.ref
    return (_KIND_ORDER[evidence.kind], _when(evidence.at), ref, evidence.detail or "")


def _brief_items(documents: Sequence[PlanDocument]) -> tuple[BriefItem, ...]:
    return tuple(
        BriefItem(doc.brief.id, doc.brief.title, box.text, box.checked)
        for doc in documents if isinstance(doc.brief, PlanBrief)
        for box in doc.checkboxes
    )


def _field(value: Any, name: str) -> Any:
    return value.get(name) if isinstance(value, dict) else getattr(value, name, None)


# -- what other stages read ---------------------------------------------------------------------


def note_index(inventory: Inventory) -> dict[str, tuple[str, str]]:
    """note id -> (vault-relative path, UTC date) for every dated note; the first file wins."""
    index: dict[str, tuple[str, str]] = {}
    for record in collection_notes(inventory):
        at = _effective(record)
        if at is not None:
            index.setdefault(record.note_id, (record.path, at))
    return index


def open_items(status: CollectionStatus) -> tuple[str, ...]:
    """One short text per requirement not verified: ``"<id> <title>"``, then `` — <latest claim>``."""
    items = []
    for requirement in status.requirements:
        if requirement.state == STATE_VERIFIED:
            continue
        text = f"{requirement.id} {requirement.title}".strip()
        if requirement.latest_claim is not None:
            text += f" — {requirement.latest_claim.text}"
        items.append(text)
    return tuple(items)
