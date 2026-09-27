"""R-C6/R-C7: ``<realm>/curation/<YYYY-MM-DD>.md`` — frontmatter (SC-4) and body.

The body is deterministic: candidates sorted by collection then note id, rounds
by day, collections by name, dates only, and nothing that depends on when the
run happened. That, and the writer ignoring ``generated_at``, is what lets a
rerun with nothing new leave the file byte for byte.

**Candidate lines** are the one thing read back (``tally.parse_report_checkboxes``),
so their format is exact::

    - [ ] condense `<note_id>` [[<path>|<date>]] — <reason>; <reason> (no-loss: yes)

The box is ticked when the latest recorded decision for that proposal accepted
it, so a rewrite of the day's report keeps Stack's ticks. The note id sits in a
code span, where nothing is markup; a backtick or line break in it would end the
span or the line, so those are removed and the candidate says its id was altered
(such a line cannot match its stored proposal, so ticking it records nothing).

**Untrusted text**: reasons carry note ids, and collection names and paths come
from the vault, so each passes :func:`~.render.escape_inline`; links are only
built by :func:`~.render.note_link` from the inventory's own paths.
"""

from __future__ import annotations

import math
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass

from .note_records import CURATOR
from .proposals import ACTION_CONDENSE, ACTION_PRUNE, Candidate
from .render import DASH, NoteIndex, escape_inline, note_link
from .store_models import NoteScore
from .tally import ACTIONS, PROMOTION_ACCEPTANCE, PROMOTION_RUNS, Mode, Round, open_round
from .writer import REPORT_TYPE

TOP_BY_IMPACT = 5
NO_CANDIDATES = "No candidates."
ALTERED_ID = "note id altered for display"
INSTRUCTIONS = (
    "Tick a box to accept the proposal; the next run records it. An unticked box on a report "
    "older than the run counts as a rejection. Nothing is applied yet: the tally below decides "
    "when an action type may run on its own (R-C7)."
)
_ID_UNSAFE = str.maketrans("", "", "`\n\r")
_SECTION_TITLES = {ACTION_CONDENSE: "## Condense candidates", ACTION_PRUNE: "## Prune candidates"}


@dataclass(frozen=True)
class ScoreSummary:
    collection: str
    scored: int
    mean_impact: float  # rounded to 2 decimals
    importance_asked: int  # notes whose impact includes the judge's importance
    top: tuple[tuple[str, float], ...]  # (note id, impact), highest first


def summarise_scores(collection: str, notes: Mapping[str, NoteScore], top: int = TOP_BY_IMPACT) -> ScoreSummary:
    scored = list(notes.values())
    mean = sum(s.impact for s in scored) / len(scored) if scored else 0.0
    ranked = sorted(scored, key=lambda s: (-s.impact, s.note_id))[:top]
    return ScoreSummary(
        collection=collection, scored=len(scored), mean_impact=round(mean, 2),
        importance_asked=sum(1 for s in scored if s.importance is not None),
        top=tuple((s.note_id, s.impact) for s in ranked),
    )


def report_frontmatter(realm_folder: str, day: str, generated_at: str, scorer_version: str) -> dict[str, str]:
    """SC-4 frontmatter of a realm's curation report."""
    return {
        "id": f"curator-curation-{realm_folder}-{day}",
        "title": f"curation report {day}",
        "type": REPORT_TYPE,
        "captured_by": CURATOR,
        "realm": realm_folder,
        "generated_at": generated_at,
        "scorer_version": scorer_version,
    }


