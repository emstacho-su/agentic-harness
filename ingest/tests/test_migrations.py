"""``ingest db migrate``: the mirrored SQL files applied to any DATABASE_URL.

Until now the files in db/migrations were applied by hand through the Supabase
MCP tool. A second machine with a local Postgres needs the same schema from the
same files, in the same order, exactly once.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ingest.db_cli import run_db
from ingest.errors import ConfigError, StoreError
from ingest.migrations import (
    LEDGER_TABLE,
    PREAMBLE,
    Migration,
    discover,
    run_migrations,
)


def write_migrations(directory: Path, names: list[str]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name in names:
        (directory / name).write_text(f"-- {name}\nselect 1;\n", encoding="utf-8")


class FakeCursor:
    def __init__(self, connection) -> None:
        self.connection = connection
        self._rows: list[tuple] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        text = " ".join(sql.split())
        self.connection.log.append((text, params))
        if self.connection.fail_on and self.connection.fail_on in text:
            raise RuntimeError("simulated database error")
        if "to_regclass" in text:
            self._rows = [("rag.documents",)] if self.connection.documents_exist else [(None,)]
        elif f"from {LEDGER_TABLE}" in text:
            self._rows = [(version,) for version in sorted(self.connection.applied)]
        elif f"insert into {LEDGER_TABLE}" in text:
            self.connection.pending_ledger.append(params[0])
            self._rows = []
        else:
            self._rows = []

    def fetchall(self):
        return list(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None


class FakeConnection:
    """Enough of psycopg to see what the runner executed, in which transaction."""

    def __init__(self, *, applied=(), documents_exist=False, fail_on: str | None = None) -> None:
        self.applied = set(applied)
        self.documents_exist = documents_exist
        self.fail_on = fail_on
        self.log: list[tuple[str, object]] = []
        self.pending_ledger: list[str] = []
        self.commits: list[list[str]] = []
        self.rollbacks = 0

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits.append(list(self.pending_ledger))
        self.applied.update(self.pending_ledger)
        self.pending_ledger = []

    def rollback(self):
        self.rollbacks += 1
        self.pending_ledger = []

    def statements(self) -> list[str]:
        return [entry[0] for entry in self.log]


# -- discovery ------------------------------------------------------------------


def test_discover_orders_by_version_and_reads_the_body(tmp_path: Path):
    write_migrations(tmp_path, ["20260915144257_b.sql", "20260909175037_a.sql"])
    found = discover(tmp_path)
    assert [m.version for m in found] == ["20260909175037", "20260915144257"]
    assert found[0].name == "a"
    assert "select 1" in found[0].sql


@pytest.mark.parametrize("bad", ["notes.sql", "2026_a.sql", "20260909175037.sql"])
def test_discover_refuses_a_file_that_is_not_version_name(tmp_path: Path, bad: str):
    write_migrations(tmp_path, [bad])
    with pytest.raises(ConfigError, match=bad):
        discover(tmp_path)


def test_discover_refuses_a_missing_directory(tmp_path: Path):
    with pytest.raises(ConfigError, match="absent"):
        discover(tmp_path / "absent")


# -- the runner -----------------------------------------------------------------


def test_a_fresh_database_gets_the_preamble_then_every_migration_in_order(tmp_path: Path):
    write_migrations(tmp_path, ["20260909175037_a.sql", "20260915144257_b.sql"])
    conn = FakeConnection()
    report = run_migrations(conn, tmp_path)

    statements = conn.statements()
    for statement in PREAMBLE:
        assert " ".join(statement.split()) in statements
    assert statements.index(" ".join(PREAMBLE[0].split())) < statements.index("-- 20260909175037_a.sql select 1;")
    assert report.applied == ("20260909175037", "20260915144257")
    assert report.already == ()
    assert report.seeded is False
    # One migration per transaction, its ledger row in the same one.
    assert conn.commits[-2:] == [["20260909175037"], ["20260915144257"]]


def test_a_second_run_applies_nothing(tmp_path: Path):
    write_migrations(tmp_path, ["20260909175037_a.sql"])
    conn = FakeConnection(applied=["20260909175037"])
    report = run_migrations(conn, tmp_path)
    assert report.applied == ()
    assert report.already == ("20260909175037",)
    assert "select 1;" not in " ".join(conn.statements())


def test_a_store_that_predates_the_ledger_is_seeded_not_re_migrated(tmp_path: Path):
    # harness-memory already has every migration applied by hand. Running the
    # files again would fail on the first `create table`; seed the ledger instead.
    write_migrations(tmp_path, ["20260909175037_a.sql", "20260915144257_b.sql"])
    conn = FakeConnection(documents_exist=True)
    report = run_migrations(conn, tmp_path)
    assert report.seeded is True
    assert report.applied == ()
    assert conn.applied == {"20260909175037", "20260915144257"}
    assert "select 1;" not in " ".join(conn.statements())


def test_dry_run_lists_pending_and_writes_nothing(tmp_path: Path):
    write_migrations(tmp_path, ["20260909175037_a.sql", "20260915144257_b.sql"])
    conn = FakeConnection(applied=["20260909175037"])
    report = run_migrations(conn, tmp_path, dry_run=True)
    assert report.pending == ("20260915144257",)
    assert report.applied == ()
    assert conn.commits == []
    assert "select 1;" not in " ".join(conn.statements())


def test_a_failing_migration_rolls_back_and_names_itself(tmp_path: Path):
    write_migrations(tmp_path, ["20260909175037_a.sql", "20260915144257_b.sql"])
    (tmp_path / "20260915144257_b.sql").write_text("boom;\n", encoding="utf-8")
    conn = FakeConnection(fail_on="boom")
    with pytest.raises(StoreError, match="20260915144257_b"):
        run_migrations(conn, tmp_path)
    assert conn.rollbacks == 1
    assert conn.applied == {"20260909175037"}, "the migration before it stays applied"


# -- command line ---------------------------------------------------------------


def test_the_command_refuses_to_run_without_a_database(monkeypatch, tmp_path: Path, capsys):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("HARNESS_MACHINE_ENV", str(tmp_path / "absent.env"))
    empty = tmp_path / "empty.env"
    empty.write_text("# nothing\n", encoding="utf-8")
    code = run_db(["migrate", "--dry-run", "--env-file", str(empty)])
    assert code == 2
    assert "DATABASE_URL" in capsys.readouterr().err


def test_the_command_reports_the_plan(tmp_path: Path, capsys):
    write_migrations(tmp_path, ["20260909175037_a.sql", "20260915144257_b.sql"])
    conn = FakeConnection(applied=["20260909175037"])
    code = run_db(["migrate", "--dry-run", "--migrations-dir", str(tmp_path)], connection=conn)
    out = capsys.readouterr().out
    assert code == 0
    assert "1 already applied" in out and "1 pending" in out
    assert "20260915144257_b" in out


def test_migration_is_a_frozen_record():
    migration = Migration(version="1", name="a", path=Path("a.sql"), sql="select 1")
    with pytest.raises(AttributeError):
        migration.sql = "x"  # type: ignore[misc]
