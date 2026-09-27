"""``uv run ingest curate report`` — R-C6's scores and curation report, R-C7's tally.

    uv run ingest curate report --path C:/Users/you/vault --realm projects --dry-run
    uv run ingest curate report --path C:/Users/you/vault --all --json

Per selected realm folder (see ``report_run.py`` for each step): record the
ticks in the realm's earlier curation reports, score every selected collection
(``curate.note_scores``; the judge's importance only where the features
disagree), store today's condense and prune proposals, tally every report and
write ``<realm>/curation/<YYYY-MM-DD>.md`` (the clock's UTC day). ``--collection``
narrows the scoring to one collection; the report still tallies the whole realm.

Retrieval counts come from ``rag.retrieval_events``; when the database cannot
give them, a warning says so and the run scores without them (the JSON report
says ``"retrieval_counts": "unavailable"``). ``--dry-run`` calls no judge, keeps
every score, proposal and decision in memory and writes no file; the store is
still read.

Exit codes: 0 done; 1 an importance call failed, or the run stopped after
consecutive failures; 2 could not run (bad arguments or vault, the store
unreachable even for a dry run, a report the curator may not overwrite or
cannot write); 3 stopped by budget. The report prints ids, paths and counts only.

``cli.py`` imports this module, so this one reaches ``cli``'s shared helpers
(``real_store``, ``real_judge``, ``_once`` ...) inside its functions.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import load_db_settings
from ..envfile import load_env_file
from ..errors import IngestError
from .dry_run_store import DryRunStore
from .extract import extractor_version
from .extract_plan import Budget
from .inventory import GitCollector, VaultInventory, build_inventory
from .judge import Judge
from .ledger import (
    EXIT_BUDGET,
    EXIT_DONE,
    EXIT_FAILED,
    EXIT_UNAVAILABLE,
    MAX_CONSECUTIVE_FAILURES,
    STOP_BUDGET,
    STOP_FAILURES,
    Spend,
)
from .profile import Runner, default_runner
from .report_run import CollectionReport, FallbackRetrievalCounts, RealmReport, RunContext, report_realm
from .retrieval_counts import PostgresRetrievalCounts, RetrievalCounts
from .scores import LEFT_BY_BUDGET, scorer_version
from .store_models import CurateStore, to_utc_iso
from .tally import ACTIONS
from .writer import WriteResult

STAGE = "report"
DEFAULT_MAX_CALLS = 40
DEFAULT_MAX_TOKENS = 200_000


def add_parser(stages: argparse._SubParsersAction) -> None:
    from .claude_cli import DEFAULT_MODEL
    from .cli import _common, _positive_int

    stage = stages.add_parser(
        STAGE, help="R-C6/R-C7: score notes, propose condense and prune, tally ticks; write the curation report"
    )
    stage.add_argument("--path", required=True, help="vault directory (C:/Users/... on Windows)")
    which = stage.add_mutually_exclusive_group(required=True)
    which.add_argument("--realm", default=None, help="only this realm (name or top-level folder)")
    which.add_argument("--all", action="store_true", help="every realm (explicit, because it costs calls)")
    stage.add_argument("--collection", default=None, help="score only this collection (its folder name)")
    stage.add_argument("--model", default=DEFAULT_MODEL, help=f"judge model (default {DEFAULT_MODEL})")
    stage.add_argument("--max-calls", type=_positive_int, default=DEFAULT_MAX_CALLS,
                       help=f"importance calls per run (default {DEFAULT_MAX_CALLS})")
    stage.add_argument("--max-tokens", type=_positive_int, default=DEFAULT_MAX_TOKENS,
                       help=f"input plus output tokens per run (default {DEFAULT_MAX_TOKENS})")
    stage.add_argument("--no-git", action="store_true", help="skip git and gh: no commit or PR features")
    stage.add_argument("--dry-run", action="store_true",
                       help="read the store only, call no judge, write no file: print what would change")
    stage.add_argument("--json", action="store_true", help="the report as JSON")
    _common(stage)


def run(args: argparse.Namespace, *, git_collector: GitCollector | None, runner: Runner | None,
        judge: Judge | None, store: CurateStore | None, store_factory: Callable[[], CurateStore] | None,
        embedder: Any, clock: Callable[[], datetime], retrieval_counts: RetrievalCounts | None = None,
        **_: Any) -> int:
    from .cli import _close, real_git_collector, real_store

    try:
        load_env_file(Path(args.env_file) if args.env_file else None)
        budget = Budget(args.max_calls, args.max_tokens)
        collector = None if args.no_git else (git_collector or real_git_collector())
        found = build_inventory(args.path, realm=args.realm, collection=args.collection,
                                git_collector=collector, runner=runner or default_runner)
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_UNAVAILABLE
    for item in found.errors:
        print(f"error: {item.path}: {item.reason}", file=sys.stderr)

    owned = None
    try:
        if store is None:
            store = owned = (store_factory or real_store)()
    except IngestError as exc:
        reason = " (a dry run reads the store for extractions, proposals and decisions)" if args.dry_run else ""
        print(f"error: {exc}{reason}", file=sys.stderr)
        return EXIT_UNAVAILABLE
    counts = (FallbackRetrievalCounts(lambda: retrieval_counts, owned=False) if retrieval_counts is not None
              else FallbackRetrievalCounts(lambda: PostgresRetrievalCounts.from_settings(load_db_settings()),
                                           owned=True))
    spend = Spend(budget)
    try:
        reports = _report_run(args, found, store, spend, judge, embedder, counts, clock)
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_UNAVAILABLE
    finally:
        _close(owned)
        counts.close()
    refused = [r.write for r in reports if isinstance(r.write, str)]
    for message in refused:
        print(f"error: {message}", file=sys.stderr)
    code = exit_code(reports, spend, refused=bool(found.errors or refused))
    if args.json:
        print(json.dumps(report_json(reports, spend, args.dry_run, counts.available, code), indent=2))
    else:
        print(report_text(reports, spend, args.dry_run, counts.available, code))
    return code


def _report_run(args: argparse.Namespace, found: VaultInventory, store: CurateStore, spend: Spend,
                judge: Judge | None, embedder: Any, counts: RetrievalCounts,
                clock: Callable[[], datetime]) -> tuple[RealmReport, ...]:
    from .cli import _once, real_embedder, real_judge

    now = clock()
    context = RunContext(
        day=now.astimezone(timezone.utc).date().isoformat(), generated_at=to_utc_iso(now), dry_run=args.dry_run,
        spend=spend, judge_source=None if args.dry_run else _once(lambda: judge or real_judge(args.model)),
        embedder_source=_once(lambda: embedder or real_embedder()), counts=counts,
        scorer_version=scorer_version(), extractor_version=extractor_version(),
    )
    working = DryRunStore(store) if args.dry_run else store
    realms: dict[str, list] = {}
    for inventory in found.collections:
        realms.setdefault(inventory.folder.split("/", 1)[0], []).append(inventory)
    return tuple(report_realm(found.root, realm, realms[realm], working, context) for realm in sorted(realms))


def exit_code(reports: tuple[RealmReport, ...], spend: Spend, *, refused: bool) -> int:
    """2 when something could not run, 1 when an importance call failed, 3 for a budget stop."""
    if refused:
        return EXIT_UNAVAILABLE
    failed = any(p.reason != LEFT_BY_BUDGET for r in reports for c in r.collections for p in c.scores.problems)
    if failed or spend.stopped == STOP_FAILURES:
        return EXIT_FAILED
    return EXIT_BUDGET if spend.stopped == STOP_BUDGET else EXIT_DONE


# -- reports: ids, paths and counts only ----------------------------------------------------------


def _outcome(write: Any) -> str:
    if write is None:
        return "not written (dry run)"
    if isinstance(write, WriteResult):
        return "written" if write.written else "unchanged"
    return "refused"


def _candidates(result: CollectionReport, action: str) -> list[str]:
    return [c.note_id for c in result.candidates if c.action == action]


def report_text(reports, spend: Spend, dry_run: bool, counts_available: bool, code: int) -> str:
    lines = [STAGE + (" dry run" if dry_run else "") + f" (scorer version {scorer_version()})"]
    if not counts_available:
        lines.append("retrieval counts: unavailable, scored without them")
    for report in reports:
        t = report.ticks
        lines.append(f"{report.realm_folder}: report files read {t.reports_read}, ignored {t.reports_ignored}; "
                     f"decisions recorded {t.recorded}, ticks ignored {t.ignored}")
        for result in report.collections:
            lines.extend(_collection_lines(result, dry_run))
        modes = ", ".join(f"{action} {report.modes[action].mode} (streak {report.modes[action].streak})"
                          for action in ACTIONS)
        lines.append(f"    modes: {modes}")
        lines.append(f"    report: {report.path} {_outcome(report.write)}")
    last = f"{STAGE}: {len(reports)} realm(s), judge calls {spend.calls}, tokens {spend.tokens}, exit {code}"
    if spend.stopped == STOP_BUDGET:
        last += "; stopped by budget: rerun to continue"
    elif spend.stopped == STOP_FAILURES:
        last += f"; stopped after {MAX_CONSECUTIVE_FAILURES} consecutive judge failures"
    return "\n".join([*lines, last])


def _collection_lines(result: CollectionReport, dry_run: bool) -> list[str]:
    s = result.scores
    asked = f"would ask {s.would_ask}" if dry_run else f"judge calls {s.judge_calls}"
    per_action = ", ".join(f"{action} {len(_candidates(result, action))}" for action in ACTIONS)
    lines = [f"    {result.folder}: notes scored {len(s.notes)}, {asked}; candidates {per_action}; "
             f"new proposals {result.new_proposals}"]
    if s.not_extracted:
        lines.append(f"        {s.not_extracted} note(s) not extracted yet: run curate extract")
    if s.left:
        lines.append(f"        {s.left} note(s) left unscored for the next run")
    lines.extend(f"        problem: {p.path} ({p.reason})" for p in s.problems)
    return lines


def report_json(reports, spend: Spend, dry_run: bool, counts_available: bool, code: int) -> dict[str, Any]:
    return {
        "version": scorer_version(),
        "dry_run": dry_run,
        "realms": [_realm_json(report) for report in reports],
        "retrieval_counts": "available" if counts_available else "unavailable",
        "judge_calls": spend.calls,
        "tokens": spend.tokens,
        "stopped": spend.stopped,
        "exit_code": code,
    }


def _realm_json(report: RealmReport) -> dict[str, Any]:
    t = report.ticks
    return {
        "realm_folder": report.realm_folder,
        "reports_read": t.reports_read,
        "reports_ignored": t.reports_ignored,
        "decisions_recorded": t.recorded,
        "ticks_ignored": t.ignored,
        "collections": [_collection_json(result) for result in report.collections],
        "modes": {action: {"mode": report.modes[action].mode, "streak": report.modes[action].streak}
                  for action in ACTIONS},
        "report": {"path": report.path, "written": isinstance(report.write, WriteResult) and report.write.written,
                   "outcome": _outcome(report.write)},
    }


def _collection_json(result: CollectionReport) -> dict[str, Any]:
    s = result.scores
    return {
        "folder": result.folder,
        "collection": result.collection,
        "scored": len(s.notes),
        "scores_written": s.written,
        "would_ask": s.would_ask,
        "judge_calls": s.judge_calls,
        "left": s.left,
        "not_extracted": s.not_extracted,
        "problems": [{"path": p.path, "reason": p.reason} for p in s.problems],
        "candidates": {action: _candidates(result, action) for action in ACTIONS},
        "new_proposals": result.new_proposals,
    }
