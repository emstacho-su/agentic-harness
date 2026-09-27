"""``uv run ingest curate <stage>`` — the curator's command line (Phase C).

    uv run ingest curate inventory --path C:/Users/you/vault
    uv run ingest curate inventory --path C:/Users/you/vault --collection agentic-harness --json
    uv run ingest curate inventory --path C:/Users/you/vault --realm classes --no-git
    uv run ingest curate extract --path C:/Users/you/vault --collection agentic-harness --dry-run
    uv run ingest curate extract --path C:/Users/you/vault --all --max-calls 10

Stages today: ``inventory`` (R-C1), read-only whatever the flags; ``--dry-run``
is accepted because the spec calls this stage's report a dry run. ``extract``
(R-C2) asks the judge about every note not yet cached and writes the cache;
with ``--dry-run`` it calls nothing, writes nothing, and prints the plan.
``ledger`` (R-C3) is registered in :data:`STAGES` by the task that builds it;
until then argparse refuses it.

Inventory: exit 0 clean, 1 a collection's session count differs from the files
in its ``sessions/`` folder, 2 could not run (bad path or filter, a hub that
cannot be read). Extract: 0 every pending note done, 1 a note failed or the run
stopped after consecutive failed batches, 2 could not run (bad arguments, vault,
store unreachable when not a dry run, a hub that cannot be read), 3 stopped by
budget. Both load the repo ``.env`` and ``~/.harness/machine.env`` first and
never print a value from either.
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

from ..config import load_db_settings
from ..envfile import load_env_file
from ..errors import ConfigError, IngestError
from . import extract, extract_report
from .extract import Budget, extractor_version, plan_extraction, run_extraction
from .inventory import GitCollector, Inventory, VaultInventory, build_inventory
from .judge import Judge
from .note_records import NoteRecord
from .profile import Runner, default_runner
from .store_models import CurateStore, Extraction, ExtractionKey

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
    _extract_parser(stages)
    # Later stages add their parsers here: `ledger` (R-C3).
    return parser


def _extract_parser(stages: argparse._SubParsersAction) -> None:
    from .claude_cli import DEFAULT_MODEL

    stage = stages.add_parser(
        "extract", help="R-C2: judge each changed note once; cache issues, decisions, ids, claims, questions"
    )
    stage.add_argument("--path", required=True, help="vault directory (C:/Users/... on Windows)")
    which = stage.add_mutually_exclusive_group(required=True)
    which.add_argument("--collection", default=None, help="only this collection (its folder name)")
    which.add_argument("--all", action="store_true", help="every collection (explicit, because it costs calls)")
    stage.add_argument("--realm", default=None, help="only this realm (name or top-level folder)")
    stage.add_argument("--model", default=DEFAULT_MODEL, help=f"judge model (default {DEFAULT_MODEL})")
    stage.add_argument("--max-calls", type=_positive_int, default=extract.DEFAULT_MAX_CALLS,
                       help=f"stop before the call that would pass this (default {extract.DEFAULT_MAX_CALLS})")
    stage.add_argument("--max-tokens", type=_positive_int, default=extract.DEFAULT_MAX_TOKENS,
                       help=f"input plus output tokens per run (default {extract.DEFAULT_MAX_TOKENS})")
    stage.add_argument("--dry-run", action="store_true", help="no judge call, no write: print the plan")
    stage.add_argument("--json", action="store_true", help="the report as JSON")
    _common(stage)


def _positive_int(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not an integer") from None
    if value < 1:
        raise argparse.ArgumentTypeError(f"must be 1 or more, got {value}")
    return value


def _common(stage: argparse.ArgumentParser) -> None:
    stage.add_argument(
        "--env-file", default=None,
        help="explicit .env path (default: nearest .env walking up); ~/.harness/machine.env follows it",
    )
    stage.add_argument("-v", "--verbose", action="store_true", help="debug logging")


def run_curate(
    argv: list[str],
    *,
    git_collector: GitCollector | None = None,
    runner: Runner | None = None,
    judge: Judge | None = None,
    store: CurateStore | None = None,
    store_factory: Callable[[], CurateStore] | None = None,
) -> int:
    """Run one stage. Every dependency is injectable for tests; without them the
    real ones are built lazily: the git collector only when git is wanted, the
    judge only when there is a call to make, the store only for ``extract``."""
    args = build_curate_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    return STAGES[args.stage](
        args, git_collector=git_collector, runner=runner or default_runner,
        judge=judge, store=store, store_factory=store_factory,
    )


def real_git_collector() -> GitCollector:
    """gitfacts.collect_git_facts with its own default runner, imported only when needed."""
    try:
        from .gitfacts import collect_git_facts
    except ImportError as exc:
        raise ConfigError(f"git facts are unavailable ({exc}); rerun with --no-git") from exc
    return lambda repo_path, repo_slug: collect_git_facts(repo_path, repo_slug)


def _run_inventory(args: argparse.Namespace, *, git_collector: GitCollector | None, runner: Runner, **_: Any) -> int:
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


# -- extract (R-C2) -----------------------------------------------------------------------

StoreFactory = Callable[[], CurateStore]


def real_judge(model: str) -> Judge:
    """``claude -p`` with ``model``, imported only when a call is about to be made."""
    from .claude_cli import ClaudeCliJudge

    return ClaudeCliJudge(model)


def real_store() -> CurateStore:
    """The ``curate`` schema over ``DATABASE_URL``; ConfigError or StoreError when unreachable."""
    from .store import PostgresCurateStore

    return PostgresCurateStore.from_settings(load_db_settings())


def _run_extract(
    args: argparse.Namespace, *, runner: Runner, judge: Judge | None, store: CurateStore | None,
    store_factory: StoreFactory | None, **_: Any,
) -> int:
    try:
        load_env_file(Path(args.env_file) if args.env_file else None)
        budget = Budget(args.max_calls, args.max_tokens)
        found = build_inventory(args.path, realm=args.realm, collection=args.collection,
                                git_collector=None, runner=runner)
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return extract.EXIT_UNAVAILABLE
    for item in found.errors:
        print(f"error: {item.path}: {item.reason}", file=sys.stderr)

    run = _extract_dry_run if args.dry_run else _extract_live
    code = run(args, found, budget, judge=judge, store=store, store_factory=store_factory or real_store)
    return extract.EXIT_UNAVAILABLE if found.errors else code


def _extract_dry_run(args: argparse.Namespace, found: VaultInventory, budget: Budget, *,
                     judge: Judge | None, store: CurateStore | None, store_factory: StoreFactory) -> int:
    """Plan only: never a judge call or a write. The store is read for cache hits
    when it can be; when it cannot, that is said on stderr and every note is a miss."""
    owned = None
    if store is None:
        try:
            store = owned = store_factory()
        except IngestError as exc:
            print(f"note: no cache lookup ({exc}); every note is planned as a miss", file=sys.stderr)
    try:
        plan = plan_extraction(found.collections, _ReadOnlyCache(store), extractor_version())
    finally:
        _close(owned)
    if args.json:
        print(json.dumps(extract_report.plan_json(plan, budget), indent=2))
    else:
        print(extract_report.plan_text(plan, budget))
    return extract.EXIT_DONE


def _extract_live(args: argparse.Namespace, found: VaultInventory, budget: Budget, *,
                  judge: Judge | None, store: CurateStore | None, store_factory: StoreFactory) -> int:
    owned = None
    try:
        if store is None:
            store = owned = store_factory()
        version = extractor_version()
        plan = plan_extraction(found.collections, store.get_extractions, version)
        if judge is None and plan.calls:
            judge = real_judge(args.model)
        report = run_extraction(plan, judge, store, budget, version=version)
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return extract.EXIT_UNAVAILABLE
    finally:
        _close(owned)
    if args.json:
        print(json.dumps(extract_report.run_json(report), indent=2))
    else:
        print(extract_report.run_text(report))
    return report.exit_code


class _ReadOnlyCache:
    """A dry run's cache lookup: a failure is reported once, then every note is a miss."""

    def __init__(self, store: CurateStore | None) -> None:
        self._store = store

    def __call__(self, keys: list[ExtractionKey]) -> dict[ExtractionKey, Extraction]:
        if self._store is None:
            return {}
        try:
            return self._store.get_extractions(keys)
        except IngestError as exc:
            print(f"note: cache lookup failed ({exc}); every note is planned as a miss", file=sys.stderr)
            self._store = None
            return {}


def _close(store: CurateStore | None) -> None:
    if store is not None:
        store.close()


# Stage name -> handler(args, **dependencies). Later stages register here.
STAGES: dict[str, Callable[..., int]] = {"inventory": _run_inventory, "extract": _run_extract}


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
