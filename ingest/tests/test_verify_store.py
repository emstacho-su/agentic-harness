"""PostgresReader: the audit's SQL, and the read-only guard that comes before it."""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from ingest import verify_store
from ingest.config import DbSettings
from ingest.errors import ConfigError, StoreError
from ingest.verify import ChunkText, DocumentRow, NormRow, SampledChunk, VaultRow
from ingest.verify_store import READ_ONLY_GUARD, PostgresReader, parse_vector

WRITE_KEYWORDS = ("INSERT", "UPDATE", "DELETE", "TRUNCATE", "ALTER", "DROP", "CREATE")


class FakeCursor:
    def __init__(self, connection: "FakeConnection") -> None:
        self.connection = connection
        self._rows: list[tuple] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.connection.log.append((sql.strip(), params))
        if self.connection.raise_on and self.connection.raise_on in sql:
            raise RuntimeError("simulated database error")
        self._rows = next(
            (rows for marker, rows in self.connection.responses.items() if marker in sql), []
        )

    def fetchall(self):
        return list(self._rows)


class FakeConnection:
    """Answers each query with the rows registered under a substring of its SQL."""

    def __init__(self, responses: dict[str, list[tuple]] | None = None, raise_on: str | None = None) -> None:
        self.responses = responses or {}
        self.raise_on = raise_on
        self.log: list[tuple[str, object]] = []
        self.closed = False

    def cursor(self):
        return FakeCursor(self)

    def close(self):
        self.closed = True

    def statements(self) -> list[str]:
        return [sql for sql, _ in self.log]


# -- the read-only guard ------------------------------------------------------------


def test_the_first_statement_makes_the_session_read_only() -> None:
    conn = FakeConnection()
    PostgresReader(conn)

    assert conn.statements() == [READ_ONLY_GUARD]
    assert READ_ONLY_GUARD == "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY"


def test_the_guard_still_comes_first_when_queries_follow() -> None:
    conn = FakeConnection()
    reader = PostgresReader(conn)
    reader.documents()
    reader.chunk_ids()

    assert conn.statements()[0] == READ_ONLY_GUARD
    assert len(conn.statements()) == 3


def test_a_failing_guard_is_a_store_error_and_closes_the_connection() -> None:
    conn = FakeConnection(raise_on="READ ONLY")

    with pytest.raises(StoreError, match="read-only"):
        PostgresReader(conn)
    assert conn.closed


def test_no_statement_in_the_module_writes() -> None:
    statements = [value for name, value in vars(verify_store).items()
                  if name.startswith("_SELECT") and isinstance(value, str)]
    assert len(statements) >= 6
    for sql in statements:
        assert sql.lstrip().upper().startswith("SELECT")
        words = set(sql.upper().replace("(", " ").replace(")", " ").split())
        assert not words & set(WRITE_KEYWORDS), sql


def test_from_settings_opens_an_autocommit_connection_and_guards_it(monkeypatch) -> None:
    import psycopg

    captured: dict[str, object] = {}
    conn = FakeConnection()

    def fake_connect(url, **kwargs):
        captured["url"], captured["kwargs"] = url, kwargs
        return conn

    monkeypatch.setattr(psycopg, "connect", fake_connect)
    settings = DbSettings(database_url="postgresql://example/db", supabase_url=None,
                          supabase_service_role=None, ssl_disabled=True)

    PostgresReader.from_settings(settings)

    assert captured["kwargs"]["autocommit"] is True
    assert captured["kwargs"]["sslmode"] == "disable"
    assert conn.statements()[0] == READ_ONLY_GUARD


def test_from_settings_without_a_database_url_is_a_config_error() -> None:
    settings = DbSettings(database_url=None, supabase_url=None, supabase_service_role=None)
    with pytest.raises(ConfigError, match="DATABASE_URL"):
        PostgresReader.from_settings(settings)


def test_a_failed_connect_is_a_store_error_without_the_url(monkeypatch) -> None:
    import psycopg

    def refuse(url, **kwargs):
        raise psycopg.OperationalError("connection refused")

    monkeypatch.setattr(psycopg, "connect", refuse)
    settings = DbSettings(database_url="postgresql://user:secret@example/db", supabase_url=None,
                          supabase_service_role=None, ssl_disabled=True)

    with pytest.raises(StoreError) as caught:
        PostgresReader.from_settings(settings)
    assert "secret" not in str(caught.value)


# -- the queries ------------------------------------------------------------------------


