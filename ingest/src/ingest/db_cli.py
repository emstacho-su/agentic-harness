"""``uv run ingest db migrate`` — the schema, on any DATABASE_URL.

    uv run ingest db migrate --dry-run     # what is applied, what is pending
    uv run ingest db migrate               # apply what is pending

Against a fresh local pgvector Postgres this creates the whole schema. Against
harness-memory, which was migrated by hand, the first run seeds the ledger and
runs nothing.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .config import load_db_settings
from .envfile import load_env_file
from .errors import ConfigError, IngestError
from .migrations import DEFAULT_MIGRATIONS_DIR, MigrationReport, run_migrations
from .store import connect_kwargs

SUBCOMMAND = "db"

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2


def build_db_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=f"ingest {SUBCOMMAND}", description="Database maintenance.")
    actions = parser.add_subparsers(dest="action", required=True)
    migrate = actions.add_parser("migrate", help="apply db/migrations/*.sql that are not yet applied")
    migrate.add_argument("--dry-run", action="store_true", help="report the plan; apply nothing")
    migrate.add_argument(
        "--migrations-dir", default=str(DEFAULT_MIGRATIONS_DIR), help="where the .sql files are"
    )
    migrate.add_argument("--env-file", default=None, help="explicit .env path")
    migrate.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return parser


def run_db(argv: list[str], *, connection=None) -> int:
    """Run the subcommand. ``connection`` is injectable for tests."""
    args = build_db_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    owned = None
    try:
        if connection is None:
            load_env_file(Path(args.env_file) if args.env_file else None)
            owned = _connect()
            connection = owned
        report = run_migrations(connection, args.migrations_dir, dry_run=args.dry_run)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_FAILED
    finally:
        if owned is not None:
            owned.close()

    print(_as_text(report, Path(args.migrations_dir), dry_run=args.dry_run))
    return EXIT_OK


def _connect():
    settings = load_db_settings()
    if not settings.database_url:
        raise ConfigError("DATABASE_URL is not set; db migrate needs the database it is migrating.")
    import psycopg

    options = {**connect_kwargs(settings), "autocommit": False}
    try:
        return psycopg.connect(settings.database_url, **options)
    except psycopg.Error as exc:
        raise IngestError(f"Could not connect to the database: {exc}") from exc


def _as_text(report: MigrationReport, directory: Path, *, dry_run: bool) -> str:
    lines = [f"{len(report.already)} already applied, {len(report.pending) if dry_run else len(report.applied)} pending"]
    if report.seeded:
        lines.append(
            "the store predates the ledger: every migration "
            + ("would be" if dry_run else "was")
            + " recorded as applied, none run"
        )
    for version in report.pending:
        lines.append(f"  pending  {_label(version, directory)}")
    for version in report.applied:
        lines.append(f"  applied  {_label(version, directory)}")
    return "\n".join(lines)


def _label(version: str, directory: Path) -> str:
    for path in directory.glob(f"{version}_*.sql"):
        return path.stem
    return version
