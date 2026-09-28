"""R-C4: ``<realm>/<collection>/status.md`` — frontmatter (SC-4) and body.

R-H4's start brief injects this body cut to about 1,500 tokens, so the order is
the order of importance: the H1, one line saying what the file is, then one
compact state table per phase (plan order, the phase as an H2, ids no plan
names last under "Not in the plan"), then ``## Open items`` (contradicted,
claimed done, in progress, not started), ``## Briefs`` (only when a phase
brief has checkboxes) and ``## Plan sources``.

The body is deterministic: dates only, no timestamps, nothing that depends on
when the run happened, so a rerun with nothing new leaves the file unchanged.

**Untrusted text.** Titles and phases (from plan files), claim texts (from the
model), commit subjects and PR titles all pass :func:`~.render.escape_inline`.
A note is cited only by :func:`~.render.note_link` over the inventory's own
path and date; a note the index does not hold is named, never linked. A brief
checkbox is written as a plain ``- ticked:`` line, never a live ``- [ ]``, so
ticking it in Obsidian changes nothing the curator reads.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from .note_records import CURATOR
from .render import NoteIndex, escape_inline, note_link
from .status import (
    EVIDENCE_COMMIT,
    EVIDENCE_NOTE,
    EVIDENCE_PLAN,
    EVIDENCE_PR,
    OPEN_ORDER,
    BriefItem,
    Claim,
    CollectionStatus,
    Evidence,
    RequirementStatus,
)

STATUS_TYPE = "status"
DASH = "—"
SHORT_SHA = 7
CLAIM_CELL_CHARS = 120  # a claim is cut in the table; the open items carry it whole
MAX_LISTED = 3  # commits or PRs named in one cell before "+n more"
NO_PHASE = "Requirements"
NOT_IN_PLAN = "Not in the plan"
TABLE_HEADER = ("| Requirement | State | Latest claim | Evidence |", "| --- | --- | --- | --- |")

_WHITESPACE = re.compile(r"\s+")
_HEX = re.compile(r"^[0-9a-fA-F]+$")


def status_frontmatter(realm_folder: str, collection: str, generated_at: str, version: str) -> dict[str, str]:
    """SC-4 frontmatter; the collection slug replaces whitespace with ``-``."""
    slug = _WHITESPACE.sub("-", collection.strip())
    return {
        "id": f"curator-status-{realm_folder}-{slug}",
        "title": f"{collection} status",
        "type": STATUS_TYPE,
        "captured_by": CURATOR,
        "collection": collection,
        "generated_at": generated_at,
        "extractor_version": version,
    }


def status_body(status: CollectionStatus, notes: NoteIndex) -> str:
    lines = [
        f"# {escape_inline(status.collection)} status",
        "",
        "Written by the curator from the plan sources, session notes and git history: "
        "each requirement's state and the evidence for it.",
        "",
    ]
    if not status.requirements:
        lines.extend(["No requirements found in the plan sources or the notes.", ""])
    for heading, group in _groups(status.requirements):
        lines.extend([f"## {escape_inline(heading)}", "", *TABLE_HEADER])
        lines.extend(_row(requirement, notes) for requirement in group)
        lines.append("")
    lines.extend(["## Open items", "", *_open_items(status.requirements, notes), ""])
    if status.brief_items:
        lines.extend(["## Briefs", "", *_briefs(status.brief_items)])
    lines.extend(["## Plan sources", "", *_sources(status), ""])
    return "\n".join(lines).rstrip("\n") + "\n"


def _groups(requirements: Sequence[RequirementStatus]) -> list[tuple[str, list[RequirementStatus]]]:
    """(heading, requirements) per phase in order of first appearance; ids not in the plan last."""
    groups: dict[str, list[RequirementStatus]] = {}
    for requirement in requirements:
        if requirement.in_plan:
            groups.setdefault(requirement.phase or NO_PHASE, []).append(requirement)
    extra = [requirement for requirement in requirements if not requirement.in_plan]
    return [*groups.items(), *([(NOT_IN_PLAN, extra)] if extra else [])]


def _name(requirement: RequirementStatus) -> str:
    title = escape_inline(requirement.title) if requirement.title.strip() else ""
    return f"{escape_inline(requirement.id)} {title}".strip()


def _row(requirement: RequirementStatus, notes: NoteIndex) -> str:
    claim = requirement.latest_claim
    latest = _claim(claim, notes, in_table=True, limit=CLAIM_CELL_CHARS) if claim else DASH
    cells = (_name(requirement), requirement.state, latest, _evidence(requirement.evidence))
    return "| " + " | ".join(cells) + " |"


def _claim(claim: Claim, notes: NoteIndex, *, in_table: bool, limit: int | None = None) -> str:
    text = claim.text if limit is None or len(claim.text) <= limit else claim.text[:limit - 1] + "…"
    return f"{claim.state}: {escape_inline(text)} ({_note(claim.note_id, notes, in_table)})"


def _note(note_id: str, notes: NoteIndex, in_table: bool) -> str:
    found = notes.get(note_id)
    if found is None:
        return f"note {escape_inline(note_id)}"
    return note_link(found[0], found[1], in_table=in_table)


def _evidence(evidence: Sequence[Evidence]) -> str:
    parts: list[str] = []
    if any(e.kind == EVIDENCE_PLAN for e in evidence):
        parts.append("plan ticked")
    notes = len({e.ref for e in evidence if e.kind == EVIDENCE_NOTE})
    if notes:
        parts.append(f"{notes} note" + ("" if notes == 1 else "s"))
    parts.extend(_listed([_commit(e) for e in evidence if e.kind == EVIDENCE_COMMIT], "commits"))
    parts.extend(_listed([_pr(e) for e in evidence if e.kind == EVIDENCE_PR], "PRs"))
    return "; ".join(parts) or DASH


def _listed(names: list[str], plural: str) -> list[str]:
    if len(names) <= MAX_LISTED:
        return names
    return [*names[:MAX_LISTED], f"+{len(names) - MAX_LISTED} more {plural}"]


def _commit(evidence: Evidence) -> str:
    ref = evidence.ref
    name = f"commit {ref[:SHORT_SHA]}" if _HEX.match(ref) else f"commit {escape_inline(ref)}"
    return name if evidence.landed else f"{name} (not on main)"


def _pr(evidence: Evidence) -> str:
    ref = evidence.ref
    name = f"PR #{ref}" if ref.isdigit() else f"PR {escape_inline(ref)}"
    return name if evidence.landed else f"{name} (open)"


def _open_items(requirements: Sequence[RequirementStatus], notes: NoteIndex) -> list[str]:
    lines = []
    for state in OPEN_ORDER:
        for requirement in requirements:
            if requirement.state != state:
                continue
            line = f"- {state}: {_name(requirement)}"
            if requirement.latest_claim is not None:
                line += f" {DASH} {_claim(requirement.latest_claim, notes, in_table=False)}"
            lines.append(line)
    return lines or ["Nothing open."]


def _briefs(items: Sequence[BriefItem]) -> list[str]:
    lines: list[str] = []
    current: tuple[str, str] | None = None
    for item in items:
        if (item.brief_id, item.title) != current:
            if current is not None:
                lines.append("")
            current = (item.brief_id, item.title)
            lines.extend([f"### {escape_inline(item.brief_id)} {escape_inline(item.title)}".rstrip(), ""])
        lines.append(f"- {'ticked' if item.checked else 'not ticked'}: {escape_inline(item.text)}")
    return [*lines, ""]


def _sources(status: CollectionStatus) -> list[str]:
    lines = [f"- {escape_inline(name)}: found" for name in status.sources]
    lines.extend(f"- {escape_inline(p.given)}: {escape_inline(p.reason)}" for p in status.problems)
    return lines or ["No plan sources in the hub."]
