"""``uv run ingest curate <stage>`` — the curator's command line (Phase C).

    uv run ingest curate inventory --path C:/Users/you/vault
    uv run ingest curate inventory --path C:/Users/you/vault --collection agentic-harness --json
    uv run ingest curate inventory --path C:/Users/you/vault --realm classes --no-git
    uv run ingest curate extract --path C:/Users/you/vault --collection agentic-harness --dry-run
    uv run ingest curate extract --path C:/Users/you/vault --all --max-calls 10
    uv run ingest curate ledger --path C:/Users/you/vault --collection agentic-harness --dry-run

Stages: ``inventory`` (R-C1), read-only whatever the flags; ``--dry-run`` is
accepted because the spec calls this stage's report a dry run. ``extract``
(R-C2) asks the judge about every note not yet cached and writes the cache;
with ``--dry-run`` it calls nothing, writes nothing, and prints the plan.
``ledger`` (R-C3) clusters the cached issue items into issues, appends their
events and writes ``<realm>/<collection>/ledger.md``; with ``--dry-run`` the
store is only read, no judge is called and no file is written.

Inventory: exit 0 clean, 1 a collection's session count differs from the files
in its ``sessions/`` folder, 2 could not run (bad path or filter, a hub that
cannot be read). Extract: 0 every pending note done, 1 a note failed or the run
stopped after consecutive failed batches, 2 could not run (bad arguments, vault,
store unreachable when not a dry run, a hub that cannot be read), 3 stopped by
budget. Ledger: 0 done, 1 an item could not be placed (no date, a failed judge
call, or the run stopped after consecutive failures), 2 could not run (bad
arguments, vault, the store unreachable even for a dry run, a ledger.md the
curator may not overwrite), 3 stopped by budget. Every stage loads the repo
``.env`` and ``~/.harness/machine.env`` first and never prints a value from either.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from ..config import load_db_settings
from ..envfile import load_env_file
from ..errors import ConfigError, IngestError
from . import extract, extract_report, ledger
from .extract import Budget, extractor_version, plan_extraction, run_extraction
from .inventory import GitCollector, Inventory, VaultInventory, build_inventory
from .judge import Judge
from .ledger import CollectionLedger, DryRunStore, Spend, build_ledger
from .render import ledger_body, ledger_frontmatter
from .note_records import NoteRecord
from .profile import Runner, default_runner
from .store_models import ISSUE_STATES, CurateStore, Extraction, ExtractionKey, to_utc_iso
from .writer import WriteResult, write_curator_note

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
    _ledger_parser(stages)
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


def _ledger_parser(stages: argparse._SubParsersAction) -> None:
    from .claude_cli import DEFAULT_MODEL

    stage = stages.add_parser(
        "ledger", help="R-C3: cluster issues across notes, record their events, write ledger.md"
    )
    stage.add_argument("--path", required=True, help="vault directory (C:/Users/... on Windows)")
    which = stage.add_mutually_exclusive_group(required=True)
    which.add_argument("--collection", default=None, help="only this collection (its folder name)")
    which.add_argument("--all", action="store_true", help="every collection (explicit, because it costs calls)")
    stage.add_argument("--realm", default=None, help="only this realm (name or top-level folder)")
    stage.add_argument("--model", default=DEFAULT_MODEL, help=f"judge model (default {DEFAULT_MODEL})")
    stage.add_argument("--max-calls", type=_positive_int, default=ledger.DEFAULT_MAX_CALLS,
                       help=f"confirmation calls per run (default {ledger.DEFAULT_MAX_CALLS})")
    stage.add_argument("--max-tokens", type=_positive_int, default=ledger.DEFAULT_MAX_TOKENS,
                       help=f"input plus output tokens per run (default {ledger.DEFAULT_MAX_TOKENS})")
    stage.add_argument("--no-git", action="store_true", help="skip git and gh: no commit or PR events")
    stage.add_argument("--dry-run", action="store_true",
                       help="read the store only, call no judge, write no file: print what would change")
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
    embedder: Any = None,
    clock: Callable[[], datetime] | None = None,
) -> int:
    """Run one stage. Every dependency is injectable for tests; without them the
    real ones are built lazily: the git collector only when git is wanted, the
    judge only when there is a call to make, the store only for ``extract`` and
    ``ledger``, the embedder only when there is an item to embed."""
    args = build_curate_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    return STAGES[args.stage](
        args, git_collector=git_collector, runner=runner or default_runner,
        judge=judge, store=store, store_factory=store_factory, embedder=embedder,
        clock=clock or (lambda: datetime.now(timezone.utc)),
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


# -- ledger (R-C3) ------------------------------------------------------------------------


def real_embedder() -> Any:
    """The local bge model; the weights load on the first embed, not here."""
    from ..embedding import FastEmbedEmbedder

    return FastEmbedEmbedder()


def _once(build: Callable[[], Any]) -> Callable[[], Any]:
    """``build`` called on first use only, then the same object every time."""
    held: list[Any] = []

    def get() -> Any:
        if not held:
            held.append(build())
        return held[0]

    return get


def _run_ledger(
    args: argparse.Namespace, *, git_collector: GitCollector | None, runner: Runner, judge: Judge | None,
    store: CurateStore | None, store_factory: StoreFactory | None, embedder: Any,
    clock: Callable[[], datetime], **_: Any,
) -> int:
    try:
        load_env_file(Path(args.env_file) if args.env_file else None)
        budget = Budget(args.max_calls, args.max_tokens)
        collector = None if args.no_git else (git_collector or real_git_collector())
        found = build_inventory(args.path, realm=args.realm, collection=args.collection,
                                git_collector=collector, runner=runner)
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return ledger.EXIT_UNAVAILABLE
    for item in found.errors:
        print(f"error: {item.path}: {item.reason}", file=sys.stderr)

    owned = None
    try:
        if store is None:
            store = owned = (store_factory or real_store)()
    except IngestError as exc:
        reason = " (a dry run reads the store, so the ledger has nothing to work from)" if args.dry_run else ""
        print(f"error: {exc}{reason}", file=sys.stderr)
        return ledger.EXIT_UNAVAILABLE
    spend = Spend(budget)
    try:
        results, writes = _ledger_run(args, found, store, spend, judge, embedder, clock)
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return ledger.EXIT_UNAVAILABLE
    finally:
        _close(owned)
    refused = [write for write in writes if isinstance(write, str)]
    for message in refused:
        print(f"error: {message}", file=sys.stderr)
    code = ledger.exit_code(results, spend, refused=bool(found.errors or refused))
    if args.json:
        print(json.dumps(ledger_json(results, writes, spend, args.dry_run, code), indent=2))
    else:
        print(ledger_text(results, writes, spend, args.dry_run, code))
    return code


def _ledger_run(args: argparse.Namespace, found: VaultInventory, store: CurateStore, spend: Spend,
                judge: Judge | None, embedder: Any, clock: Callable[[], datetime]):
    """Every selected collection's ledger, and its write: a WriteResult, a refusal message, or None."""
    version = extractor_version()
    working = DryRunStore(store) if args.dry_run else store
    judge_source = None if args.dry_run else _once(lambda: judge or real_judge(args.model))
    embedder_source = _once(lambda: embedder or real_embedder())
    results = tuple(build_ledger(inventory, working, embedder_source, judge_source, spend, version=version)
                    for inventory in found.collections)
    if args.dry_run:
        return results, tuple(None for _ in results)
    generated_at = to_utc_iso(clock())
    return results, tuple(_write_ledger(found.root, result, generated_at, version) for result in results)


