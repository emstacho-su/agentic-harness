"""R-C6's usage features: how often each vault note was retrieved and used
(curate/retrieval_counts.py), read from ``rag.retrieval_events``.

The Postgres reader runs against the fake connection of ``test_curate_store``;
no test here opens a database.
"""

from __future__ import annotations

import pytest

from ingest.config import DbSettings
from ingest.curate import retrieval_counts
from ingest.curate.retrieval_counts import (
    OBSIDIAN_SOURCE,
    DictRetrievalCounts,
    PostgresRetrievalCounts,
    RetrievalCounts,
)
from ingest.errors import ConfigError, StoreError

from test_curate_store import FakeConnection


# -- the fake ------------------------------------------------------------------------------------


def test_the_dict_fake_answers_only_the_ids_it_knows() -> None:
    counts = DictRetrievalCounts({"session-a": (4, 1), "session-b": (0, 0)})

    assert counts.counts(["session-a", "session-z"]) == {"session-a": (4, 1)}
    assert counts.counts([]) == {}
    assert counts.asked == [("session-a", "session-z"), ()]


def test_the_dict_fake_refuses_nonsense_counts() -> None:
    with pytest.raises(ValueError):
        DictRetrievalCounts({"a": (1, 2)})  # used cannot exceed retrievals
    with pytest.raises(ValueError):
        DictRetrievalCounts({"a": (-1, 0)})


def test_both_readers_satisfy_the_protocol() -> None:
    reader: RetrievalCounts = DictRetrievalCounts({})
    assert callable(reader.counts)
    assert callable(PostgresRetrievalCounts(FakeConnection()).counts)


# -- the Postgres reader -------------------------------------------------------------------------


def test_one_parameterized_query_over_obsidian_rows_grouped_by_external_id() -> None:
    conn = FakeConnection({"FROM rag.retrieval_events": [("session-a", 5, 2), ("notes/x.md", 1, 0)]})

    found = PostgresRetrievalCounts(conn).counts(["session-a", "notes/x.md", "session-none"])

    assert found == {"session-a": (5, 2), "notes/x.md": (1, 0)}
    queries = [(sql, params) for sql, params in conn.log if "rag.retrieval_events" in sql]
    assert len(queries) == 1
    sql, params = queries[0]
    assert sql == retrieval_counts.COUNTS_SQL
    assert "FROM rag.retrieval_events" in sql and "GROUP BY external_id" in sql
    assert "source = %s" in sql and "external_id = ANY(%s)" in sql
    assert params == (OBSIDIAN_SOURCE, ["session-a", "notes/x.md", "session-none"])
    assert OBSIDIAN_SOURCE == "obsidian"
    for value in ("session-a", "notes/x.md", "obsidian"):
        assert value not in sql


def test_the_read_is_read_only_and_ends_in_a_rollback() -> None:
    conn = FakeConnection({"FROM rag.retrieval_events": []})

    PostgresRetrievalCounts(conn).counts(["a"])

    statements = [sql for sql, _ in conn.log]
    assert statements[0] == retrieval_counts.READ_ONLY_SQL
    assert all(not sql.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE")) for sql in statements)
    assert conn.rollbacks == 1 and conn.commits == 0


def test_no_ids_is_no_query() -> None:
    conn = FakeConnection()

    assert PostgresRetrievalCounts(conn).counts([]) == {}
    assert conn.log == []


def test_ids_are_asked_once_each() -> None:
    conn = FakeConnection({"FROM rag.retrieval_events": []})

    PostgresRetrievalCounts(conn).counts(["a", "b", "a"])

    assert conn.log[-1][1] == (OBSIDIAN_SOURCE, ["a", "b"])


def test_a_query_error_is_a_store_error_and_rolls_back() -> None:
    conn = FakeConnection(raise_on="rag.retrieval_events",
                          error=RuntimeError('relation "rag.retrieval_events" does not exist'))

    with pytest.raises(StoreError, match="retrieval counts"):
        PostgresRetrievalCounts(conn).counts(["a"])
    assert conn.rollbacks >= 1


def test_a_missing_table_says_to_migrate() -> None:
    class UndefinedTable(Exception):
        pass

    conn = FakeConnection(raise_on="rag.retrieval_events", error=UndefinedTable("relation does not exist"))

    with pytest.raises(StoreError, match="db migrate"):
        PostgresRetrievalCounts(conn).counts(["a"])


def test_a_malformed_row_is_a_store_error() -> None:
    conn = FakeConnection({"FROM rag.retrieval_events": [("a", "many", None)]})

    with pytest.raises(StoreError, match="malformed"):
        PostgresRetrievalCounts(conn).counts(["a"])


def test_an_error_does_not_leak_the_url() -> None:
    url = "postgresql://user:hunter2@db.example/db"
    conn = FakeConnection(raise_on="rag.retrieval_events",
                          error=RuntimeError(f"lost {url} (password hunter2)"))

    with pytest.raises(StoreError) as caught:
        PostgresRetrievalCounts(conn, database_url=url).counts(["a"])
    assert "hunter2" not in str(caught.value)


def test_close_closes_the_connection() -> None:
    conn = FakeConnection()
    PostgresRetrievalCounts(conn).close()
    assert conn.closed


def test_from_settings_uses_the_shared_connect_kwargs(monkeypatch) -> None:
    import psycopg

    captured: dict[str, object] = {}

    def fake_connect(url, **kwargs):
        captured.update(kwargs)
        return FakeConnection()

    monkeypatch.setattr(psycopg, "connect", fake_connect)
    settings = DbSettings(database_url="postgresql://example/db", supabase_url=None,
                          supabase_service_role=None, ssl_disabled=True)
    PostgresRetrievalCounts.from_settings(settings)

    assert captured["sslmode"] == "disable" and captured["autocommit"] is False


def test_from_settings_without_a_url_is_a_config_error() -> None:
    settings = DbSettings(database_url=None, supabase_url=None, supabase_service_role=None)
    with pytest.raises(ConfigError, match="DATABASE_URL"):
        PostgresRetrievalCounts.from_settings(settings)


def test_a_failed_connect_is_a_store_error_without_the_password(monkeypatch) -> None:
    import psycopg

    url = "postgresql://user:hunter2@db.example/db"

    def refuse(target, **kwargs):
        raise psycopg.OperationalError(f"could not connect to {target} with password hunter2")

    monkeypatch.setattr(psycopg, "connect", refuse)
    settings = DbSettings(database_url=url, supabase_url=None, supabase_service_role=None,
                          ssl_disabled=True)
    with pytest.raises(StoreError) as caught:
        PostgresRetrievalCounts.from_settings(settings)
    assert "hunter2" not in str(caught.value)
