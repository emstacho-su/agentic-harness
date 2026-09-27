"""A collection's curator profile, read from its hub note (Phase C, *One trajectory*).

The hub is ``<realm>/<collection>/<collection>.md`` with ``type: index`` (SC-3).
The curator reads four optional fields from it:

* ``kind: project | class`` — which prompts and rubrics apply. Absent, it falls
  back to the realm folder: ``projects`` -> project, ``classes`` -> class. Any
  other realm needs an explicit ``kind``; guessing would pick the wrong rubric.
* ``plan_sources:`` — a list (or one string) of vault-relative notes or absolute
  repo files or folders. Each is kept exactly as given, resolved, and its
  existence reported; a folder (bb2dash's ``docs/planning/``) stands for the
  ``*.md`` files directly in it (see plan.py).
* ``repo:`` — the GitHub ``owner/name`` slug. Absent, the most frequent valid
  ``repo:`` among the collection's session notes.
* ``repo_path:`` — the local checkout. Absent, the most frequent session ``cwd``
  that still exists and is inside a git repo, mapped to that repo's toplevel by
  ``git -C <cwd> rev-parse --show-toplevel``. The runner is injectable: tests
  never shell out.

``CollectionProfile.explicit`` names which of those four the hub set (a key with
a non-null value), so the inventory can warn about a fallback nobody chose.

A bad field raises :class:`SourceError` naming the hub; the inventory turns that
into an error for this one collection.
"""

from __future__ import annotations

import re
import subprocess
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from ..errors import ConfigError, IngestError, SourceError
from ..loaders.obsidian import split_frontmatter

KIND_PROJECT = "project"
KIND_CLASS = "class"
KINDS = (KIND_PROJECT, KIND_CLASS)

# The realm folders whose kind is implied when a hub does not say.
REALM_FOLDER_KINDS = {"projects": KIND_PROJECT, "classes": KIND_CLASS}

HUB_TYPE = "index"

# The hub fields the curator reads, in the order ``CollectionProfile.explicit`` lists them.
HUB_FIELDS = ("kind", "plan_sources", "repo", "repo_path")

# Collection names that may be joined into a path. Spaces are allowed because
# historical collections carry them ("wa2 final"); separators and dots are not.
COLLECTION_NAME = re.compile(r"^[a-z0-9][a-z0-9 _-]*$")

REPO_SLUG = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")

GIT_TIMEOUT_SECONDS = 20

# (args, cwd) -> stdout; raises IngestError when the command fails. The same
# shape as gitfacts' runner, so one fake can serve both.
Runner = Callable[[Sequence[str], "Path | None"], str]


@dataclass(frozen=True)
class PlanSource:
    """One ``plan_sources`` entry: as written, where it points, and whether it is there.

    ``exists`` is True for a file or a directory; ``is_dir`` tells them apart.
    """

    given: str
    resolved: str
    exists: bool
    is_dir: bool = False


@dataclass(frozen=True)
class SessionHint:
    """The two session-note fields the profile falls back on."""

    cwd: str | None
    repo: str | None


@dataclass(frozen=True)
class CollectionProfile:
    realm: str | None
    collection: str
    kind: str
    plan_sources: tuple[PlanSource, ...]
    repo: str | None
    repo_path: str | None
    hub_path: str | None  # vault-relative posix path, None when the collection has no hub
    explicit: tuple[str, ...] = ()  # which of HUB_FIELDS the hub set; () without a hub


def check_collection_name(name: str) -> str:
    """Return ``name`` if it may be used to build a path, else raise ConfigError."""
    if not isinstance(name, str) or not COLLECTION_NAME.match(name):
        raise ConfigError(
            f"{name!r} is not an allowed collection name (lowercase letters, digits, spaces, '_' and '-')"
        )
    return name


def hub_file(collection_dir: Path) -> Path:
    """``<collection>/<collection>.md`` — SC-3's hub filename."""
    return collection_dir / f"{collection_dir.name}.md"


