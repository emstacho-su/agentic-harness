"""``uv run ingest eval`` — score retrieval against the golden queries.

    uv run ingest eval
    uv run ingest eval --json > before.json
    uv run ingest eval --min-hit-rate 0.8        # non-zero exit below the bar

Read-only: it embeds each query locally and calls ``rag.search``.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from .config import load_db_settings
from .embedding import Embedder, FastEmbedEmbedder
from .envfile import load_env_file
from .errors import ConfigError, IngestError
from .eval import (
    DEFAULT_K,
    DEFAULT_LIMIT,
    CaseResult,
    EvalReport,
    PostgresSearcher,
    Searcher,
    load_golden,
    run_eval,
)

SUBCOMMAND = "eval"

# ingest/eval/golden.yaml, beside src/.
DEFAULT_GOLDEN = Path(__file__).resolve().parents[2] / "eval" / "golden.yaml"

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
    return _exit_code(report, args.min_hit_rate)


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
        "cases": [
            {
                "id": r.case.id,
                "negative": r.case.negative,
                "rank": r.rank,
                "passed": r.passed(report.k),
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
    if report.failures:
        lines.append("")
        lines.append("failed:")
        lines.extend(_failure_line(r) for r in report.failures)
    return "\n".join(lines)


def _passed(results: tuple[CaseResult, ...], k: int) -> int:
    return sum(1 for r in results if r.passed(k))


def _failure_line(result: CaseResult) -> str:
    shown = ", ".join(h.external_id for h in result.hits[:MAX_SHOWN_HITS]) or "nothing"
    if result.case.negative:
        return f"  {result.case.id}: expected nothing, got {shown}"
    where = f"rank {result.rank}" if result.rank else "not found"
    return f"  {result.case.id}: {where}; top results: {shown}"
