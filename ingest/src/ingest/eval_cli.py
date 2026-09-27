"""``uv run ingest eval`` — score retrieval against the golden queries.

    uv run ingest eval
    uv run ingest eval --json > before.json
    uv run ingest eval --min-hit-rate 0.8        # non-zero exit below the bar
    uv run ingest eval --history                 # also append the scores to eval/history.jsonl

Read-only against the store: it embeds each query locally and calls
``rag.search``. The only file it writes is the history line, and only when asked.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

from .config import load_db_settings
from .embedding import Embedder, FastEmbedEmbedder
from .envfile import load_env_file
from .errors import ConfigError, IngestError
from .eval import (
    DEFAULT_K,
    DEFAULT_LIMIT,
    CaseResult,
    CollectionScore,
    EvalReport,
    PostgresSearcher,
    Searcher,
    load_golden,
    run_eval,
)

SUBCOMMAND = "eval"

# ingest/eval/golden.yaml, beside src/.
DEFAULT_GOLDEN = Path(__file__).resolve().parents[2] / "eval" / "golden.yaml"
# One JSON line per run, beside the golden file; per-machine, so gitignored.
DEFAULT_HISTORY = DEFAULT_GOLDEN.parent / "history.jsonl"

EXIT_OK = 0
EXIT_BELOW_BAR = 1
EXIT_USAGE = 2

# How many returned external ids to show for a failed case.
MAX_SHOWN_HITS = 3


def build_eval_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=f"ingest {SUBCOMMAND}",
        description="Score rag.search against the golden queries: hit@k, MRR, negative pass rate.",
    )
    parser.add_argument("--golden", default=str(DEFAULT_GOLDEN), help="golden query file (YAML)")
    parser.add_argument("-k", type=int, default=DEFAULT_K, help=f"rank cut-off (default {DEFAULT_K})")
    parser.add_argument(
        "--limit", type=int, default=DEFAULT_LIMIT, help=f"results per query (default {DEFAULT_LIMIT})"
    )
    parser.add_argument(
        "--min-hit-rate",
        type=float,
        default=None,
        help="exit 1 when hit@k falls below this, or when any negative case returns results",
    )
    parser.add_argument("--json", action="store_true", help="machine-readable report on stdout")
    parser.add_argument(
        "--history",
        nargs="?",
        const=str(DEFAULT_HISTORY),
        default=None,
        metavar="PATH",
        help=f"append this run's scores as one JSON line (default path {DEFAULT_HISTORY.name})",
    )
    parser.add_argument("--env-file", default=None, help="explicit .env path")
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return parser


def run_eval_command(
    argv: list[str],
    *,
    searcher: Searcher | None = None,
    embedder: Embedder | None = None,
) -> int:
    """Run the subcommand. ``searcher`` and ``embedder`` are injectable for tests;
    the CLI builds the live ones."""
    args = build_eval_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    if args.k < 1 or args.limit < args.k:
        print("error: need k >= 1 and --limit >= k", file=sys.stderr)
        return EXIT_USAGE

    owned: PostgresSearcher | None = None
    try:
        cases = load_golden(args.golden)
        if searcher is None:
            load_env_file(Path(args.env_file) if args.env_file else None)
            owned = PostgresSearcher.from_settings(load_db_settings())
            searcher = owned
        report = run_eval(cases, searcher, embedder or FastEmbedEmbedder(), k=args.k, limit=args.limit)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_BELOW_BAR
    finally:
        if owned is not None:
            owned.close()

    print(json.dumps(_as_json(report), indent=2) if args.json else _as_text(report))
    if args.history:
        _append_history(Path(args.history), report)
    return _exit_code(report, args.min_hit_rate)


def _append_history(path: Path, report: EvalReport) -> None:
    """Append one newline-terminated JSON line. A failure is a warning: the eval
    itself ran and scored, so the exit code stays what the scores make it."""
    line = json.dumps(_history_record(report, datetime.now(timezone.utc)), separators=(",", ":"))
    try:
        with path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(line + "\n")
    except OSError as exc:
        print(f"warning: could not append to the eval history {path}: {exc}", file=sys.stderr)


def _history_record(report: EvalReport, at: datetime) -> dict[str, object]:
    return {
        "at": at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "k": report.k,
        "hit_rate": report.hit_rate,
        "mrr": report.mrr,
        "negative_pass_rate": report.negative_pass_rate,
        "cases": len(report.results),
        "per_collection": _per_collection_json(report),
        "failures": [r.case.id for r in report.failures],
        "mislabelled": [r.case.id for r in report.mislabelled],
    }


def _per_collection_json(report: EvalReport) -> list[dict[str, object]]:
    return [
        {
            "realm": score.realm,
            "collection": score.collection,
            "cases": score.cases,
            "hit_rate": score.hit_rate,
            "mrr": score.mrr,
        }
        for score in report.by_collection().values()
    ]


def _exit_code(report: EvalReport, min_hit_rate: float | None) -> int:
    if min_hit_rate is None:
        return EXIT_OK
    below = report.hit_rate < min_hit_rate or report.negative_pass_rate < 1.0
    return EXIT_BELOW_BAR if below else EXIT_OK


def _as_json(report: EvalReport) -> dict[str, object]:
    return {
        "k": report.k,
        "hit_rate": report.hit_rate,
        "mrr": report.mrr,
        "negative_pass_rate": report.negative_pass_rate,
        "per_collection": _per_collection_json(report),
        "cases": [
            {
                "id": r.case.id,
                "negative": r.case.negative,
                "collection": r.case.collection,
                "realm": r.case.realm,
                "rank": r.rank,
                "passed": r.passed(report.k),
                "mislabelled": r.mislabelled(report.k),
                "returned": [h.external_id for h in r.hits[:MAX_SHOWN_HITS]],
            }
            for r in report.results
        ],
    }


def _as_text(report: EvalReport) -> str:
    lines = [
        f"hit@{report.k}  {report.hit_rate:.2f}  ({_passed(report.positives, report.k)}/{len(report.positives)})",
        f"MRR    {report.mrr:.2f}",
        f"negatives pass  {report.negative_pass_rate:.2f}  "
        f"({_passed(report.negatives, report.k)}/{len(report.negatives)})",
    ]
    scores = tuple(report.by_collection().values())
    if scores:
        lines.append("")
        lines.extend(_collection_table(scores, report.k))
    if report.mislabelled:
        lines.append("")
        lines.append("label check:")
        lines.extend(_label_line(r) for r in report.mislabelled)
    if report.failures:
        lines.append("")
        lines.append("failed:")
        lines.extend(_failure_line(r) for r in report.failures)
    return "\n".join(lines)


def _collection_table(scores: tuple[CollectionScore, ...], k: int) -> list[str]:
    """An aligned table: realm, collection, cases, hit@k, MRR."""
    realm_width = max(len("realm"), *(len(s.realm) for s in scores))
    collection_width = max(len("collection"), *(len(s.collection) for s in scores))
    hit_label = f"hit@{k}"

    def row(realm: str, collection: str, cases: str, hit_rate: str, mrr: str) -> str:
        return (
            f"{realm:<{realm_width}}  {collection:<{collection_width}}  "
            f"{cases:>5}  {hit_rate:>{len(hit_label)}}  {mrr:>4}"
        )

    header = row("realm", "collection", "cases", hit_label, "MRR")
    body = [
        row(s.realm, s.collection, str(s.cases), f"{s.hit_rate:.2f}", f"{s.mrr:.2f}") for s in scores
    ]
    return [header, *body]


def _label_line(result: CaseResult) -> str:
    matched = result.matched_hit
    expected = _label(result.case.realm, result.case.collection)
    came_from = _label(matched.realm, matched.collection) if matched else "-"
    return f"  {result.case.id}: expected {expected}, hit came from {came_from}"


def _label(realm: str | None, collection: str | None) -> str:
    """``realm/collection``, or just the collection when there is no realm."""
    home = collection or "-"
    return f"{realm}/{home}" if realm else home


def _passed(results: tuple[CaseResult, ...], k: int) -> int:
    return sum(1 for r in results if r.passed(k))


def _failure_line(result: CaseResult) -> str:
    shown = ", ".join(h.external_id for h in result.hits[:MAX_SHOWN_HITS]) or "nothing"
    if result.case.negative:
        return f"  {result.case.id}: expected nothing, got {shown}"
    where = f"rank {result.rank}" if result.rank else "not found"
    return f"  {result.case.id}: {where}; top results: {shown}"
