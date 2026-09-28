"""R-C5: ``<realm>/<collection>/history.md`` — frontmatter (SC-4) and body.

The body is deterministic: weeks ascending, records in each week's timeline
order, citations in timeline order whatever order they were stored in, dates
only, and nothing that depends on when the run happened. That, and the writer
ignoring ``generated_at``, is what lets a rerun with nothing new leave the file
byte for byte.

Every paragraph and suggested title comes from the model, and every note title
from a note, so each passes :func:`~.render.escape_inline`. A citation is a
wikilink built by :func:`~.render.note_link` from the inventory's own path for
the cited note id, never from model text.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence

from .history import WeekInput
from .note_records import CURATOR
from .render import ARROW, DASH, NoteIndex, escape_inline, note_link
from .store_models import HistoryWeek

HISTORY_TYPE = "history"
PENDING = "narrative pending"
NO_PARAGRAPH = "No paragraph of this week's narrative cited a session."
NO_WEEKS = "No dated sessions yet."

_WHITESPACE = re.compile(r"\s+")


def history_frontmatter(realm: str, collection: str, generated_at: str, history_version: str) -> dict[str, str]:
    """SC-4 frontmatter; ``realm`` is the realm's folder, the collection slug replaces spaces."""
    slug = _WHITESPACE.sub("-", collection.strip())
    return {
        "id": f"curator-history-{realm}-{slug}",
        "title": f"{collection} history",
        "type": HISTORY_TYPE,
        "captured_by": CURATOR,
        "collection": collection,
        "generated_at": generated_at,
        "history_version": history_version,
    }


def history_body(collection: str, weeks: Iterable[WeekInput], narratives: Mapping[str, HistoryWeek],
                 notes: NoteIndex) -> str:
    ordered = sorted(weeks, key=lambda week: week.week_start)
    lines = [
        f"# {escape_inline(collection)} history",
        "",
        "Written by the curator from session notes and git history: a week-by-week narrative in which "
        "every paragraph cites the sessions it rests on, with suggested session titles after the arrow.",
        "",
    ]
    if not ordered:
        lines.extend([NO_WEEKS, ""])
    for week in ordered:
        lines.extend(_week(week, narratives.get(week.week_start), notes))
    return "\n".join(lines).rstrip("\n") + "\n"


def _week(week: WeekInput, narrative: HistoryWeek | None, notes: NoteIndex) -> list[str]:
    lines = [f"## Week of {week.week_start}", ""]
    if narrative is None:
        lines.extend([PENDING, ""])
    elif not narrative.narrative:
        lines.extend([NO_PARAGRAPH, ""])
    else:
        order = _timeline(week)
        for paragraph in narrative.narrative:
            lines.extend([escape_inline(paragraph["text"]), _citations(paragraph["note_ids"], order, notes), ""])
    titles = narrative.titles if narrative is not None else {}
    lines.extend(["Sessions:", ""])
    lines.extend(_session_line(row.record.note_id, row.record.path, row.effective_at, row.record.title, titles)
                 for row in week.records)
    lines.append("")
    return lines


def _timeline(week: WeekInput) -> dict[str, int]:
    order: dict[str, int] = {}
    for row in week.records:
        order.setdefault(row.record.note_id, len(order))
    return order


def _citations(note_ids: Sequence[str], order: Mapping[str, int], notes: NoteIndex) -> str:
    ranked = sorted(dict.fromkeys(note_ids), key=lambda note_id: (order.get(note_id, len(order)), note_id))
    return f"{DASH} " + ", ".join(_cite(note_id, notes) for note_id in ranked)


def _cite(note_id: str, notes: NoteIndex) -> str:
    found = notes.get(note_id)
    if found is None:
        return f"note {escape_inline(note_id)}"
    return note_link(found[0], found[1])


def _session_line(note_id: str, path: str, effective_at: str, title: str, titles: Mapping[str, str]) -> str:
    line = f"- {note_link(path, effective_at)} {escape_inline(title)}"
    suggested = titles.get(note_id)
    return f"{line} {ARROW} {escape_inline(suggested)}" if suggested else line
