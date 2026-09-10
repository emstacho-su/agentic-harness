"""``uv run export-materials`` — bb2dash class materials into the vault.

    uv run export-materials --env-file C:/Users/you/projects/bb2dash/.env \
        --vault "C:/Users/you/OneDrive - Syracuse University/vault" [--dry-run] [--course IST.323]

``--env-file`` is required and is read directly, never merged into the process
environment: the harness repo has its own ``.env`` pointing at harness-memory,
and picking that up by accident must be impossible. The URL is checked against
the bb2dash project ref before any request is made.
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import ENV_SUPABASE_SERVICE_ROLE, ENV_SUPABASE_URL
from ..envfile import parse_env_file
from ..errors import ConfigError, IngestError, SourceError
from .client import assert_bb2dash_url, fetch_materials
from .render import MaterialNote, PlannedNotes, collection_for_course, plan_notes

log = logging.getLogger("export-materials")

Fetch = Callable[..., list[dict[str, Any]]]


@dataclass(frozen=True)
class WriteStats:
    created: int = 0
    updated: int = 0
    unchanged: int = 0

    def bump(self, field: str) -> "WriteStats":
        return WriteStats(**{**self.__dict__, field: getattr(self, field) + 1})


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="export-materials",
        description="Export bb2dash class materials as ingest-excluded vault notes.",
    )
    parser.add_argument(
        "--env-file", required=True, help="the bb2dash .env (SUPABASE_URL + SUPABASE_SERVICE_ROLE)"
    )
    parser.add_argument("--vault", required=True, help="vault root; C:/Users/... on Windows")
    parser.add_argument("--course", default=None, help="one bb2dash course id, e.g. IST.323")
    parser.add_argument("--dry-run", action="store_true", help="plan and report; write nothing")
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return parser


def main(argv: Sequence[str] | None = None, *, fetch: Fetch | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    try:
        return _run(args, fetch or fetch_materials)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


def _run(args: argparse.Namespace, fetch: Fetch) -> int:
    base_url, service_role = _read_credentials(Path(args.env_file))
    vault = Path(args.vault).expanduser()
    course = _validate_course(args.course)

    rows = fetch(base_url, service_role, course=course)
    if course and not rows:
        # PostgREST `eq.` is case-sensitive; an empty match is a mistake, not a result.
        raise SourceError(f"no bb2dash files for course '{course}' (ids look like IST.323)")

    planned = plan_notes(rows)
    stats = write_notes(vault, planned.notes, dry_run=args.dry_run)
    _report(planned, stats, dry_run=args.dry_run)
    return 0


def _validate_course(course: str | None) -> str | None:
    if course is None:
        return None
    try:
        collection_for_course(course)
    except SourceError as exc:
        raise ConfigError(f"--course: {exc} (expected the exact bb2dash id, e.g. IST.323)") from exc
    return course


def _read_credentials(env_file: Path) -> tuple[str, str]:
    if not env_file.is_file():
        raise ConfigError(f"env file does not exist: {env_file}")
    try:
        values = parse_env_file(env_file.read_text(encoding="utf-8"), origin=env_file.as_posix())
    except OSError as exc:
        raise ConfigError(f"could not read {env_file}: {exc}") from exc

    base_url = assert_bb2dash_url(values.get(ENV_SUPABASE_URL))
    service_role = (values.get(ENV_SUPABASE_SERVICE_ROLE) or "").strip()
    if not service_role:
        raise ConfigError(f"{ENV_SUPABASE_SERVICE_ROLE} is missing from {env_file}")
    return base_url, service_role


def write_notes(vault_root: Path, notes: Sequence[MaterialNote], *, dry_run: bool) -> WriteStats:
    """Write each note only if its content differs. Idempotent by construction."""
    if not vault_root.is_dir():
        raise ConfigError(f"vault root is not a directory: {vault_root}")

    stats = WriteStats()
    for note in notes:
        target = vault_root / note.relative_path
        existing = _read_existing(target)
        if existing == note.content:
            stats = stats.bump("unchanged")
            continue
        stats = stats.bump("created" if existing is None else "updated")
        log.debug("%s %s", "would write" if dry_run else "writing", note.relative_path)
        if not dry_run:
            _write(target, note.content)
    return stats


def _read_existing(target: Path) -> str | None:
    if not target.exists():
        return None
    try:
        return target.read_text(encoding="utf-8").replace("\r\n", "\n")
    except (OSError, UnicodeDecodeError) as exc:
        raise ConfigError(f"cannot read existing note {target}: {exc}") from exc


def _write(target: Path, content: str) -> None:
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="\n")
    except OSError as exc:
        raise ConfigError(f"cannot write {target}: {exc}") from exc


def _report(planned: PlannedNotes, stats: WriteStats, *, dry_run: bool) -> None:
    print("--- dry run, nothing written ---" if dry_run else "--- export complete ---")
    print(f"  {len(planned.notes):5}  notes planned")
    print(f"  {stats.created:5}  created")
    print(f"  {stats.updated:5}  updated")
    print(f"  {stats.unchanged:5}  unchanged")
    if planned.skipped:
        print(f"Skipped {len(planned.skipped)} file(s):")
        for record in planned.skipped:
            print(f"  {record.external_id}: {record.reason}")


__all__ = ["main", "build_parser", "write_notes", "WriteStats"]