def report_body(day: str, candidates: Iterable[Candidate], modes: Mapping[str, Mode], rounds: Sequence[Round],
                score_summary: Iterable[ScoreSummary], note_index: NoteIndex, *,
                accepted: Collection[tuple[str, str]] = frozenset()) -> str:
    """The page. ``accepted`` holds the (note id, action) pairs to show ticked."""
    ordered = sorted(candidates, key=lambda c: (c.collection, c.note_id, c.action))
    lines = [f"# Curation report {day}", "", INSTRUCTIONS, "", "## Tally", ""]
    for action in ACTIONS:
        lines.extend(_tally(action, modes.get(action), rounds))
    for action in ACTIONS:
        chosen = [c for c in ordered if c.action == action]
        lines.extend([_SECTION_TITLES[action], ""])
        lines.extend(candidate_line(c, note_index, checked=(c.note_id, c.action) in accepted) for c in chosen)
        lines.extend([NO_CANDIDATES] if not chosen else [])
        lines.append("")
    lines.extend(["## Scores", ""])
    summaries = sorted(score_summary, key=lambda s: s.collection)
    if not summaries:
        lines.extend(["No collection was scored in this run.", ""])
    for summary in summaries:
        lines.extend(_scores(summary, note_index))
    return "\n".join(lines).rstrip("\n") + "\n"


def display_id(note_id: str) -> tuple[str, bool]:
    """The note id as the code span shows it, and whether it had to be altered."""
    shown = note_id.translate(_ID_UNSAFE)
    return shown, shown != note_id


def candidate_line(candidate: Candidate, note_index: NoteIndex, *, checked: bool = False) -> str:
    shown, altered = display_id(candidate.note_id)
    reasons = [escape_inline(reason) for reason in candidate.reasons]
    if altered:
        reasons.append(ALTERED_ID)
    box = "[x]" if checked else "[ ]"
    verdict = "yes" if candidate.no_loss else "no"
    return (f"- {box} {candidate.action} `{shown}` {_link(candidate, note_index)} {DASH} "
            f"{'; '.join(reasons)} (no-loss: {verdict})")


def _link(candidate: Candidate, note_index: NoteIndex) -> str:
    found = note_index.get(candidate.note_id)
    if found is not None:
        return note_link(found[0], found[1])
    return f"{escape_inline(candidate.path or candidate.note_id)} (undated)"


# -- tally --------------------------------------------------------------------------------------


def _tally(action: str, mode: Mode | None, rounds: Sequence[Round]) -> list[str]:
    mode = mode or Mode("proposals", 0)
    chosen = [r for r in rounds if r.action == action]
    lines = [
        f"### {action}",
        "",
        f"Mode: {mode.mode}; streak {mode.streak} of {PROMOTION_RUNS} qualifying reports "
        f"(at least {math.floor(PROMOTION_ACCEPTANCE * 100)}% accepted, every proposal no-loss).",
        "",
    ]
    if not chosen:
        return [*lines, f"No {action} proposals yet.", ""]
    lines.extend(["| Report | Proposed | Accepted | Rejected | Undecided | Acceptance | No loss |",
                  "| --- | --- | --- | --- | --- | --- | --- |"])
    for item in sorted(chosen, key=lambda r: r.report_day):
        day = f"{item.report_day} (open)" if open_round(chosen, item) else item.report_day
        lines.append(f"| {day} | {item.proposed} | {item.accepted} | {item.rejected} | {item.undecided} | "
                     f"{_percent(item)}% | {'yes' if item.all_no_loss else 'no'} |")
    return [*lines, ""]


def _percent(item: Round) -> int:
    """Acceptance as a whole percent, rounded down in integers so 94.9% never shows as 95%."""
    return item.accepted * 100 // item.proposed if item.proposed else 0


# -- scores -------------------------------------------------------------------------------------


def _scores(summary: ScoreSummary, note_index: NoteIndex) -> list[str]:
    lines = [
        f"### {escape_inline(summary.collection)}",
        "",
        "| Notes scored | Mean impact | Importance asked |",
        "| --- | --- | --- |",
        f"| {summary.scored} | {summary.mean_impact:.2f} | {summary.importance_asked} |",
        "",
    ]
    if not summary.top:
        return lines
    lines.extend(["| Top by impact | Impact |", "| --- | --- |"])
    for note_id, impact in summary.top:
        found = note_index.get(note_id)
        cell = note_link(found[0], found[1], in_table=True) if found is not None else escape_inline(note_id)
        lines.append(f"| {cell} | {impact:.2f} |")
    return [*lines, ""]
