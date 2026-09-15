"""The 24 h conclude sweep (R-27.2).

A session is *concluded* when its ``SessionEnd`` fired for a reason other than a
resume, or when no resume has followed within 24 hours. The hook cannot know the
second case — it has already exited — so the nightly job decides it here.

Two rules govern every edit:

**Merge, never rewrite.** Exactly two frontmatter keys change, ``status`` and
``concluded_at``. The edit is made on the raw text, line by line, so key order,
quoting style, comments, blank lines, indentation and every hand-added tag come
through byte-for-byte. A YAML load-and-dump round trip would silently reformat
all of that, and Stack edits these notes by hand.

**Status never regresses.** Only ``status: active`` is touched. A note that is
already ``concluded`` or ``superseded`` is left exactly as it is, and a note
with no ``status`` at all is refused rather than guessed at.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path

from .errors import SourceError
from .loaders.obsidian import (
    MARKDOWN_SUFFIXES,
    walk_exclusion,
    split_frontmatter,
    vault_root,
)

log = logging.getLogger(__name__)

# Frozen frontmatter names (66_SESSION_ARCHIVAL_RAG.md R-27.2 / R-27.3).
TYPE_KEY = "type"
SESSION_TYPE = "session"
STATUS_KEY = "status"
CONCLUDED_AT_KEY = "concluded_at"
ENDED_AT_KEY = "ended_at"

STATUS_ACTIVE = "active"
STATUS_CONCLUDED = "concluded"

# R-27.2: "no resume has followed within 24 h".
DEFAULT_STALE_AFTER_HOURS = 24

# Exactly what python-frontmatter's YAMLHandler accepts (`^-{3,}\s*$`), and
# nothing else. split_frontmatter decides whether a note HAS frontmatter; if
# this disagreed with it, a note it parsed happily could be scanned past its real
# closing fence into the body, and a horizontal rule down there would be mistaken
# for the boundary.
_FRONTMATTER_FENCE = re.compile(r"^-{3,}\s*$")
_KEY_LINE = re.compile(r"^(?P<indent>\s*)(?P<key>[A-Za-z0-9_]+)(?P<gap>\s*:\s*)(?P<value>.*)$")
_VALUE_TOKEN = re.compile(r"^(?P<token>\S*)(?P<trail>.*)$")


class Action(str, Enum):
    """What the sweep did, or would do, with one note."""

    CONCLUDED = "concluded"
    STILL_FRESH = "still-active"
    NOT_ACTIVE = "left-alone"
    REFUSED = "refused"


@dataclass(frozen=True)
class NoteOutcome:
    relative: str
    action: Action
    detail: str | None = None


@dataclass(frozen=True)
class SweepResult:
    """Everything the sweep saw. Immutable; the CLI only reports it."""

    outcomes: tuple[NoteOutcome, ...] = ()
    applied: bool = False
    scanned: int = 0

    def of(self, action: Action) -> tuple[NoteOutcome, ...]:
        return tuple(o for o in self.outcomes if o.action is action)

    def summary(self) -> dict[str, int]:
        return {action.value: len(self.of(action)) for action in Action}

    @property
    def refused(self) -> tuple[NoteOutcome, ...]:
        return self.of(Action.REFUSED)


def sweep_concluded(
    vault_path: str | Path,
    *,
    now: datetime | None = None,
    stale_after_hours: int = DEFAULT_STALE_AFTER_HOURS,
    apply: bool = False,
) -> SweepResult:
    """Conclude every stale ``active`` session note under ``vault_path``."""
    if stale_after_hours < 1:
        raise ValueError("stale_after_hours must be >= 1")

    root = vault_root(vault_path)
    moment = now or datetime.now(timezone.utc)
    cutoff = moment - timedelta(hours=stale_after_hours)

    outcomes: list[NoteOutcome] = []
    scanned = 0
    for path in sorted(_iter_session_notes(root)):
        relative = path.relative_to(root).as_posix()
        scanned += 1
        outcomes.append(_sweep_note(path, relative, cutoff=cutoff, moment=moment, apply=apply))

    return SweepResult(tuple(outcomes), applied=apply, scanned=scanned)


# --------------------------------------------------------------------------


def _iter_session_notes(root: Path):
    """Every markdown note the vault walk visits whose frontmatter is a session."""
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in MARKDOWN_SUFFIXES:
            continue
        if walk_exclusion(path.relative_to(root).as_posix()):
            continue
        try:
            raw = path.read_bytes().decode("utf-8")
        except (OSError, UnicodeDecodeError):
            # Unreadable notes are the full ingest's problem to report, not the
            # sweep's: it must never fail the nightly job over one bad file.
            continue
        if f"{TYPE_KEY}:" not in raw[:2000]:
            continue
        try:
            frontmatter, _ = split_frontmatter(raw, path.name)
        except SourceError:
            continue
        if frontmatter.get(TYPE_KEY) == SESSION_TYPE:
            yield path


def _sweep_note(
    path: Path, relative: str, *, cutoff: datetime, moment: datetime, apply: bool
) -> NoteOutcome:
    try:
        # Bytes, not read_text: universal-newline translation would rewrite a
        # CRLF note as LF and break the byte-for-byte promise.
        raw = path.read_bytes().decode("utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return NoteOutcome(relative, Action.REFUSED, f"unreadable ({exc})")

    try:
        frontmatter, _ = split_frontmatter(raw, relative)
    except SourceError as exc:
        return NoteOutcome(relative, Action.REFUSED, str(exc))

    status = frontmatter.get(STATUS_KEY)
    if status is None:
        return NoteOutcome(
            relative, Action.REFUSED, f"no '{STATUS_KEY}' in frontmatter; refusing to invent one"
        )
    if not isinstance(status, str):
        return NoteOutcome(
            relative, Action.REFUSED, f"'{STATUS_KEY}' is {type(status).__name__}, expected a string"
        )
    if status.strip() != STATUS_ACTIVE:
        return NoteOutcome(relative, Action.NOT_ACTIVE, f"{STATUS_KEY}: {status.strip()}")

    try:
        ended_at = _parse_ended_at(frontmatter.get(ENDED_AT_KEY))
    except ValueError as exc:
        return NoteOutcome(relative, Action.REFUSED, str(exc))

    if ended_at > cutoff:
        return NoteOutcome(relative, Action.STILL_FRESH, f"{ENDED_AT_KEY}: {ended_at.isoformat()}")

    try:
        updated = merge_conclusion(raw, concluded_at=moment)
    except ValueError as exc:
        return NoteOutcome(relative, Action.REFUSED, str(exc))

    if not apply:
        return NoteOutcome(relative, Action.CONCLUDED, "dry run, not written")

    try:
        _write_atomically(path, updated.encode("utf-8"))
    except OSError as exc:
        return NoteOutcome(relative, Action.REFUSED, f"write failed ({exc})")
    log.info("concluded %s", relative)
    return NoteOutcome(relative, Action.CONCLUDED, None)


def _write_atomically(path: Path, payload: bytes) -> None:
    """Replace a note's contents without ever leaving it half-written.

    Writing in place truncates first, so a crash between truncate and write
    leaves an empty note — and these are the user's own notes, edited by a job
    that runs unattended at 03:00. Write a sibling, then rename over the
    original, which is atomic on both NTFS and POSIX.
    """
    temporary = path.with_name(f"{path.name}.sweep-tmp")
    try:
        temporary.write_bytes(payload)
        os.replace(temporary, path)
    except OSError:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:  # pragma: no cover - the original error is the real one
            pass
        raise


def merge_conclusion(raw: str, *, concluded_at: datetime) -> str:
    """Return ``raw`` with only ``status`` and ``concluded_at`` changed.

    Every other byte of the note — frontmatter and body alike — is preserved,
    including the file's own line endings.
    """
    lines = raw.splitlines(keepends=True)
    start, end = _frontmatter_bounds(lines)

    status_index = _find_key(lines, start, end, STATUS_KEY)
    if status_index is None:
        raise ValueError(f"no '{STATUS_KEY}' line in the frontmatter")

    _refuse_block_scalar(lines[status_index], STATUS_KEY)

    stamp = concluded_at.astimezone(timezone.utc).isoformat()
    updated = list(lines)
    updated[status_index] = _replace_value(updated[status_index], STATUS_CONCLUDED)

    concluded_index = _find_key(updated, start, end, CONCLUDED_AT_KEY)
    if concluded_index is not None:
        _refuse_block_scalar(lines[concluded_index], CONCLUDED_AT_KEY)
    if concluded_index is None:
        # Keep the two related keys adjacent, and reuse the status line's own
        # indentation and newline so the file's style is untouched.
        updated.insert(status_index + 1, _new_line_like(updated[status_index], CONCLUDED_AT_KEY, stamp))
    else:
        updated[concluded_index] = _replace_value(updated[concluded_index], stamp)

    return "".join(updated)


def _frontmatter_bounds(lines: list[str]) -> tuple[int, int]:
    """Indices of the first and last line INSIDE the frontmatter block."""
    if not lines or not _FRONTMATTER_FENCE.match(lines[0].rstrip("\r\n")):
        raise ValueError("note has no YAML frontmatter")
    for index in range(1, len(lines)):
        if _FRONTMATTER_FENCE.match(lines[index].rstrip("\r\n")):
            return 1, index
    raise ValueError("frontmatter block is never closed")


def _refuse_block_scalar(line: str, key: str) -> None:
    """A ``key: |`` or ``key: >`` value continues on the lines below it.

    The line-wise edit only ever replaces the first token on one line, so it
    would swap the ``|`` for the new value and strand the indented continuation
    as an orphan — turning a note into invalid YAML. Neither of these two keys
    is ever written that way; if one is, that is a hand edit worth refusing.
    """
    match = _KEY_LINE.match(line.rstrip("\r\n"))
    if match is None:  # pragma: no cover - callers only pass matched lines
        return
    token = _VALUE_TOKEN.match(match.group("value")).group("token")
    if token[:1] in ("|", ">"):
        raise ValueError(f"'{key}' is a YAML block scalar ({token}); refusing to edit it line-wise")


def _find_key(lines: list[str], start: int, end: int, key: str) -> int | None:
    for index in range(start, min(end, len(lines))):
        match = _KEY_LINE.match(lines[index].rstrip("\r\n"))
        # Top-level keys only: an indented match belongs to a nested mapping.
        if match and match.group("key") == key and not match.group("indent"):
            return index
    return None


def _replace_value(line: str, value: str) -> str:
    """Swap the scalar on a ``key: value`` line, keeping everything else.

    ``status`` and ``concluded_at`` are single-token scalars, so the first
    whitespace-delimited token is the value and whatever follows it — padding, or
    an inline ``#`` comment Stack left there — is carried through untouched.
    """
    body = line.rstrip("\r\n")
    ending = line[len(body):]
    match = _KEY_LINE.match(body)
    if match is None:  # pragma: no cover - callers only pass matched lines
        raise ValueError(f"cannot parse frontmatter line: {body!r}")
    trailing = _VALUE_TOKEN.match(match.group("value")).group("trail")
    return (
        f"{match.group('indent')}{match.group('key')}{match.group('gap')}"
        f"{value}{trailing}{ending}"
    )


def _new_line_like(sibling: str, key: str, value: str) -> str:
    body = sibling.rstrip("\r\n")
    ending = sibling[len(body):] or "\n"
    return f"{key}: {value}{ending}"


def _parse_ended_at(raw: object) -> datetime:
    if raw is None:
        raise ValueError(f"no '{ENDED_AT_KEY}' in frontmatter; cannot tell whether it is stale")
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(f"'{ENDED_AT_KEY}' is not a timestamp: {raw!r}")

    try:
        parsed = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"'{ENDED_AT_KEY}' is not an ISO 8601 timestamp: {raw!r}") from exc
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


__all__ = [
    "Action",
    "DEFAULT_STALE_AFTER_HOURS",
    "NoteOutcome",
    "SweepResult",
    "merge_conclusion",
    "sweep_concluded",
]
