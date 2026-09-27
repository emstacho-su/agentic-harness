"""``uv run ingest report retrievals`` — what the sessions searched for (R-P3).

    uv run ingest report retrievals
    uv run ingest report retrievals --since 14d
    uv run ingest report retrievals --since 2026-09-10 --json > retrievals.json
    uv run ingest report retrievals --json-out out/retrievals.json --html out/dashboard.html

Read-only, in one read-only transaction. Sections: totals, most retrieved,
never retrieved (whole store), empty-result queries, the similarity
distribution, retrievals per collection, and cross-collection searches.
``--json-out`` and ``--html`` also write the JSON and the dashboard page
(retrieval_dashboard.py) to files, each replaced whole or not at all.
Stdout is written as UTF-8 on every platform.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import tempfile
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import load_db_settings
from .envfile import load_env_file
from .errors import ConfigError, IngestError
from .retrieval_dashboard import render_dashboard
from .retrieval_report import fetch_report, parse_since
from .store import connect_kwargs

SUBCOMMAND = "report"

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2

DEFAULT_LIMIT = 20

# Longest query or title shown in a text row; --json carries them whole.
MAX_TEXT = 60

HEADINGS = {
    "totals": "totals",
    "most_retrieved": "most retrieved",
    "never_retrieved": "never retrieved (whole store; --since does not apply)",
    "empty_queries": "empty-result queries",
    "similarity_distribution": "similarity distribution (result rows)",
    "per_collection": "per session-note collection",
    "cross_collection": "cross-collection searches (filter differs from the note's collection)",
}


def build_report_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=f"ingest {SUBCOMMAND}", description="Read-only reports on the store.")
    reports = parser.add_subparsers(dest="report", required=True)
    retrievals = reports.add_parser("retrievals", help="retrieval provenance from rag.retrieval_events")
    retrievals.add_argument("--json", action="store_true", help="one JSON object on stdout")
    retrievals.add_argument(
        "--since", default=None, help="ISO date or datetime (UTC when naive), or Nd for the last N days"
    )
    retrievals.add_argument(
        "--limit", type=int, default=DEFAULT_LIMIT, help=f"rows per list (default {DEFAULT_LIMIT})"
    )
    retrievals.add_argument("--json-out", default=None, help="also write the JSON to this file")
    retrievals.add_argument("--html", default=None, help="also write the dashboard page to this file")
    retrievals.add_argument("--env-file", default=None, help="explicit .env path")
    retrievals.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return parser


def run_report(
    argv: list[str], *, connection=None, clock: Callable[[], datetime] | None = None
) -> int:
    """Run the subcommand. ``connection`` and ``clock`` are injectable for tests."""
    args = build_report_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    if args.limit < 1:
        print("error: --limit must be at least 1", file=sys.stderr)
        return EXIT_USAGE

    now = clock() if clock is not None else datetime.now(timezone.utc)
    owned = None
    try:
        since = parse_since(args.since, now) if args.since is not None else None
        if connection is None:
            load_env_file(Path(args.env_file) if args.env_file else None)
            owned = _connect()
            connection = owned
        report = fetch_report(connection, since=since, limit=args.limit)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_FAILED
    finally:
        if owned is not None:
            owned.close()

    outputs = []
    if args.json_out:
        outputs.append((Path(args.json_out), _as_json(report) + "\n"))
    if args.html:
        outputs.append((Path(args.html), render_dashboard(report, generated_at=now.isoformat(timespec="seconds"))))
    for path, content in outputs:
        try:
            _write_whole(path, content)
        except OSError as exc:
            print(f"error: could not write {path}: {exc.strerror or exc}", file=sys.stderr)
            return EXIT_FAILED
        logging.getLogger(__name__).info("wrote %s", path)

    _utf8_stdout()
    print(_as_json(report) if args.json else _as_text(report, args.limit))
    return EXIT_OK


def _as_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, default=str)


def _write_whole(path: Path, content: str) -> None:
    """UTF-8, LF, through a temp file beside the target, so a failure leaves no partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


def _utf8_stdout() -> None:
    """The Windows console defaults to a legacy code page, where `·` printed as `�`."""
    reconfigure = getattr(sys.stdout, "reconfigure", None)
    if reconfigure is None:
        return
    try:
        reconfigure(encoding="utf-8")
    except (ValueError, OSError):
        pass


