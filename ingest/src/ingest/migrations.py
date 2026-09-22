"""Apply ``db/migrations/*.sql`` to any DATABASE_URL, in order, exactly once.

The files are a byte-for-byte mirror of what the Supabase MCP tool applied to
``harness-memory``; nothing else may edit them. This runner exists so a second
machine's local Postgres gets the same schema from the same files:

* filename order is apply order (``<14-digit version>_<name>.sql``);
* each migration runs in its own transaction with its ledger row, so a failure
  leaves the ones before it applied and the failing one not;
* a store that already carries ``rag.documents`` but no ledger — the Supabase
  project, migrated by hand — is *seeded*: every file is recorded as applied and
  nothing is run. Running ``create table`` twice would fail, and it did run.

The preamble is not in the mirrored files because Supabase has an
``extensions`` schema and a plain Postgres does not; ``create schema if not
exists`` is a no-op where it exists.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

from .errors import ConfigError, StoreError

log = logging.getLogger(__name__)

# ingest/src/ingest/migrations.py -> <repo>/db/migrations
DEFAULT_MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "db" / "migrations"

FILENAME = re.compile(r"^(?P<version>\d{14})_(?P<name>[A-Za-z0-9_-]+)\.sql$")

LEDGER_SCHEMA = "rag_meta"
LEDGER_TABLE = f"{LEDGER_SCHEMA}.schema_migrations"

PREAMBLE = (
    "create schema if not exists extensions",
    f"create schema if not exists {LEDGER_SCHEMA}",
    f"create table if not exists {LEDGER_TABLE} ("
    " version text primary key,"
    " name text not null,"
    " applied_at timestamptz not null default now())",
)

_SELECT_APPLIED = f"select version from {LEDGER_TABLE}"
_INSERT_APPLIED = f"insert into {LEDGER_TABLE} (version, name) values (%s, %s)"
_DOCUMENTS_EXIST = "select to_regclass('rag.documents')"


@dataclass(frozen=True)
class Migration:
    version: str
    name: str
    path: Path
    sql: str


@dataclass(frozen=True)
class MigrationReport:
    already: tuple[str, ...]
    pending: tuple[str, ...]
    applied: tuple[str, ...]
    seeded: bool


def discover(directory: str | Path = DEFAULT_MIGRATIONS_DIR) -> tuple[Migration, ...]:
    """Every migration in ``directory``, in version order. Any stray file is a ConfigError."""
    root = Path(directory)
    if not root.is_dir():
        raise ConfigError(f"migrations directory does not exist: {root}")
    found: list[Migration] = []
    for path in sorted(root.iterdir()):
        if not path.is_file() or path.suffix.lower() != ".sql":
            continue
        match = FILENAME.match(path.name)
        if not match:
            raise ConfigError(
                f"{path.name} is not <version>_<name>.sql (14-digit version, then a name)"
            )
        try:
            sql = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise ConfigError(f"could not read {path}: {exc}") from exc
        found.append(Migration(match["version"], match["name"], path, sql))
    return tuple(found)


def run_migrations(
    connection, directory: str | Path = DEFAULT_MIGRATIONS_DIR, *, dry_run: bool = False
) -> MigrationReport:
    """Bring ``connection``'s database up to the last file in ``directory``."""
    migrations = discover(directory)
    if dry_run:
        # A dry run still needs the ledger to exist to be read, but must not
        # create it: report against what is there, creating nothing.
        already = _applied_versions(connection, tolerate_missing=True)
        seeded = not already and _documents_exist(connection)
        pending = () if seeded else tuple(m.version for m in migrations if m.version not in already)
        connection.rollback()
        return MigrationReport(
            already=tuple(sorted(already)), pending=pending, applied=(), seeded=seeded
        )

    _run_preamble(connection)
    already = _applied_versions(connection)

    seeded = False
    if not already and _documents_exist(connection):
        # Migrated by hand before the ledger existed: record, do not re-run.
        for migration in migrations:
            _record(connection, migration)
        connection.commit()
        log.info("Ledger seeded with %d migration(s) already present", len(migrations))
        return MigrationReport(
            already=tuple(m.version for m in migrations), pending=(), applied=(), seeded=True
        )

    applied: list[str] = []
    for migration in migrations:
        if migration.version in already:
            continue
        _apply(connection, migration)
        applied.append(migration.version)
    return MigrationReport(
        already=tuple(sorted(already)), pending=(), applied=tuple(applied), seeded=seeded
    )


def _run_preamble(connection) -> None:
    try:
        with connection.cursor() as cur:
            for statement in PREAMBLE:
                cur.execute(statement)
        connection.commit()
    except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
        connection.rollback()
        raise StoreError(f"could not prepare the migration ledger: {exc}") from exc


def _applied_versions(connection, *, tolerate_missing: bool = False) -> set[str]:
    try:
        with connection.cursor() as cur:
            cur.execute(_SELECT_APPLIED)
            return {str(row[0]) for row in cur.fetchall()}
    except Exception as exc:  # noqa: BLE001
        connection.rollback()
        if tolerate_missing and "does not exist" in str(exc).lower():
            return set()
        raise StoreError(f"could not read {LEDGER_TABLE}: {exc}") from exc


def _documents_exist(connection) -> bool:
    with connection.cursor() as cur:
        cur.execute(_DOCUMENTS_EXIST)
        row = cur.fetchone()
    return bool(row and row[0])


def _record(connection, migration: Migration) -> None:
    with connection.cursor() as cur:
        cur.execute(_INSERT_APPLIED, (migration.version, migration.name))


def _apply(connection, migration: Migration) -> None:
    label = f"{migration.version}_{migration.name}"
    try:
        with connection.cursor() as cur:
            cur.execute(migration.sql)
        _record(connection, migration)
        connection.commit()
    except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
        connection.rollback()
        raise StoreError(f"migration {label} failed and was rolled back: {exc}") from exc
    log.info("Applied %s", label)
