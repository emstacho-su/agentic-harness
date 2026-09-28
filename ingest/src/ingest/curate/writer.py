"""The curator's only file writer (SC-4, Phase C *Curator safety*).

Every note the curator produces goes through here, and here only a closed set of
paths can be written:

* ``<realm>/<collection>/{ledger,status,history}.md`` (:func:`write_curator_note`);
* ``<realm>/curation/<YYYY-MM-DD>.md`` (:func:`write_curation_report`, for C-b).

Guards, each a :class:`WriteRefused` before anything touches the disk:

* the name is one of the three, the report date a real ISO date;
* ``realm_folder`` is a realm folder of this vault, found the way the inventory
  finds them (``.realm`` markers, else ``projects``/``classes``);
* the collection passes ``check_collection_name`` and its folder already exists
  (the writer never invents a collection);
* the resolved target is inside the resolved vault, so neither ``..`` nor a
  symlink (of the collection folder or of the note itself) can lead out;
* an existing file there must carry ``captured_by: curator`` in readable
  frontmatter; anything else is someone's own note and is never overwritten;
* the frontmatter itself says ``captured_by: curator``, the matching ``type``
  and a ``generated_at``, so the next run recognises the file as its own.

**Idempotence.** When the existing file equals the new text in everything but
the ``generated_at`` line, nothing is written (``written=False``): a rerun with
nothing new leaves the file byte for byte, mtime included.

**Atomicity.** The text goes to a temporary file in the same folder, then
``os.replace`` swaps it in; a failure removes the temporary file and leaves the
old note as it was. UTF-8, LF line endings.
"""

from __future__ import annotations

import os
import re
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from ..errors import ConfigError, IngestError
from ..loaders.obsidian import discover_realms, split_frontmatter
from .inventory import LEGACY_PARENTS
from .note_records import CURATOR
from .profile import check_collection_name

NOTE_NAMES = ("ledger", "status", "history")
REPORT_TYPE = "curation-report"
REPORT_FOLDER = "curation"
GENERATED_AT = "generated_at"
REQUIRED_KEYS = ("type", "captured_by", GENERATED_AT)

_KEY = re.compile(r"^[a-z][a-z0-9_]*$")
_ISO_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class WriteRefused(IngestError):
    """The curator will not write this file; nothing was written."""


@dataclass(frozen=True)
class WriteResult:
    path: Path
    written: bool  # False when the file already said the same thing


def write_curator_note(vault_root: str | Path, realm_folder: str, collection: str, name: str,
                       frontmatter: Mapping[str, object], body: str) -> WriteResult:
    """Write ``<realm_folder>/<collection>/<name>.md``; see the module docstring for the guards."""
    if name not in NOTE_NAMES:
        raise WriteRefused(f"curator note name must be one of {NOTE_NAMES}, got {name!r}")
    try:
        check_collection_name(collection)
    except ConfigError as exc:
        raise WriteRefused(f"collection refused: {exc}") from None
    root = _vault(vault_root)
    folder = _realm(root, realm_folder) / collection
    if not folder.is_dir():
        raise WriteRefused(f"collection folder {realm_folder}/{collection} does not exist")
    _check_frontmatter(frontmatter, expected_type=name)
    return _write(root, folder / f"{name}.md", frontmatter, body)


def write_curation_report(vault_root: str | Path, realm_folder: str, day: str,
                          frontmatter: Mapping[str, object], body: str) -> WriteResult:
    """Write ``<realm_folder>/curation/<day>.md``, creating ``curation/`` if needed."""
    if not isinstance(day, str) or not _ISO_DAY.match(day):
        raise WriteRefused(f"report date must be YYYY-MM-DD, got {day!r}")
    try:
        date.fromisoformat(day)
    except ValueError:
        raise WriteRefused(f"report date {day!r} is not a calendar date") from None
    root = _vault(vault_root)
    folder = _realm(root, realm_folder) / REPORT_FOLDER
    _check_frontmatter(frontmatter, expected_type=REPORT_TYPE)
    _inside(root, folder)
    folder.mkdir(exist_ok=True)
    return _write(root, folder / f"{day}.md", frontmatter, body)


# -- guards -------------------------------------------------------------------------------------