def _connect():
    settings = load_db_settings()
    if not settings.database_url:
        raise ConfigError("DATABASE_URL is not set; the report reads rag.retrieval_events.")
    import psycopg

    options = {**connect_kwargs(settings), "autocommit": False}
    try:
        return psycopg.connect(settings.database_url, **options)
    except psycopg.Error as exc:
        raise IngestError(f"Could not connect to the database: {exc}") from exc


# --------------------------------------------------------------------------
# text
# --------------------------------------------------------------------------


def _as_text(report: dict[str, Any], limit: int) -> str:
    blocks = [
        _totals(report["totals"]),
        _most(report["most_retrieved"], limit),
        _never(report["never_retrieved"]),
        _empty(report["empty_queries"]),
        _similarity(report["similarity_distribution"]),
        _collections(report["per_collection"]),
        _cross(report["cross_collection"]),
    ]
    return "\n\n".join(blocks)


def _totals(section: dict[str, Any]) -> str:
    since = section["since"] or "all time"
    return "\n".join(
        [
            HEADINGS["totals"],
            f"  events {section['events']}  retrievals {section['retrievals']}  "
            f"sessions {section['sessions']}",
            f"  first {section['first'] or '-'}  last {section['last'] or '-'}  since {since}",
        ]
    )


def _most(rows: list[dict[str, Any]], limit: int) -> str:
    table = _table(
        ("count", "sessions", "document", "collection", "title"),
        [
            (r["count"], r["sessions"], f"{r['source']}:{r['external_id']}", r["collection"], r["title"])
            for r in rows
        ],
    )
    return f"{HEADINGS['most_retrieved']} (top {limit})\n{table}"


def _never(section: dict[str, Any]) -> str:
    counts = ", ".join(f"{name} {count}" for name, count in section["by_collection"].items()) or "-"
    table = _table(
        ("collection", "document", "title"),
        [(d["collection"], f"{d['source']}:{d['external_id']}", d["title"]) for d in section["sample"]],
    )
    return f"{HEADINGS['never_retrieved']}\n  total {section['total']}; by collection: {counts}\n{table}"


def _empty(section: dict[str, Any]) -> str:
    table = _table(
        ("retrieved_at", "session", "collection", "tool", "query", "filters"),
        [
            (q["retrieved_at"], q["session_id"], q["collection"], q["tool"], q["query"],
             json.dumps(q["filters"], sort_keys=True))
            for q in section["queries"]
        ],
    )
    return f"{HEADINGS['empty_queries']} ({section['total']} total, most recent first)\n{table}"


def _similarity(section: dict[str, Any]) -> str:
    table = _table(
        ("bucket", "count", "share"),
        [(b["bucket"], b["count"], f"{b['share']:.0%}") for b in section["buckets"]],
    )
    stats = "  ".join(f"{name} {_number(section[name])}" for name in ("min", "median", "max"))
    return f"{HEADINGS['similarity_distribution']}: {section['results']} rows\n{table}\n  {stats}"


def _collections(rows: list[dict[str, Any]]) -> str:
    table = _table(
        ("collection", "retrievals", "results", "empty", "sessions", "tool", "session-start"),
        [
            (r["collection"], r["retrievals"], r["results"], r["empty"], r["sessions"],
             r["channels"]["tool"], r["channels"]["session-start"])
            for r in rows
        ],
    )
    return f"{HEADINGS['per_collection']}\n{table}"


def _cross(section: dict[str, Any]) -> str:
    table = _table(
        ("retrieved_at", "session", "note", "filter", "query"),
        [
            (r["retrieved_at"], r["session_id"], r["note_collection"], r["filter_collection"], r["query"])
            for r in section["retrievals"]
        ],
    )
    return f"{HEADINGS['cross_collection']}: {section['total']}\n{table}"


def _table(headers: tuple[str, ...], rows: list[tuple[Any, ...]]) -> str:
    if not rows:
        return "  (none)"
    cells = [tuple(headers), *(tuple(_cell(v) for v in row) for row in rows)]
    widths = [max(len(line[i]) for line in cells) for i in range(len(headers))]
    return "\n".join("  " + "  ".join(c.ljust(w) for c, w in zip(line, widths)).rstrip() for line in cells)


def _cell(value: Any) -> str:
    text = "-" if value is None else str(value).replace("\n", " ")
    return text if len(text) <= MAX_TEXT else text[: MAX_TEXT - 3] + "..."


def _number(value: float | None) -> str:
    return "-" if value is None else f"{value:.3f}"