def test_documents_carry_their_sorted_chunk_indexes() -> None:
    conn = FakeConnection({"array_agg": [(1, "obsidian", "a.md", [0, 1, 2]), (2, "claude-mem", "461", None)]})

    rows = PostgresReader(conn).documents()

    assert rows == (DocumentRow(1, "obsidian", "a.md", (0, 1, 2)), DocumentRow(2, "claude-mem", "461", ()))
    sql = conn.statements()[1]
    assert "LEFT JOIN rag.chunks" in sql
    assert "ORDER BY c.chunk_index" in sql


def test_embedding_norms_use_pgvector_and_keep_nulls() -> None:
    conn = FakeConnection({"vector_norm": [(5, "obsidian", "a.md", 0, 1.0000001), (6, "obsidian", "a.md", 1, None)]})

    rows = PostgresReader(conn).embedding_norms()

    assert rows == (NormRow(5, "obsidian", "a.md", 0, 1.0000001), NormRow(6, "obsidian", "a.md", 1, None))
    assert "extensions.vector_norm(c.embedding)" in conn.statements()[1]


def test_chunk_texts_return_content_and_the_stored_count() -> None:
    conn = FakeConnection({"c.token_count": [(5, "obsidian", "a.md", 0, "hello world", 2)]})

    assert PostgresReader(conn).chunk_texts() == (ChunkText(5, "obsidian", "a.md", 0, "hello world", 2),)


def test_vault_rows_of_a_realm_use_the_stores_containment_predicate() -> None:
    written = datetime(2026, 9, 27, 19, 38, tzinfo=timezone.utc)
    conn = FakeConnection({"content_hash": [("a.md", "abc", "a.md", written), ("uuid-1", "def", None, written)]})

    rows = PostgresReader(conn).vault_rows("projects")

    assert rows == (VaultRow("a.md", "abc", "a.md", written), VaultRow("uuid-1", "def", None, written))
    sql, params = conn.log[1]
    assert "metadata -> '_ingest' ->> 'path', updated_at" in sql
    assert "metadata @> %s::jsonb" in sql
    assert params[0] == "obsidian"
    assert json.loads(params[1]) == {"_ingest": {"realm": "projects"}}


def test_vault_rows_without_a_realm_are_the_legacy_rows() -> None:
    conn = FakeConnection()

    PostgresReader(conn).vault_rows(None)

    sql, params = conn.log[1]
    assert "NOT (metadata ? '_ingest' AND metadata->'_ingest' ? 'realm')" in sql
    assert params == ("obsidian",)


def test_chunk_ids_come_back_as_ints() -> None:
    conn = FakeConnection({"SELECT id FROM rag.chunks": [(3,), (1,), (2,)]})

    assert PostgresReader(conn).chunk_ids() == (3, 1, 2)


def test_chunks_by_id_fetch_content_and_parse_the_vector() -> None:
    conn = FakeConnection({"ANY(%s)": [(5, "obsidian", "a.md", 0, "hello", "[0.6,0.8]"),
                                       (6, "obsidian", "a.md", 1, "world", None)]})

    rows = PostgresReader(conn).chunks_by_id([5, 6])

    assert rows == (
        SampledChunk(5, "obsidian", "a.md", 0, "hello", (0.6, 0.8)),
        SampledChunk(6, "obsidian", "a.md", 1, "world", None),
    )
    assert conn.log[1][1] == ([5, 6],)
    assert "embedding::text" in conn.statements()[1]


def test_chunks_by_id_with_no_ids_runs_no_query() -> None:
    conn = FakeConnection()

    assert PostgresReader(conn).chunks_by_id([]) == ()
    assert conn.statements() == [READ_ONLY_GUARD]


def test_a_failed_query_is_a_store_error() -> None:
    conn = FakeConnection(raise_on="vector_norm")

    with pytest.raises(StoreError, match="embedding norms"):
        PostgresReader(conn).embedding_norms()


def test_close_closes_the_connection() -> None:
    conn = FakeConnection()
    PostgresReader(conn).close()
    assert conn.closed


@pytest.mark.parametrize(
    ("text", "expected"),
    [("[1,2.5,-3e-2]", (1.0, 2.5, -0.03)), ("[]", ()), (" [0.5] ", (0.5,))],
)
def test_parse_vector_reads_the_pgvector_text_form(text: str, expected: tuple[float, ...]) -> None:
    assert parse_vector(text) == expected


@pytest.mark.parametrize("text", ["1,2", "[1,x]", "[nan]", "{1,2}"])
def test_parse_vector_refuses_anything_else(text: str) -> None:
    with pytest.raises(StoreError):
        parse_vector(text)
