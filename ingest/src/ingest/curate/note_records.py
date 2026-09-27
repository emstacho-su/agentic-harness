"""The inventory's note walk: one collection folder in, typed records out (R-C1).

Split from inventory.py so each stays readable. Nothing here decides order or
nesting; it reads files, classifies them, and says why anything was left out.

The session note's list fields that R-C6's scores read (``commits``, ``prs``,
``files_modified``, ``retrieved``; see hooks/lib/frontmatter.mjs) are parsed
defensively: a scalar becomes a one-tuple, a number in a text list becomes its
text, a PR given as digits becomes its number, and anything else (a map, a
nested list, a boolean, null, blank text) is dropped rather than refused.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

from ..errors import SourceError
from ..hashing import content_hash
from ..loaders.obsidian import MARKDOWN_SUFFIXES, SKIP_DIRECTORIES, split_frontmatter

ROLE_SESSION = "session"
ROLE_SUBAGENT = "subagent"
ROLE_NOTE = "note"
ROLE_DECISION = "decision"

SESSIONS_DIR = "sessions"
DECISIONS_DIR = "decisions"

# Folders inside a collection that hold no notes the curator reads: exported
# class materials (they are plan sources, reached through the profile) and templates.
EXCLUDED_DIRECTORIES = frozenset({"materials", "templates"}) | SKIP_DIRECTORIES

# SC-4: the curator never reads its own output back as evidence.
CURATOR = "curator"
CURATOR_REASON = "curator-written note (captured_by: curator)"
NO_FRONTMATTER = "no frontmatter"

# `<parent session id>--<agent id>.md` is the hook's subagent filename.
SUBAGENT_SEPARATOR = "--"

_H1 = re.compile(r"^\s{0,3}#\s+(.+?)\s*#*\s*$", re.MULTILINE)


@dataclass(frozen=True)
class NoteRecord:
    note_id: str
    path: str  # vault-relative, posix
    realm: str | None
    collection: str
    role: str
    origin: str | None
    captured_by: str | None
    date: str | None  # started_at, else date; ISO text
    session_id: str | None
    parent_session_id: str | None
    title: str
    body: str
    content_hash: str
    cwd: str | None = None
    repo: str | None = None
    commits: tuple[str, ...] = ()
    prs: tuple[int, ...] = ()
    files_modified: tuple[str, ...] = ()
    retrieved: tuple[str, ...] = ()


@dataclass(frozen=True)
class SkippedNote:
    path: str
    reason: str


@dataclass(frozen=True)
class WalkResult:
    records: tuple[NoteRecord, ...]
    skipped: tuple[SkippedNote, ...]  # could not be read as a note
    excluded: tuple[SkippedNote, ...]  # left out by design


def walk_collection(vault: Path, collection_dir: Path, realm: str | None, collection: str) -> WalkResult:
    """Every markdown file under ``collection_dir``, except the hub, classified."""
    records: list[NoteRecord] = []
    skipped: list[SkippedNote] = []
    excluded: list[SkippedNote] = []
    hub = (f"{collection_dir.name}.md",)

    for path in sorted(collection_dir.rglob("*")):
        if path.suffix.lower() not in MARKDOWN_SUFFIXES or not path.is_file():
            continue
        parts = path.relative_to(collection_dir).parts
        if parts == hub:
            continue
        relative = path.relative_to(vault).as_posix()
        folder = next((part for part in parts[:-1] if part in EXCLUDED_DIRECTORIES), None)
        if folder is not None:
            excluded.append(SkippedNote(relative, f"under {folder}/"))
            continue
        try:
            fields, body = _read(path)
        except SourceError as exc:
            skipped.append(SkippedNote(relative, str(exc)))
            continue
        if not fields:
            skipped.append(SkippedNote(relative, NO_FRONTMATTER))
        elif _text(fields.get("captured_by")) == CURATOR:
            excluded.append(SkippedNote(relative, CURATOR_REASON))
        else:
            records.append(_record(path, relative, parts, fields, body, realm, collection))
    return WalkResult(tuple(records), tuple(skipped), tuple(excluded))


def _read(path: Path) -> tuple[dict[str, Any], str]:
    try:
        raw = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise SourceError(f"not valid UTF-8 ({exc.reason})") from exc
    except OSError as exc:
        raise SourceError(f"unreadable ({exc})") from exc
    return split_frontmatter(raw, path.name)


def _record(
    path: Path,
    relative: str,
    parts: tuple[str, ...],
    fields: dict[str, Any],
    body: str,
    realm: str | None,
    collection: str,
) -> NoteRecord:
    role = _role(parts, path.stem, fields)
    session_id, parent = _session_ids(role, path.stem, fields)
    return NoteRecord(
        note_id=_note_id(fields, relative),
        path=relative,
        realm=realm,
        collection=collection,
        role=role,
        origin=_text(fields.get("origin")),
        captured_by=_text(fields.get("captured_by")),
        date=_iso(fields.get("started_at")) or _iso(fields.get("date")),
        session_id=session_id,
        parent_session_id=parent,
        title=_title(fields, body, path),
        body=body,
        content_hash=content_hash(body),
        cwd=_text(fields.get("cwd")),
        repo=_text(fields.get("repo")),
        commits=_texts(fields.get("commits")),
        prs=_numbers(fields.get("prs")),
        files_modified=_texts(fields.get("files_modified")),
        retrieved=_texts(fields.get("retrieved")),
    )


def _role(parts: tuple[str, ...], stem: str, fields: dict[str, Any]) -> str:
    top = parts[0] if len(parts) > 1 else ""
    if top == SESSIONS_DIR:
        is_subagent = SUBAGENT_SEPARATOR in stem or _text(fields.get("parent_session")) is not None
        return ROLE_SUBAGENT if is_subagent else ROLE_SESSION
    if top == DECISIONS_DIR:
        return ROLE_DECISION
    return ROLE_NOTE


def _session_ids(role: str, stem: str, fields: dict[str, Any]) -> tuple[str | None, str | None]:
    """(session_id, parent_session_id). A subagent's filename names its parent."""
    declared = _text(fields.get("session_id"))
    if role == ROLE_SESSION:
        return declared or stem, None
    if role != ROLE_SUBAGENT:
        return declared, None
    from_name = stem.split(SUBAGENT_SEPARATOR, 1)[0] if SUBAGENT_SEPARATOR in stem else None
    parent = _text(fields.get("parent_session")) or from_name
    return declared or from_name, parent


