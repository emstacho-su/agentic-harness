"""R-C4: parse a collection's plan documents into requirements, phases and checkboxes.

A plan source (a hub's ``plan_sources:``, see profile.py) is one of two shapes:

* a **requirements document**, like ``docs/memory-sprint-requirements.md``: a
  heading whose first token is a requirement id (``### R-C4 Status against the
  plan``) opens that requirement's section, which runs to the next heading of the
  same or a higher level. Inside it, ``- **Done when.** ...`` and
  ``- **Tests.** ...`` bullets are read as text. A markdown table whose first
  header cell is ``Phase`` gives one :class:`PlanPhase` per row (plan_tables.py).
* a **numbered phase brief**, like bb2dash's ``docs/planning/50_PHASE7_x.md``: no
  requirement headings at all. The whole document is one :class:`PlanBrief`,
  its id taken from the filename (``PHASE7``, else the stem).

Every ``- [ ]`` / ``- [x]`` item is a :class:`PlanCheckbox`, attributed to the
innermost requirement section it sits in, to the brief, or to nothing.

Parsing is pure: text in, frozen dataclasses out. Lines are 1-based, counted
after CRLF and CR are normalised to LF. Anything inside a code fence is ignored.
:func:`load_plan_sources` is the only function that touches the disk; it reads
only what the profile resolved, and a directory only one level deep.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from .extract_schema import REQUIREMENT_ID_PATTERN
from .plan_tables import PlanPhase, TableScanner
from .profile import CollectionProfile, PlanSource

__all__ = [
    "PlanBrief", "PlanCheckbox", "PlanDocument", "PlanPhase", "PlanRequirement", "PlanSourceProblem",
    "load_plan_sources", "parse_plan", "requirement_ids_in",
]

_REQUIREMENT_ID = re.compile(REQUIREMENT_ID_PATTERN)
# A maximal run of the characters requirement_in_body treats as part of a token:
# an id found inside one is found as a whole token, so R-C2 never matches in R-C23.
_TOKEN_RUN = re.compile(r"[A-Za-z0-9-]+")

_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_HEADING = re.compile(r"^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$|^ {0,3}(#{1,6})[ \t]*$")
_LIST_ITEM = re.compile(r"^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+")
_CHECKBOX = re.compile(r"^([ \t]*)[-*+][ \t]+\[([ xX])\][ \t]+(\S.*)$")
_FIELD = re.compile(r"^([ \t]*)[-*+][ \t]+\*\*(Done when|Tests)[.:]?\*\*[.:]?[ \t]*(.*)$", re.IGNORECASE)
_BRIEF_ID = re.compile(r"(?:^|_)(phase\d+)(?:_|$)", re.IGNORECASE)

FIELD_DONE_WHEN = "done when"
FIELD_TESTS = "tests"


@dataclass(frozen=True)
class PlanCheckbox:
    text: str
    checked: bool
    line: int
    requirement_id: str | None  # the requirement or brief it sits in, else None


@dataclass(frozen=True)
class PlanRequirement:
    id: str
    title: str
    level: int
    phase: str | None  # the nearest enclosing lower-level heading, the document title excepted
    line: int
    done_when: str | None
    tests: str | None
    checkboxes: tuple[PlanCheckbox, ...]


@dataclass(frozen=True)
class PlanBrief:
    """A numbered phase brief: a document with no requirement headings."""

    id: str
    title: str


@dataclass(frozen=True)
class PlanDocument:
    source: str
    title: str
    requirements: tuple[PlanRequirement, ...]
    phases: tuple[PlanPhase, ...]
    checkboxes: tuple[PlanCheckbox, ...]
    brief: PlanBrief | None


@dataclass(frozen=True)
class PlanSourceProblem:
    """A plan source that could not be read, and why (no file content, ever)."""

    given: str
    reason: str


def requirement_ids_in(text: str) -> tuple[str, ...]:
    """The distinct requirement ids in ``text`` as whole tokens, in order of first appearance."""
    seen: dict[str, None] = {}
    for run in _TOKEN_RUN.finditer(text):
        token = run.group(0)
        if _REQUIREMENT_ID.match(token):
            seen.setdefault(token, None)
    return tuple(seen)


# -- parsing -----------------------------------------------------------------------------


@dataclass
class _Section:
    """A requirement while its section is open."""

    id: str
    title: str
    level: int
    phase: str | None
    line: int
    fields: dict[str, str]


def parse_plan(text: str, source: str) -> PlanDocument:
    """Parse one plan document. ``source`` names it; a brief's id comes from its filename."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    headings: list[tuple[int, str, int]] = []  # every heading outside fences: (level, text, line)
    sections: list[_Section] = []
    open_sections: list[_Section] = []
    boxes: list[tuple[str, bool, int, str | None]] = []
    tables = TableScanner()
    fence: str | None = None

    for index, line in enumerate(lines):
        number = index + 1
        fence_match = _FENCE.match(line)
        if fence is not None:
            if fence_match and fence_match.group(1)[0] == fence[0] and len(fence_match.group(1)) >= len(fence):
                fence = None
            continue
        if fence_match:
            fence = fence_match.group(1)
            tables.close()
            continue
        if tables.feed(line, lines[index + 1] if index + 1 < len(lines) else None, number):
            continue

        heading = _heading(line)
        if heading is not None:
            level, heading_text = heading
            while open_sections and open_sections[-1].level >= level:
                open_sections.pop()
            requirement = _requirement(heading_text)
            if requirement is not None:
                phase = _phase(headings, level)
                section = _Section(requirement[0], requirement[1], level, phase, number, {})
                sections.append(section)
                open_sections.append(section)
            headings.append((level, heading_text, number))
            continue

        current = open_sections[-1] if open_sections else None
        checkbox = _CHECKBOX.match(line)
        if checkbox is not None:
            body = _bullet_text(checkbox.group(3), lines, index, len(checkbox.group(1)))
            boxes.append((body, checkbox.group(2) != " ", number, current.id if current else None))
            continue
        field = _FIELD.match(line) if current is not None else None
        if field is not None:
            name = field.group(2).lower()
            if name not in current.fields:
                current.fields[name] = _bullet_text(field.group(3), lines, index, len(field.group(1)))
    tables.close()

    title = _title(headings, source)
    brief = None if sections else PlanBrief(_brief_id(source), title)
    fallback_owner = brief.id if brief is not None else None
    checkboxes = tuple(
        PlanCheckbox(body, checked, number, owner if owner is not None else fallback_owner)
        for body, checked, number, owner in boxes
    )
    requirements = tuple(_finish(section, checkboxes) for section in sections)
    return PlanDocument(source, title, requirements, tables.phases(), checkboxes, brief)


