"""``uv run ingest sweep-concluded`` — the 24 h conclude sweep's command line.

Kept apart from ``cli.py`` because it shares nothing with the ingest run: no
store, no embedder, no chunker. It only reads and rewrites frontmatter.

Dry run is the default. The sweep is the one part of this package that edits
Stack's own notes, so writing has to be asked for explicitly.
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime

from .errors import IngestError
from .sweep import Action, DEFAULT_STALE_AFTER_HOURS, SweepResult, sweep_concluded

SUBCOMMAND = "sweep-concluded"

log = logging.getLogger("ingest.sweep")

# How many concluded notes to name individually before summarising.
MAX_LISTED = 20


def build_sweep_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=f"ingest {SUBCOMMAND}",
        description=(
            "Set status: concluded and concluded_at on session notes that are still "
            "'active' more than 24 h after their ended_at. Only those two frontmatter "
            "keys change; everything else in the note is preserved byte for byte."
        ),
    )
    parser.add_argument(
        "--path",
        required=True,
        help="vault directory. On Windows use C:/Users/... , not /c/Users/... ",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="write the changes. Without it the sweep only reports what it would do.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report only (the default); accepted so the intent can be written out",
    )
    parser.add_argument(
        "--stale-after-hours",
        type=int,
        default=DEFAULT_STALE_AFTER_HOURS,
        help=f"how long an active session may stay active (default {DEFAULT_STALE_AFTER_HOURS})",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return parser


def run_sweep(argv: list[str], *, now: datetime | None = None) -> int:
    """Run the subcommand. ``now`` is injectable for tests, exactly as on
    :func:`sweep_concluded`; the CLI always passes the real clock."""
    parser = build_sweep_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    if args.apply and args.dry_run:
        print("error: --apply and --dry-run contradict each other", file=sys.stderr)
        return 2
    if args.stale_after_hours < 1:
        print("error: --stale-after-hours must be >= 1", file=sys.stderr)
        return 2

    try:
        result = sweep_concluded(
            args.path,
            now=now,
            stale_after_hours=args.stale_after_hours,
            apply=args.apply,
        )
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    _report(result)
    # A refusal is information for the operator, not a failed job. Exiting
    # non-zero would make the scheduled task report failure every night over one
    # pre-schema note that nobody intends to fix.
    return 0


def _report(result: SweepResult) -> None:
    header = (
        "\n--- conclude sweep complete ---"
        if result.applied
        else "\n--- conclude sweep: dry run, nothing written ---"
    )
    print(header)
    print(f"  scanned {result.scanned} session note(s)")
    for action, count in result.summary().items():
        if count:
            print(f"  {count:5}  {action}")

    concluded = result.of(Action.CONCLUDED)
    if concluded:
        verb = "concluded" if result.applied else "would conclude"
        print(f"\n{verb.capitalize()} {len(concluded)} note(s):")
        for outcome in concluded[:MAX_LISTED]:
            print(f"  {outcome.relative}")
        if len(concluded) > MAX_LISTED:
            print(f"  ... and {len(concluded) - MAX_LISTED} more")

    refused = result.refused
    if refused:
        print(f"\n{len(refused)} note(s) refused:", file=sys.stderr)
        for outcome in refused[:MAX_LISTED]:
            print(f"  {outcome.relative}: {outcome.detail}", file=sys.stderr)
        if len(refused) > MAX_LISTED:
            print(f"  ... and {len(refused) - MAX_LISTED} more", file=sys.stderr)


__all__ = ["SUBCOMMAND", "build_sweep_parser", "run_sweep"]
