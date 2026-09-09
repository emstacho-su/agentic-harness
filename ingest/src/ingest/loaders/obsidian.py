"""Obsidian vault loader.

Walks a vault directory for markdown, splits YAML frontmatter from the body, and
emits one :class:`SourceDocument` per note.

* ``source``      = ``obsidian``
* ``external_id`` = the note's frontmatter ``id:`` when it has one, else the
  vault-relative POSIX path (``notes/ideas/rag.md``), so a note keeps the same
  identity whether it is ingested from Windows or WSL.

  Prefer an ``id:`` in notes you expect to move. With a path-based key a rename
  is indistinguishable from delete-plus-create: the old row is stranded and a
  duplicate appears. A stable ``id:`` survives the rename.
* ``agent``       = ``claude-code``
* ``metadata``    = the frontmatter verbatim, plus an ``_ingest`` sub-object.
  Ingest-added keys are nested under ``_ingest`` so they can never collide with
  a user's own frontmatter key named ``path`` or ``source``.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import DEFAULT_AGENT, SOURCE_OBSIDIAN
from ..errors import SourceError
from ..jsonutil import json_safe
from ..models import SourceDocument
from .base import LoadedSource, SkippedRecord

log = logging.getLogger(__name__)

MARKDOWN_SUFFIXES = (".md", ".markdown", ".mdx")

# Obsidian's own state, VCS metadata and dependency trees are not notes.
SKIP_DIRECTORIES = frozenset(
    {".obsidian", ".trash", ".git", ".github", "node_modules", ".venv", "__pycache__"}
)

_H1 = re.compile(r"^\s{0,3}#\s+(.+?)\s*#*\s*$", re.MULTILINE)

# Frontmatter key that overrides the path-based identity.
ID_KEY = "id"
MAX_ID_LENGTH = 512


def load_vault(vault_path: str | Path) -> LoadedSource:
    """Load every markdown note under ``vault_path``."""
    root = Path(vault_path).expanduser()
    if not root.exists():
        raise SourceError(f"Vault path does not exist: {root}")
    if not root.is_dir():
        raise SourceError(f"Vault path is not a directory: {root}")

    documents: list[SourceDocument] = []
    skipped: list[SkippedRecord] = []
    claimed_by: dict[str, str] = {}

    for path in sorted(_iter_markdown(root)):
        relative = path.relative_to(root).as_posix()
        try:
            document = _load_note(path, relative)
        except SourceError as exc:
            log.warning("Skipping %s: %s", relative, exc)
            skipped.append(SkippedRecord(relative, str(exc)))
            continue

        if document is None:
            skipped.append(SkippedRecord(relative, "empty body"))
            continue

        owner = claimed_by.get(document.external_id)
        if owner is not None:
            # Two notes claiming one id would silently overwrite each other
            # through the (source, external_id) upsert key. Refuse the second.
            reason = f"duplicate external_id '{document.external_id}', already used by {owner}"
            log.warning("Skipping %s: %s", relative, reason)
            skipped.append(SkippedRecord(relative, reason))
            continue

        claimed_by[document.external_id] = relative
        documents.append(document)

    notes = (f"vault root: {root.as_posix()}",)
    return LoadedSource(tuple(documents), tuple(skipped), notes)


def _iter_markdown(root: Path):
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() not in MARKDOWN_SUFFIXES:
            continue
        if any(part in SKIP_DIRECTORIES for part in path.relative_to(root).parts[:-1]):
            continue
        yield path


def _load_note(path: Path, relative: str) -> SourceDocument | None:
    try:
        raw = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise SourceError(f"not valid UTF-8 ({exc.reason})") from exc
    except OSError as exc:
        raise SourceError(f"unreadable ({exc})") from exc

    frontmatter, body = split_frontmatter(raw, relative)
    if not body.strip():
        return None

    external_id = _derive_external_id(frontmatter, relative)

    stat = path.stat()
    ingest_meta: dict[str, Any] = {
        "loader": "obsidian",
        "path": relative,
        "id_source": "frontmatter" if external_id != relative else "path",
        "filename": path.name,
        "folder": str(Path(relative).parent.as_posix()),
        "modified_at": datetime.fromtimestamp(
            stat.st_mtime, tz=timezone.utc
        ).isoformat(),
        "bytes": stat.st_size,
    }

    metadata = {**json_safe(frontmatter), "_ingest": ingest_meta}
    return SourceDocument(
        source=SOURCE_OBSIDIAN,
        external_id=external_id,
        body=body,
        title=_derive_title(frontmatter, body, path),
        agent=DEFAULT_AGENT,
        collection=_derive_collection(frontmatter, relative),
        metadata=metadata,
    )


def _derive_collection(frontmatter: dict, relative: str) -> str | None:
    """Which project or class this note belongs to.

    The vault is laid out ``projects/<name>/...`` and ``classes/<code>/...``, so
    the second path segment is the collection. Frontmatter ``collection:`` wins
    when present, which is the escape hatch for notes that live somewhere the
    folder structure does not describe.

    Returns ``None`` for a note at the vault root rather than inventing a name —
    an unfiltered document is honest; a wrongly-labelled one is not.
    """
    explicit = frontmatter.get("collection")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()

    parts = [p for p in relative.split("/") if p]
    if len(parts) < 2:
        return None
    if parts[0] in {"projects", "classes"} and len(parts) >= 3:
        return parts[1]
    return parts[0]


def split_frontmatter(raw: str, external_id: str = "<note>") -> tuple[dict, str]:
    """Return ``(frontmatter, body)``.

    Delegates to ``python-frontmatter``. A note whose YAML is malformed raises —
    it is a real error the user should fix, not something to paper over — but the
    caller downgrades it to a skip so one bad note cannot abort a vault ingest.
    """
    if not isinstance(raw, str):
        raise TypeError(f"raw must be str, got {type(raw).__name__}")

    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    if not text.lstrip().startswith("---"):
        return {}, text

    try:
        import frontmatter as fm
    except ImportError as exc:  # pragma: no cover - install-time problem
        raise SourceError("python-frontmatter is not installed; run `uv sync`") from exc

    try:
        post = fm.loads(text)
    except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
        raise SourceError(f"malformed YAML frontmatter ({exc})") from exc

    metadata = dict(post.metadata) if isinstance(post.metadata, dict) else {}
    return metadata, post.content


def _derive_external_id(frontmatter: dict, relative: str) -> str:
    """Frontmatter ``id:`` wins over the path, if it is a usable scalar.

    A missing or blank ``id:`` falls back to the path rather than failing —
    adding an id later is a legitimate migration, and refusing the note would
    lose content over a formatting detail. A *structurally* wrong id (a list, a
    mapping, a multi-line block) is a real mistake and does fail.
    """
    raw = frontmatter.get(ID_KEY)
    if raw is None:
        return relative
    if isinstance(raw, bool) or isinstance(raw, (list, dict, set, tuple)):
        raise SourceError(f"frontmatter '{ID_KEY}' must be a scalar, got {type(raw).__name__}")

    text = str(raw).strip()
    if not text:
        return relative
    if len(text) > MAX_ID_LENGTH:
        raise SourceError(f"frontmatter '{ID_KEY}' is longer than {MAX_ID_LENGTH} characters")
    if any(char in text for char in "\r\n\t"):
        raise SourceError(f"frontmatter '{ID_KEY}' contains a line break or tab")
    return text


def _derive_title(frontmatter: dict, body: str, path: Path) -> str:
    """Frontmatter ``title`` wins, then the first H1, then the filename."""
    candidate = frontmatter.get("title")
    if isinstance(candidate, str) and candidate.strip():
        return candidate.strip()

    match = _H1.search(body)
    if match:
        return match.group(1).strip()

    return path.stem
