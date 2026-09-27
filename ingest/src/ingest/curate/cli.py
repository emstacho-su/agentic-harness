"""``uv run ingest curate <stage>`` — the curator's command line (Phase C).

    uv run ingest curate inventory --path C:/Users/you/vault
    uv run ingest curate inventory --path C:/Users/you/vault --collection agentic-harness --json
    uv run ingest curate inventory --path C:/Users/you/vault --realm classes --no-git

Stages today: ``inventory`` (R-C1), read-only whatever the flags; ``--dry-run``
is accepted because the spec calls this stage's report a dry run. ``extract``
(R-C2) and ``ledger`` (R-C3) are registered in :data:`STAGES` by the tasks that
build them; until then argparse refuses them.

Exit 0 clean, 1 a collection's session count differs from the files in its
``sessions/`` folder, 2 could not run (bad path or filter, a hub that cannot be
read). Like verify it loads the repo ``.env`` and ``~/.harness/machine.env``
first and never prints a value from either.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Callable

from ..envfile import load_env_file
from ..errors import ConfigError, IngestError
from .inventory import GitCollector, Inventory, VaultInventory, build_inventory
from .note_records import NoteRecord
from .profile import Runner, default_runner

SUBCOMMAND = "curate"

EXIT_CLEAN = 0
EXIT_MISMATCH = 1
EXIT_UNAVAILABLE = 2


def build_curate_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=f"ingest {SUBCOMMAND}",
        description="The read-only curator. Exit 0 clean, 1 findings, 2 could not run.",
    )
    stages = parser.add_subparsers(dest="stage", required=True)
    inventory = stages.add_parser(
        "inventory", help="R-C1: per collection, sessions with subagents, plan sources and git facts"
    )
    inventory.add_argument("--path", required=True, help="vault directory (C:/Users/... on Windows)")
    inventory.add_argument("--realm", default=None, help="only this realm (name or top-level folder)")
    inventory.add_argument("--collection", default=None, help="only this collection (its folder name)")
    inventory.add_argument("--json", action="store_true", help="the full inventory as JSON, without note bodies")
    inventory.add_argument("--no-git", action="store_true", help="skip git and gh; git facts are null")
    inventory.add_argument("--dry-run", action="store_true", help="accepted; the inventory never writes")
    _common(inventory)
    # Later stages add their parsers here: `extract` (R-C2), then `ledger` (R-C3).
    return parser


def _common(stage: argparse.ArgumentParser) -> None:
    stage.add_argument(
        "--env-file", default=None,
        help="explicit .env path (default: nearest .env walking up); ~/.harness/machine.env follows it",
    )
    stage.add_argument("-v", "--verbose", action="store_true", help="debug logging")


def run_curate(argv: list[str], *, git_collector: GitCollector | None = None, runner: Runner | None = None) -> int:
    """Run one stage. ``git_collector`` and ``runner`` are injectable for tests;
    without them the real ones are built, the git collector only when git is wanted."""
    args = build_curate_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    return STAGES[args.stage](args, git_collector=git_collector, runner=runner or default_runner)


def real_git_collector() -> GitCollector:
    """gitfacts.collect_git_facts with its own default runner, imported only when needed."""
    try:
        from .gitfacts import collect_git_facts
    except ImportError as exc:
        raise ConfigError(f"git facts are unavailable ({exc}); rerun with --no-git") from exc
    return lambda repo_path, repo_slug: collect_git_facts(repo_path, repo_slug)


def _run_inventory(args: argparse.Namespace, *, git_collector: GitCollector | None, runner: Runner) -> int:
    try:
        load_env_file(Path(args.env_file) if args.env_file else None)
        collector = None if args.no_git else (git_collector or real_git_collector())
        result = build_inventory(
            args.path, realm=args.realm, collection=args.collection, git_collector=collector, runner=runner
        )
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_UNAVAILABLE
    except Exception as exc:  # noqa: BLE001 - exit 1 would read as "mismatch"
        print(f"error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_UNAVAILABLE

    print(json.dumps(as_json(result), indent=2, default=str) if args.json else as_text(result, git_off=args.no_git))
    if result.errors:
        return EXIT_UNAVAILABLE
    return EXIT_MISMATCH if result.mismatched else EXIT_CLEAN


# Stage name -> handler(args, *, git_collector, runner). Later stages register here.
STAGES: dict[str, Callable[..., int]] = {"inventory": _run_inventory}


# -- the text report ---------------------------------------------------------------------


def as_text(result: VaultInventory, *, git_off: bool = False) -> str:
    lines = [f"vault {result.root}; {len(result.collections)} collection(s)"]
    for inventory in result.collections:
        lines.append(_count_line(inventory, git_off))
        lines.extend(f"    warning: {warning}" for warning in inventory.warnings)
        lines.extend(f"    git warning: {warning}" for warning in _field(inventory.git, "warnings") or ())
        if not inventory.counts.matches:
            lines.append(
                f"finding: {inventory.folder}: {inventory.counts.session_notes} session notes inventoried, "
                f"{inventory.counts.raw_session_files} files in sessions/"
            )
    lines.extend(f"    ignored: {item.path} ({item.reason})" for item in result.ignored)
    lines.extend(f"error: {item.path}: {item.reason}" for item in result.errors)
    lines.append(_last_line(result))
    return "\n".join(lines)


def _count_line(inventory: Inventory, git_off: bool) -> str:
    c = inventory.counts
    return (
        f"{inventory.folder}  {inventory.profile.kind}  sessions {c.main_sessions}  subagents {c.subagents}  "
        f"raw {c.raw_session_files}  sdk {c.sdk_notes}  notes {c.notes}  decisions {c.decisions}  "
        f"skipped {c.skipped}  excluded {c.excluded}  git: {_git_summary(inventory.git, git_off)}"
    )


def _git_summary(git: Any, git_off: bool) -> str:
    if git is None:
        return "off" if git_off else "none"
    commits, prs = _field(git, "commits"), _field(git, "prs")
    if commits is None or prs is None:
        return "collected"
    return f"{len(commits)} commits, {len(prs)} PRs"


def _field(value: Any, name: str) -> Any:
    return value.get(name) if isinstance(value, dict) else getattr(value, name, None)


def _last_line(result: VaultInventory) -> str:
    problems = []
    if result.mismatched:
        problems.append(f"{len(result.mismatched)} collection(s) mismatch")
    if result.errors:
        problems.append(f"{len(result.errors)} collection(s) could not be read")
    if problems:
        return "inventory: " + "; ".join(problems)
    return f"inventory: clean ({len(result.collections)} collections)"


# -- the JSON report ---------------------------------------------------------------------


def as_json(result: VaultInventory) -> dict[str, Any]:
    return {
        "vault": result.root,
        "clean": not result.mismatched and not result.errors,
        "collections": [_collection_json(inventory) for inventory in result.collections],
        "ignored": [dataclasses.asdict(item) for item in result.ignored],
        "errors": [dataclasses.asdict(item) for item in result.errors],
    }


def _collection_json(inventory: Inventory) -> dict[str, Any]:
    return {
        "realm": inventory.profile.realm,
        "collection": inventory.profile.collection,
        "folder": inventory.folder,
        "profile": dataclasses.asdict(inventory.profile),
        "counts": {**dataclasses.asdict(inventory.counts), "session_notes": inventory.counts.session_notes},
        "matches": inventory.counts.matches,
        "timeline": [
            {"session": _record_json(group.session), "subagents": [_record_json(s) for s in group.subagents]}
            for group in inventory.sessions
        ],
        "orphans": [
            {"parent_session_id": group.parent_session_id, "subagents": [_record_json(s) for s in group.subagents]}
            for group in inventory.orphans
        ],
        "notes": [_record_json(record) for record in inventory.notes],
        "decisions": [_record_json(record) for record in inventory.decisions],
        "skipped": [dataclasses.asdict(item) for item in inventory.skipped],
        "excluded": dict(sorted(Counter(item.reason for item in inventory.excluded).items())),
        "git": _git_json(inventory.git),
        "warnings": list(inventory.warnings),
    }


def _record_json(record: NoteRecord) -> dict[str, Any]:
    """Every field but the body: bodies are large, and the hash identifies them."""
    return {key: value for key, value in dataclasses.asdict(record).items() if key != "body"}


def _git_json(git: Any) -> Any:
    if git is None or isinstance(git, (dict, list, str)):
        return git
    if dataclasses.is_dataclass(git) and not isinstance(git, type):
        return dataclasses.asdict(git)
    return str(git)
