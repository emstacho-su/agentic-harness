"""R-C3: ``<realm>/<collection>/ledger.md`` — frontmatter (SC-4) and body.

The body is deterministic: issues in id (seq) order, events in the reducer's
order, dates only (no timestamps), and nothing that depends on when the run
happened. That, and the writer ignoring ``generated_at``, is what lets a rerun
with nothing new leave the file byte for byte.

**Untrusted text.** Summaries, evidence quotes, file names and commit subjects
come from notes or from the model, so every one passes :func:`escape_inline`
before it reaches the page: one line, no wikilink or markdown link brackets, no
raw HTML, no code spans, no Obsidian comment (``%%``), every ``|`` escaped so a
table cell cannot grow a column, and no leading ``#``, ``-`` or ``>`` that could
start a heading, a rule or a quote. A note is cited by a wikilink the curator
builds from the inventory's own path (never from model text), and a path that
cannot be a safe wikilink is shown as escaped plain text instead.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

from .ledger_state import IssueState, Transition
from .note_records import CURATOR
from .store_models import ISSUE_STATES, Issue

LEDGER_TYPE = "ledger"
SHORT_SHA = 7
NO_STATE = "none"
DASH = "—"
ARROW = "→"

# (vault-relative path with .md, effective date) per note id.
NoteIndex = Mapping[str, tuple[str, str]]

_WHITESPACE = re.compile(r"\s+")
_HEX = re.compile(r"^[0-9a-fA-F]+$")
_WIKILINK_UNSAFE = re.compile(r"[\[\]|#^\n\r<>%`]")
# Markdown and Obsidian syntax characters, escaped with a backslash.
_BACKSLASHED = str.maketrans({"\\": "\\\\", "[": "\\[", "]": "\\]", "|": "\\|", "`": "\\`"})
_LEADING_MARKUP = ("#", "-", ">", "+", "*", "=")


@dataclass(frozen=True)
class LedgerEntry:
    """One issue as the page shows it: the row, its replayed state, and every file it names."""

    issue: Issue
    state: IssueState
    files: tuple[str, ...]


def escape_inline(text: str) -> str:
    """Untrusted text as one inert line of markdown; see the module docstring."""
    one_line = _WHITESPACE.sub(" ", str(text)).strip()
    escaped = (one_line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
               .translate(_BACKSLASHED))
    escaped = re.sub(r"%(?=%)", "&#37;", escaped)
    if escaped.startswith(_LEADING_MARKUP):
        escaped = "\\" + escaped
    return escaped


def ledger_frontmatter(realm: str, collection: str, generated_at: str, extractor_version: str) -> dict[str, str]:
    """SC-4 frontmatter; ``realm`` is the realm's folder, the collection slug replaces spaces."""
    slug = _WHITESPACE.sub("-", collection.strip())
    return {
        "id": f"curator-ledger-{realm}-{slug}",
        "title": f"{collection} issue ledger",
        "type": LEDGER_TYPE,
        "captured_by": CURATOR,
        "collection": collection,
        "generated_at": generated_at,
        "extractor_version": extractor_version,
    }


def ledger_body(collection: str, entries: Iterable[LedgerEntry], notes: NoteIndex) -> str:
    ordered = sorted(entries, key=lambda e: e.issue.seq)
    lines = [
        f"# {escape_inline(collection)} issue ledger",
        "",
        "Written by the curator from session notes and git history. Every state change cites its "
        "cause; nothing is deleted, and a fixed issue keeps its dates.",
        "",
        "## Counts",
        "",
        *_counts(ordered),
        "",
        "## Issues",
        "",
    ]
    if not ordered:
        lines.extend(["No issues yet.", ""])
    for entry in ordered:
        lines.extend(_section(entry, notes))
    return "\n".join(lines).rstrip("\n") + "\n"


def _counts(entries: Sequence[LedgerEntry]) -> list[str]:
    counts = Counter(entry.state.state for entry in entries)
    rows = ["| State | Issues |", "| --- | --- |"]
    rows.extend(f"| {state} | {counts[state]} |" for state in ISSUE_STATES)
    if counts[None]:
        rows.append(f"| {NO_STATE} | {counts[None]} |")
    rows.append(f"| total | {len(entries)} |")
    return rows


def _section(entry: LedgerEntry, notes: NoteIndex) -> list[str]:
    issue, state = entry.issue, entry.state
    files = ", ".join(escape_inline(name) for name in entry.files) or "none"
    return [
        f"### {escape_inline(issue.issue_id)} {DASH} {escape_inline(issue.summary)}",
        "",
        f"- state: {state.state or NO_STATE}",
        f"- kind: {escape_inline(issue.kind or 'unknown')}",
        f"- files: {files}",
        f"- valid: {_intervals(state)}",
        f"- sightings: {state.sightings}",
        "",
        "| Date | Event | State | Cause | Evidence |",
        "| --- | --- | --- | --- | --- |",
        *(_row(transition, notes) for transition in state.transitions),
        "",
    ]


def _intervals(state: IssueState) -> str:
    if not state.intervals:
        return "no interval yet"
    return "; ".join(f"{_day(start)} to {_day(end) if end else 'now'}" for start, end in state.intervals)


def _row(transition: Transition, notes: NoteIndex) -> str:
    before = transition.from_state or NO_STATE
    after = transition.to_state or NO_STATE
    moved = f"{before} {ARROW} {after}" if before != after else f"{after} (no change)"
    evidence = escape_inline(transition.evidence) if transition.evidence else ""
    cells = (_day(transition.at), transition.event_kind, moved, _cause(transition, notes), evidence)
    return "| " + " | ".join(cells) + " |"


def _cause(transition: Transition, notes: NoteIndex) -> str:
    ref = transition.cause_ref
    if transition.cause_type == "note":
        found = notes.get(ref)
        if found is None:
            return f"note {escape_inline(ref)}"
        return note_link(found[0], found[1], in_table=True)
    if transition.cause_type == "commit":
        return f"commit {ref[:SHORT_SHA]}" if _HEX.match(ref) else f"commit {escape_inline(ref)}"
    if transition.cause_type == "pr":
        return f"PR #{ref}" if ref.isdigit() else f"PR {escape_inline(ref)}"
    return escape_inline(ref)


def note_link(path: str, effective_at: str, *, in_table: bool = False) -> str:
    """``[[path without .md|date]]``, the pipe escaped inside a table; plain text if unsafe."""
    target = path[:-3] if path.endswith(".md") else path
    day = _day(effective_at)
    if _WIKILINK_UNSAFE.search(target) or not target.strip():
        return f"{escape_inline(target)} ({day})"
    separator = "\\|" if in_table else "|"
    return f"[[{target}{separator}{day}]]"


def _day(instant: str) -> str:
    return instant[:10]