def _vault(vault_root: str | Path) -> Path:
    root = Path(vault_root)
    if not root.is_dir():
        raise WriteRefused(f"vault {root} is not a directory")
    return root


def realm_folders(root: Path) -> tuple[str, ...]:
    """The folders that hold collections, as the inventory finds them."""
    realms = discover_realms(root)
    if realms and "" not in realms:
        return tuple(sorted(realms))
    return tuple(folder for folder in LEGACY_PARENTS if (root / folder).is_dir())


def _realm(root: Path, realm_folder: str) -> Path:
    if realm_folder not in realm_folders(root):
        raise WriteRefused(f"{realm_folder!r} is not a realm folder of this vault")
    return root / realm_folder


def _inside(root: Path, target: Path) -> Path:
    """The resolved target, refused when it is not inside the resolved vault."""
    resolved_root = root.resolve()
    resolved = target.resolve()
    if resolved != resolved_root and not resolved.is_relative_to(resolved_root):
        raise WriteRefused(f"{target.relative_to(root).as_posix()} resolves outside the vault")
    return resolved


def _check_frontmatter(frontmatter: Mapping[str, object], *, expected_type: str) -> None:
    for key, value in frontmatter.items():
        if not isinstance(key, str) or not _KEY.match(key):
            raise WriteRefused(f"frontmatter key {key!r} is not a plain lowercase key")
        if isinstance(value, bool) or not isinstance(value, (str, int)):
            raise WriteRefused(f"frontmatter value of {key!r} must be text or an integer")
    missing = [key for key in REQUIRED_KEYS if key not in frontmatter]
    if missing:
        raise WriteRefused(f"frontmatter is missing {missing}")
    if frontmatter["captured_by"] != CURATOR:
        raise WriteRefused(f"frontmatter captured_by must be '{CURATOR}'")
    if frontmatter["type"] != expected_type:
        raise WriteRefused(f"frontmatter type must be '{expected_type}', got {frontmatter['type']!r}")


def _existing(target: Path) -> str | None:
    """The existing note's text (LF), None when there is none; refused when it is not ours."""
    if not target.exists():
        return None
    if not target.is_file():
        raise WriteRefused(f"{target.name} exists and is not a file")
    try:
        raw = target.read_text(encoding="utf-8").replace("\r\n", "\n")
        fields, _ = split_frontmatter(raw, target.name)
    except (OSError, UnicodeDecodeError, IngestError):
        fields = {}
    if fields.get("captured_by") != CURATOR:
        raise WriteRefused(f"{target.name} exists and was not written by the curator; it is left alone")
    return raw


# -- the write ----------------------------------------------------------------------------------


def render_note(frontmatter: Mapping[str, object], body: str) -> str:
    """Frontmatter (single-quoted YAML scalars, in the given key order) and body, LF only."""
    lines = ["---", *(f"{key}: {_yaml_scalar(value)}" for key, value in frontmatter.items()), "---"]
    text = "\n".join(lines) + "\n" + body.replace("\r\n", "\n")
    return text if text.endswith("\n") else text + "\n"


def _yaml_scalar(value: object) -> str:
    if isinstance(value, int):
        return str(value)
    one_line = " ".join(str(value).split())
    return "'" + one_line.replace("'", "''") + "'"


def _without_generated_at(text: str) -> str:
    """``text`` minus the frontmatter's ``generated_at`` line; the body is untouched."""
    end = text.find("\n---\n", 3) if text.startswith("---\n") else -1
    if end < 0:
        return text
    head = [line for line in text[:end].split("\n") if not line.startswith(f"{GENERATED_AT}:")]
    return "\n".join(head) + text[end:]


def _write(root: Path, target: Path, frontmatter: Mapping[str, object], body: str) -> WriteResult:
    resolved = _inside(root, target)
    text = render_note(frontmatter, body)
    existing = _existing(resolved)
    if existing is not None and _without_generated_at(existing) == _without_generated_at(text):
        return WriteResult(path=target, written=False)
    handle, temp_name = tempfile.mkstemp(prefix=f".{target.stem}.", suffix=".tmp", dir=resolved.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
        os.replace(temp_name, resolved)
    except BaseException:
        _remove_quietly(Path(temp_name))
        raise
    return WriteResult(path=target, written=True)


def _remove_quietly(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:  # the original error is the one worth raising
        pass
