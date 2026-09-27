"""``uv run ingest curate history`` — the R-C5 stage's arguments, run and report.

    uv run ingest curate history --path C:/Users/you/vault --collection agentic-harness --dry-run
    uv run ingest curate history --path C:/Users/you/vault --all --max-calls 20

Per collection: every uncached week is one judge call, stored in
``curate.history_weeks``, then ``<realm>/<collection>/history.md`` is written.
With ``--dry-run`` the store is only read, no judge is called and no file is
written; the report says how many weeks would be asked and their estimated size.

Exit codes: 0 done; 1 a judge call failed, or the run stopped after consecutive
failures; 2 could not run (bad arguments, vault, the store unreachable even for a
dry run, a history.md the curator may not overwrite or cannot write); 3 stopped
by budget. Dropped citations, paragraphs and titles are counted in the report,
not failures. The report holds ids, paths and counts only, never narrative text.

``cli.py`` imports this module, so this one reaches ``cli``'s shared helpers
(``real_store``, ``real_judge``, ``_once`` ...) inside its functions.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from ..envfile import load_env_file
from ..errors import IngestError
from . import history
from .dry_run_store import DryRunStore
from .extract import extractor_version
from .extract_plan import Budget
from .history import CollectionHistory, build_history, history_version
from .history_render import history_body, history_frontmatter
from .inventory import GitCollector, VaultInventory, build_inventory
from .judge import Judge
from .ledger import STOP_BUDGET, STOP_FAILURES, MAX_CONSECUTIVE_FAILURES, Spend
from .profile import Runner
from .store_models import CurateStore, to_utc_iso
from .writer import WriteResult, write_curator_note

STAGE = "history"


def add_parser(stages: argparse._SubParsersAction) -> None:
    from .claude_cli import DEFAULT_MODEL
    from .cli import _common, _positive_int

    stage = stages.add_parser(
        STAGE, help="R-C5: a week-by-week narrative citing its sessions; write history.md"
    )
    stage.add_argument("--path", required=True, help="vault directory (C:/Users/... on Windows)")
    which = stage.add_mutually_exclusive_group(required=True)
    which.add_argument("--collection", default=None, help="only this collection (its folder name)")
    which.add_argument("--all", action="store_true", help="every collection (explicit, because it costs calls)")
    stage.add_argument("--realm", default=None, help="only this realm (name or top-level folder)")
    stage.add_argument("--model", default=DEFAULT_MODEL, help=f"judge model (default {DEFAULT_MODEL})")
    stage.add_argument("--max-calls", type=_positive_int, default=history.DEFAULT_MAX_CALLS,
                       help=f"week calls per run (default {history.DEFAULT_MAX_CALLS})")
    stage.add_argument("--max-tokens", type=_positive_int, default=history.DEFAULT_MAX_TOKENS,
                       help=f"input plus output tokens per run (default {history.DEFAULT_MAX_TOKENS})")
    stage.add_argument("--no-git", action="store_true", help="skip git and gh: no commits or PRs in the weeks")
    stage.add_argument("--dry-run", action="store_true",
                       help="read the store only, call no judge, write no file: print what would be asked")
    stage.add_argument("--json", action="store_true", help="the report as JSON")
    _common(stage)


def run(args: argparse.Namespace, *, git_collector: GitCollector | None, runner: Runner, judge: Judge | None,
        store: CurateStore | None, store_factory: Callable[[], CurateStore] | None,
        clock: Callable[[], datetime], **_: Any) -> int:
    from .cli import _close, real_git_collector, real_store

    try:
        load_env_file(Path(args.env_file) if args.env_file else None)
        budget = Budget(args.max_calls, args.max_tokens)
        collector = None if args.no_git else (git_collector or real_git_collector())
        found = build_inventory(args.path, realm=args.realm, collection=args.collection,
                                git_collector=collector, runner=runner)
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return history.EXIT_UNAVAILABLE
    for item in found.errors:
        print(f"error: {item.path}: {item.reason}", file=sys.stderr)

    owned = None
    try:
        if store is None:
            store = owned = (store_factory or real_store)()
    except IngestError as exc:
        reason = " (a dry run reads the store for cached weeks)" if args.dry_run else ""
        print(f"error: {exc}{reason}", file=sys.stderr)
        return history.EXIT_UNAVAILABLE
    spend = Spend(budget)
    try:
        results, writes = _history_run(args, found, store, spend, judge, clock)
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return history.EXIT_UNAVAILABLE
    finally:
        _close(owned)
    refused = [write for write in writes if isinstance(write, str)]
    for message in refused:
        print(f"error: {message}", file=sys.stderr)
    code = history.exit_code(results, spend, refused=bool(found.errors or refused))
    if args.json:
        print(json.dumps(history_json(results, writes, spend, args.dry_run, code), indent=2))
    else:
        print(history_text(results, writes, spend, args.dry_run, code))
    return code


def _history_run(args: argparse.Namespace, found: VaultInventory, store: CurateStore, spend: Spend,
                 judge: Judge | None, clock: Callable[[], datetime]):
    """Every selected collection's history, and its write: a WriteResult, a refusal message, or None."""
    from .cli import _once, real_judge

    version = history_version()
    working = DryRunStore(store) if args.dry_run else store
    judge_source = None if args.dry_run else _once(lambda: judge or real_judge(args.model))
    results = tuple(build_history(inventory, working, judge_source, spend, version=version,
                                  extractor_version=extractor_version())
                    for inventory in found.collections)
    if args.dry_run:
        return results, tuple(None for _ in results)
    generated_at = to_utc_iso(clock())
    return results, tuple(_write(found.root, result, generated_at, version) for result in results)