def default_runner(args: Sequence[str], cwd: Path | None = None) -> str:
    """Run a command and return its stdout; any failure is a SourceError."""
    try:
        completed = subprocess.run(
            list(args), cwd=cwd, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=GIT_TIMEOUT_SECONDS, check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise SourceError(f"{args[0]} could not run ({exc})") from exc
    if completed.returncode != 0:
        raise SourceError(f"{args[0]} exited {completed.returncode}: {completed.stderr.strip()[:200]}")
    return completed.stdout


def build_profile(
    *,
    vault: Path,
    realm: str | None,
    realm_folder: str,
    collection: str,
    collection_dir: Path,
    hints: Sequence[SessionHint],
    runner: Runner = default_runner,
) -> CollectionProfile:
    """Read the hub (if any) and fill every absent field from its fallback."""
    hub = hub_file(collection_dir)
    hub_path = hub.relative_to(vault).as_posix() if hub.is_file() else None
    fields = _read_hub(hub, hub_path) if hub_path else {}

    repo_path = _optional_text(fields, "repo_path", hub_path)
    return CollectionProfile(
        realm=realm,
        collection=collection,
        kind=_kind(fields.get("kind"), realm_folder, hub_path or collection_dir.as_posix()),
        plan_sources=tuple(_resolve(vault, given) for given in _plan_sources(fields.get("plan_sources"), hub_path)),
        repo=_repo(fields, hub_path) or most_frequent_repo(hints),
        repo_path=repo_path or derive_repo_path(hints, runner),
        hub_path=hub_path,
        explicit=tuple(name for name in HUB_FIELDS if fields.get(name) is not None),
    )


def _read_hub(hub: Path, hub_path: str) -> dict[str, Any]:
    try:
        raw = hub.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise SourceError(f"{hub_path}: unreadable ({exc})") from exc
    try:
        fields, _ = split_frontmatter(raw, hub_path)
    except SourceError as exc:
        raise SourceError(f"{hub_path}: {exc}") from exc
    if fields.get("type") != HUB_TYPE:
        raise SourceError(f"{hub_path}: is not a hub (frontmatter type is {fields.get('type')!r}, not '{HUB_TYPE}')")
    return fields


def _kind(raw: object, realm_folder: str, where: str) -> str:
    if raw is None:
        fallback = REALM_FOLDER_KINDS.get(realm_folder)
        if fallback is None:
            raise SourceError(
                f"{where}: no kind in the hub and realm folder '{realm_folder}' implies none; "
                "add 'kind: project' or 'kind: class'"
            )
        return fallback
    if raw not in KINDS:
        raise SourceError(f"{where}: kind must be 'project' or 'class', got {raw!r}")
    return str(raw)


def _plan_sources(raw: object, hub_path: str | None) -> tuple[str, ...]:
    if raw is None:
        return ()
    items = [raw] if isinstance(raw, str) else raw
    if not isinstance(items, list) or not all(isinstance(item, str) for item in items):
        raise SourceError(f"{hub_path}: plan_sources must be a list of strings, got {raw!r}")
    return tuple(item.strip() for item in items if item.strip())


def _resolve(vault: Path, given: str) -> PlanSource:
    """An absolute path is a repo file or folder; anything else is a vault note or folder.

    A vault path without a suffix is a folder when one is there, else a note
    (``.md`` appended), wikilink or not.
    """
    target = _unlink(given)
    candidate = Path(target)
    if not candidate.is_absolute():
        candidate = vault / target
        if not candidate.suffix and not _is_dir(candidate):
            candidate = candidate.with_name(candidate.name + ".md")
    is_dir = _is_dir(candidate)
    return PlanSource(
        given=given, resolved=candidate.as_posix(), exists=is_dir or _is_file(candidate), is_dir=is_dir,
    )


def _unlink(given: str) -> str:
    """``[[path|alias]]`` -> ``path``; anything else unchanged."""
    if given.startswith("[[") and given.endswith("]]"):
        return given[2:-2].split("|", 1)[0].split("#", 1)[0].strip()
    return given


def _is_file(path: Path) -> bool:
    try:
        return path.is_file()
    except (OSError, ValueError):
        return False


def _is_dir(path: Path) -> bool:
    try:
        return path.is_dir()
    except (OSError, ValueError):
        return False


def _optional_text(fields: dict[str, Any], key: str, hub_path: str | None) -> str | None:
    raw = fields.get(key)
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise SourceError(f"{hub_path}: {key} must be a string, got {raw!r}")
    return raw.strip() or None


def _repo(fields: dict[str, Any], hub_path: str | None) -> str | None:
    slug = _optional_text(fields, "repo", hub_path)
    if slug is not None and not REPO_SLUG.match(slug):
        raise SourceError(f"{hub_path}: repo must be an owner/name slug, got {slug!r}")
    return slug


def _ranked(values: Iterable[str]) -> list[str]:
    """Distinct values, most frequent first; ties by value so the order is stable."""
    counts = Counter(values)
    return sorted(counts, key=lambda value: (-counts[value], value))


def most_frequent_repo(hints: Sequence[SessionHint]) -> str | None:
    slugs = [h.repo.strip() for h in hints if isinstance(h.repo, str) and REPO_SLUG.match(h.repo.strip())]
    ranked = _ranked(slugs)
    return ranked[0] if ranked else None


def derive_repo_path(hints: Sequence[SessionHint], runner: Runner) -> str | None:
    """The toplevel of the most frequent session cwd that exists and is in a git repo."""
    cwds = [h.cwd.strip() for h in hints if isinstance(h.cwd, str) and h.cwd.strip()]
    for cwd in _ranked(cwds):
        if not _is_dir(Path(cwd)):
            continue
        try:
            toplevel = runner(["git", "-C", cwd, "rev-parse", "--show-toplevel"], None).strip()
        except IngestError:
            continue  # not a git repo, or git is missing: try the next cwd
        if toplevel:
            return Path(toplevel).as_posix()
    return None