def _write_ledger(root: str, result: CollectionLedger, generated_at: str, version: str) -> WriteResult | str:
    fields = ledger_frontmatter(result.realm_folder, result.collection, generated_at, version)
    body = ledger_body(result.collection, result.entries, result.collected.note_index)
    try:
        return write_curator_note(root, result.realm_folder, result.collection, "ledger", fields, body)
    except IngestError as exc:
        return f"{result.folder}/ledger.md: {exc}"


def ledger_text(results, writes, spend: Spend, dry_run: bool, code: int) -> str:
    """Ids, paths and counts only: summaries and quotes are note-derived and stay in ledger.md."""
    lines = ["ledger" + (" dry run" if dry_run else "") + f" (version {extractor_version()})"]
    for result, write in zip(results, writes):
        lines.extend(_ledger_lines(result, write, dry_run))
    last = f"ledger: {len(results)} collection(s), judge calls {spend.calls}, tokens {spend.tokens}, exit {code}"
    if spend.stopped == ledger.STOP_BUDGET:
        last += "; stopped by budget: rerun to continue"
    elif spend.stopped == ledger.STOP_FAILURES:
        last += f"; stopped after {ledger.MAX_CONSECUTIVE_FAILURES} consecutive judge failures"
    return "\n".join([*lines, last])