def _write(root: str, result: CollectionHistory, generated_at: str, version: str) -> WriteResult | str:
    fields = history_frontmatter(result.realm_folder, result.collection, generated_at, version)
    body = history_body(result.collection, result.weeks, result.narratives, result.note_index)
    try:
        return write_curator_note(root, result.realm_folder, result.collection, STAGE, fields, body)
    except IngestError as exc:
        return f"{result.folder}/history.md: {exc}"
    except OSError as exc:  # a locked file (Obsidian, OneDrive) must not sink the other collections
        return f"{result.folder}/history.md: could not write ({exc.strerror or type(exc).__name__})"


# -- reports: ids, paths and counts only ----------------------------------------------------------


def history_text(results, writes, spend: Spend, dry_run: bool, code: int) -> str:
    lines = [f"{STAGE}" + (" dry run" if dry_run else "") + f" (version {history_version()})"]
    for result, write in zip(results, writes):
        lines.extend(_lines(result, write, dry_run))
    last = f"{STAGE}: {len(results)} collection(s), judge calls {spend.calls}, tokens {spend.tokens}, exit {code}"
    if spend.stopped == STOP_BUDGET:
        last += "; stopped by budget: rerun to continue"
    elif spend.stopped == STOP_FAILURES:
        last += f"; stopped after {MAX_CONSECUTIVE_FAILURES} consecutive judge failures"
    return "\n".join([*lines, last])


def _lines(result: CollectionHistory, write: Any, dry_run: bool) -> list[str]:
    asked = (f"would ask {result.would_ask} (~{result.estimated_tokens} tokens)" if dry_run
             else f"judge calls {result.judge_calls}")
    lines = [
        f"{result.folder}: weeks {len(result.weeks)}, cached {result.cached}, {asked}, pending {result.pending}, "
        f"undated {len(result.undated)}; dropped citations {result.dropped_citations}, "
        f"paragraphs {result.dropped_paragraphs}, titles {result.dropped_titles}",
    ]
    lines.extend(f"    failed: week {week} ({reason})" for week, reason in result.failed)
    if result.left:
        lines.append(f"    {result.left} week(s) left for the next run")
    lines.append(f"    {STAGE}: {result.folder}/history.md {_write_word(write)}")
    return lines


def _write_word(write: Any) -> str:
    if write is None:
        return "not written (dry run)"
    if isinstance(write, WriteResult):
        return "written" if write.written else "unchanged"
    return "refused"


def history_json(results, writes, spend: Spend, dry_run: bool, code: int) -> dict[str, Any]:
    return {
        "version": history_version(),
        "dry_run": dry_run,
        "collections": [_json(result, write) for result, write in zip(results, writes)],
        "judge_calls": spend.calls,
        "tokens": spend.tokens,
        "stopped": spend.stopped,
        "exit_code": code,
    }


def _json(result: CollectionHistory, write: Any) -> dict[str, Any]:
    return {
        "folder": result.folder,
        "collection": result.collection,
        "weeks": len(result.weeks),
        "cached": result.cached,
        "judge_calls": result.judge_calls,
        "would_ask": result.would_ask,
        "estimated_tokens": result.estimated_tokens,
        "pending": result.pending,
        "undated": list(result.undated),
        "dropped_citations": result.dropped_citations,
        "dropped_paragraphs": result.dropped_paragraphs,
        "dropped_titles": result.dropped_titles,
        "failed": [{"week": week, "reason": reason} for week, reason in result.failed],
        "left": result.left,
        "history": {"path": f"{result.folder}/history.md", "written": isinstance(write, WriteResult) and write.written,
                    "outcome": _write_word(write)},
    }