def _note_id(fields: dict[str, Any], relative: str) -> str:
    raw = fields.get("id")
    if raw is None or isinstance(raw, (bool, list, dict)):
        return relative
    return str(raw).strip() or relative


def _title(fields: dict[str, Any], body: str, path: Path) -> str:
    """Frontmatter title, then the first H1, then the filename — as the loader does."""
    title = _text(fields.get("title"))
    if title:
        return title
    match = _H1.search(body)
    return match.group(1).strip() if match else path.stem


def _text(value: object) -> str | None:
    """A non-empty stripped string, or None for anything else."""
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _entries(value: object) -> list[object]:
    """A YAML list as it is, a scalar as a one-item list, nothing for null."""
    if value is None:
        return []
    return list(value) if isinstance(value, list) else [value]


def _texts(value: object) -> tuple[str, ...]:
    """A list field as stripped text; an int (YAML reads an all-digit sha as one) becomes text."""
    kept: list[str] = []
    for entry in _entries(value):
        if isinstance(entry, bool):
            continue
        if isinstance(entry, int):
            kept.append(str(entry))
        elif (text := _text(entry)) is not None:
            kept.append(text)
    return tuple(kept)


def _numbers(value: object) -> tuple[int, ...]:
    """A list field of numbers (``prs``); digits given as text count, anything else is dropped."""
    kept: list[int] = []
    for entry in _entries(value):
        if isinstance(entry, bool):
            continue
        if isinstance(entry, int):
            kept.append(entry)
        elif isinstance(entry, str) and entry.strip().isascii() and entry.strip().isdigit():
            kept.append(int(entry.strip()))
    return tuple(kept)


def _iso(value: object) -> str | None:
    """YAML hands back str, date or datetime for the same field; all become ISO text."""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return _text(value)