def _ledger_lines(result: CollectionLedger, write: Any, dry_run: bool) -> list[str]:
    c = result.collected
    asked = f"would ask {result.would_ask}" if dry_run else f"judge calls {result.judge_calls}"
    lines = [
        f"{result.folder}: notes {c.notes}, extracted {c.extracted}, not extracted yet {len(c.not_extracted)}, "
        f"issue items {len(c.items)}; new issues {len(result.new_issues)}, new members {result.new_members}, "
        f"new events {result.new_events}; {asked} (cached verdicts {result.cached_verdicts}); "
        f"unresolved fix refs {result.unresolved_refs}",
        "    states: " + ", ".join(f"{state} {n}" for state, n in _state_counts(result).items()),
    ]
    if c.not_extracted:
        lines.append(f"    {len(c.not_extracted)} note(s) not extracted yet: run curate extract")
    if result.new_issues:
        lines.append("    new issues: " + ", ".join(result.new_issues))
    lines.extend(f"    unplaced: {p.path} ({p.reason})" for p in result.unplaced)
    lines.extend(f"    conflict: {conflict}" for conflict in result.conflicts)
    lines.append(f"    ledger: {result.folder}/ledger.md {_write_word(write)}")
    return lines


def _write_word(write: Any) -> str:
    if write is None:
        return "not written (dry run)"
    if isinstance(write, WriteResult):
        return "written" if write.written else "unchanged"
    return "refused"


def _state_counts(result: CollectionLedger) -> dict[str, int]:
    held = result.states
    return {state: held.get(state, 0) for state in ISSUE_STATES}


def ledger_json(results, writes, spend: Spend, dry_run: bool, code: int) -> dict[str, Any]:
    return {
        "version": extractor_version(),
        "dry_run": dry_run,
        "collections": [_ledger_json(result, write) for result, write in zip(results, writes)],
        "judge_calls": spend.calls,
        "tokens": spend.tokens,
        "stopped": spend.stopped,
        "exit_code": code,
    }


def _ledger_json(result: CollectionLedger, write: Any) -> dict[str, Any]:
    c = result.collected
    written = isinstance(write, WriteResult) and write.written
    return {
        "folder": result.folder,
        "collection": result.collection,
        "notes": c.notes,
        "extracted": c.extracted,
        "not_extracted": list(c.not_extracted),
        "issue_items": len(c.items),
        "new_issues": list(result.new_issues),
        "new_members": result.new_members,
        "new_events": result.new_events,
        "judge_calls": result.judge_calls,
        "cached_verdicts": result.cached_verdicts,
        "would_ask": result.would_ask,
        "unplaced": [{"path": p.path, "reason": p.reason} for p in result.unplaced],
        "unresolved_fix_refs": result.unresolved_refs,
        "conflicts": list(result.conflicts),
        "states": _state_counts(result),
        "ledger": {"path": f"{result.folder}/ledger.md", "written": written, "outcome": _write_word(write)},
    }


# Stage name -> handler(args, **dependencies).
STAGES: dict[str, Callable[..., int]] = {"inventory": _run_inventory, "extract": _run_extract, "ledger": _run_ledger}


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