def _heading(line: str) -> tuple[int, str] | None:
    match = _HEADING.match(line)
    if match is None:
        return None
    if match.group(1) is None:
        return len(match.group(3)), ""
    return len(match.group(1)), match.group(2).strip()


def _requirement(heading_text: str) -> tuple[str, str] | None:
    """(id, title) when the heading's first token is a requirement id."""
    parts = heading_text.split(None, 1)
    if not parts or not _REQUIREMENT_ID.match(parts[0]):
        return None
    return parts[0], parts[1].strip() if len(parts) > 1 else ""


def _phase(headings: list[tuple[int, str, int]], level: int) -> str | None:
    """The nearest enclosing heading of a lower level, skipping the document title."""
    title_line = next((line for heading_level, _, line in headings if heading_level == 1), None)
    for heading_level, heading_text, line in reversed(headings):
        if heading_level < level:
            return None if line == title_line else heading_text
    return None


def _first_h1(headings: list[tuple[int, str, int]]) -> str | None:
    return next((text for level, text, _ in headings if level == 1), None)


def _bullet_text(first: str, lines: list[str], index: int, indent: int) -> str:
    """A list item's text, joined with its indented continuation lines by single spaces.

    The item ends at a blank line, a line indented no deeper than the item, or a
    new list item at the item's own depth or shallower.
    """
    parts = [first.strip()]
    for line in lines[index + 1:]:
        if not line.strip():
            break
        depth = len(line) - len(line.lstrip(" \t"))
        if depth <= indent:
            break
        item = _LIST_ITEM.match(line)
        if item is not None and len(item.group(1)) <= indent:
            break
        parts.append(line.strip())
    return " ".join(part for part in parts if part)


def _title(headings: list[tuple[int, str, int]], source: str) -> str:
    return _first_h1(headings) or _stem(source)


def _stem(source: str) -> str:
    return PurePosixPath(source.replace("\\", "/")).stem


def _brief_id(source: str) -> str:
    """``50_PHASE7_retrieval_polish`` -> ``PHASE7``; any other stem is its own id."""
    stem = _stem(source)
    match = _BRIEF_ID.search(stem)
    return match.group(1).upper() if match else stem


def _finish(section: _Section, checkboxes: tuple[PlanCheckbox, ...]) -> PlanRequirement:
    return PlanRequirement(
        id=section.id,
        title=section.title,
        level=section.level,
        phase=section.phase,
        line=section.line,
        done_when=section.fields.get(FIELD_DONE_WHEN),
        tests=section.fields.get(FIELD_TESTS),
        checkboxes=tuple(box for box in checkboxes if box.requirement_id == section.id),
    )


# -- loading -----------------------------------------------------------------------------


def load_plan_sources(profile: CollectionProfile) -> tuple[PlanDocument | PlanSourceProblem, ...]:
    """Parse every plan source the profile resolved; a directory gives one document per ``*.md``."""
    loaded: list[PlanDocument | PlanSourceProblem] = []
    for source in profile.plan_sources:
        loaded.extend(_load_one(source))
    return tuple(loaded)


def _load_one(source: PlanSource) -> list[PlanDocument | PlanSourceProblem]:
    if not source.exists:
        return [PlanSourceProblem(source.given, "not found")]
    path = Path(source.resolved)
    if not source.is_dir:
        return [_read(path, source.given, "")]
    try:
        root = path.resolve(strict=True)
        entries = sorted((entry for entry in path.iterdir() if entry.suffix == ".md"), key=lambda entry: entry.name)
    except OSError as exc:
        return [PlanSourceProblem(source.given, f"unreadable directory ({type(exc).__name__})")]
    documents: list[PlanDocument | PlanSourceProblem] = []
    for entry in entries:
        prefix = f"{entry.name}: "
        try:
            inside = entry.resolve(strict=True).parent == root
            is_file = entry.is_file()
        except OSError as exc:
            documents.append(PlanSourceProblem(source.given, f"{prefix}unreadable ({type(exc).__name__})"))
            continue
        if not inside:
            documents.append(PlanSourceProblem(source.given, f"{prefix}leads outside the directory"))
        elif is_file:
            documents.append(_read(entry, source.given, prefix))
    if not documents:
        return [PlanSourceProblem(source.given, "no .md files in the directory")]
    return documents


def _read(path: Path, given: str, prefix: str) -> PlanDocument | PlanSourceProblem:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        return PlanSourceProblem(given, f"{prefix}unreadable ({type(exc).__name__})")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return PlanSourceProblem(given, f"{prefix}not UTF-8")
    return parse_plan(text, path.as_posix())
