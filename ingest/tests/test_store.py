"""PostgresStore SQL and transaction behaviour, against a fake connection."""

from __future__ import annotations

import json

import pytest

from ingest.config import DbSettings
from ingest.errors import ConfigError, StoreError
from ingest.models import Chunk, SourceDocument
from ingest.store import NullStore, PostgresStore


class FakeCursor:
    def __init__(self, connection) -> None:
        self.connection = connection

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.connection.log.append(("execute", sql.strip(), params))
        if self.connection.raise_on and self.connection.raise_on in sql:
            raise RuntimeError("simulated database error")

    def executemany(self, sql, seq):
        self.connection.log.append(("executemany", sql.strip(), list(seq)))
        if self.connection.raise_on and self.connection.raise_on in sql:
            raise RuntimeError("simulated database error")

    def fetchone(self):
        return self.connection.next_row

    def fetchall(self):
        return self.connection.next_rows

    @property
    def rowcount(self):
        return self.connection.rowcount


class FakeConnection:
    def __init__(self, next_row=(7, True), raise_on: str | None = None) -> None:
        self.log: list[tuple] = []
        self.next_row = next_row
        self.next_rows: list[tuple] = []
        self.rowcount = 0
        self.raise_on = raise_on
        self.commits = 0
        self.rollbacks = 0
        self.closed = False

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True

    def statements(self) -> list[str]:
        return [entry[1] for entry in self.log]


def document(collection: str | None = None) -> SourceDocument:
    return SourceDocument(
        source="obsidian",
        external_id="notes/a.md",
        body="Body text.",
        title="A",
        agent="claude-code",
        collection=collection,
        metadata={"tags": ["rag"], "_ingest": {"path": "notes/a.md"}},
    )


CHUNKS = (Chunk(0, "first chunk", 3), Chunk(1, "second chunk", 3))
VECTORS = ([0.1] * 384, [0.2] * 384)


# --------------------------------------------------------------------------


def test_state_lookup_uses_the_upsert_key():
    conn = FakeConnection(next_row=(12, "abc123", "A", {"tags": ["rag"]}))
    state = PostgresStore(conn).get_document_state("obsidian", "notes/a.md")

    assert state is not None
    assert (state.document_id, state.content_hash) == (12, "abc123")
    sql, params = conn.log[0][1], conn.log[0][2]
    assert "source = %s AND external_id = %s" in sql
    assert params == ("obsidian", "notes/a.md")


def test_state_lookup_returns_the_stored_title_and_metadata():
    """The pipeline needs both to spot a frontmatter-only edit; the hash cannot."""
    conn = FakeConnection(next_row=(12, "abc123", "A title", {"status": "concluded"}))
    state = PostgresStore(conn).get_document_state("obsidian", "notes/a.md")

    assert state.title == "A title"
    assert state.metadata == {"status": "concluded"}
    assert "metadata" in conn.log[0][1]


@pytest.mark.parametrize(
    "stored, expected",
    [
        ({"a": 1}, {"a": 1}),
        ('{"a": 1}', {"a": 1}),      # a connection without the json loader
        (None, {}),
        ("not json at all", {}),
        ([1, 2], {}),                # a JSON array is not metadata
    ],
)
def test_metadata_column_shapes_all_come_back_as_a_dict(stored, expected):
    conn = FakeConnection(next_row=(12, "abc123", None, stored))
    state = PostgresStore(conn).get_document_state("obsidian", "notes/a.md")

    assert state.metadata == expected
    assert state.title is None


def test_metadata_update_touches_no_chunk_and_commits_once():
    conn = FakeConnection()
    PostgresStore(conn).update_document_metadata(12, "A title", {"status": "superseded"})

    statements = conn.statements()
    assert len(statements) == 1
    assert statements[0].startswith("UPDATE rag.documents")
    assert "%s::jsonb" in statements[0]
    assert "rag.chunks" not in statements[0]
    assert conn.commits == 1
    assert conn.rollbacks == 0

    params = conn.log[0][2]
    assert params[0] == "A title"
    assert json.loads(params[1]) == {"status": "superseded"}
    assert params[2] == 12


def test_a_failed_metadata_update_rolls_back_and_raises_a_typed_error():
    conn = FakeConnection(raise_on="UPDATE rag.documents")
    with pytest.raises(StoreError, match="Metadata update"):
        PostgresStore(conn).update_document_metadata(12, None, {})
    assert conn.rollbacks >= 1
    assert conn.commits == 0


def test_metadata_update_refuses_a_non_integer_document_id():
    conn = FakeConnection()
    with pytest.raises(StoreError, match="document_id"):
        PostgresStore(conn).update_document_metadata("12", None, {})
    assert conn.statements() == []


def test_null_store_refuses_a_metadata_update():
    with pytest.raises(StoreError):
        NullStore().update_document_metadata(1, "t", {})


def test_missing_document_returns_none():
    conn = FakeConnection(next_row=None)
    assert PostgresStore(conn).get_document_state("obsidian", "nope.md") is None


def test_replace_document_upserts_deletes_then_inserts_and_commits_once():
    conn = FakeConnection()
    document_id, inserted = PostgresStore(conn).replace_document(
        document(), "hash-1", CHUNKS, VECTORS
    )

    statements = conn.statements()
    assert "ON CONFLICT (source, external_id) DO UPDATE" in statements[0]
    assert statements[1].startswith("DELETE FROM rag.chunks")
    assert "INSERT INTO rag.chunks" in statements[2]
    assert conn.commits == 1
    assert conn.rollbacks == 0
    assert (document_id, inserted) == (7, True)


def test_metadata_is_sent_as_json_text_for_the_jsonb_cast():
    conn = FakeConnection()
    PostgresStore(conn).replace_document(document(), "hash-1", CHUNKS, VECTORS)
    params = conn.log[0][2]
    sql = conn.log[0][1]
    assert "%s::jsonb" in sql

    # Bind order is (source, collection, agent, external_id, title, body,
    # metadata, content_hash). Locate by column order rather than a bare
    # literal index, so adding a column fails loudly here instead of silently
    # writing the wrong value into the wrong column.
    columns = [c.strip() for c in sql.split("(", 1)[1].split(")", 1)[0].split(",")]
    assert json.loads(params[columns.index("metadata")])["tags"] == ["rag"]
    assert params[columns.index("content_hash")] == "hash-1"


def test_collection_is_written_so_filter_collection_can_use_it():
    conn = FakeConnection()
    PostgresStore(conn).replace_document(
        document(collection="ev-trainer"), "hash-1", CHUNKS, VECTORS
    )
    sql, params = conn.log[0][1], conn.log[0][2]
    columns = [c.strip() for c in sql.split("(", 1)[1].split(")", 1)[0].split(",")]

    assert "collection" in columns, "collection column missing from the INSERT"
    assert params[columns.index("collection")] == "ev-trainer"
    # An upsert must refresh it too, or a moved document keeps its stale collection.
    assert "collection   = EXCLUDED.collection" in sql or "collection = EXCLUDED.collection" in sql


def test_chunk_rows_carry_index_token_count_and_a_vector_literal():
    conn = FakeConnection()
    PostgresStore(conn).replace_document(document(), "hash-1", CHUNKS, VECTORS)
    rows = conn.log[2][2]

    assert [row[1] for row in rows] == [0, 1]
    assert [row[3] for row in rows] == [3, 3]
    assert rows[0][4].startswith("[") and rows[0][4].endswith("]")
    assert rows[0][4].count(",") == 383
    assert "::extensions.vector" in conn.log[2][1]


def test_update_path_is_reported_as_not_inserted():
    conn = FakeConnection(next_row=(7, False))
    _, inserted = PostgresStore(conn).replace_document(
        document(), "hash-2", CHUNKS, VECTORS
    )
    assert inserted is False


def test_a_failed_insert_rolls_back_and_never_commits():
    conn = FakeConnection(raise_on="INSERT INTO rag.chunks")
    with pytest.raises(StoreError):
        PostgresStore(conn).replace_document(document(), "hash-1", CHUNKS, VECTORS)
    assert conn.commits == 0
    assert conn.rollbacks == 1


def test_mismatched_chunk_and_embedding_counts_are_rejected():
    conn = FakeConnection()
    with pytest.raises(StoreError):
        PostgresStore(conn).replace_document(document(), "h", CHUNKS, VECTORS[:1])
    assert conn.commits == 0


def test_writing_zero_chunks_is_refused():
    conn = FakeConnection()
    with pytest.raises(StoreError):
        PostgresStore(conn).replace_document(document(), "h", (), ())


def test_list_external_ids_is_scoped_to_one_source():
    conn = FakeConnection()
    conn.next_rows = [("a.md",), ("b.md",)]
    ids = PostgresStore(conn).list_external_ids("obsidian")

    assert ids == {"a.md", "b.md"}
    assert conn.log[0][2] == ("obsidian",)
    assert "WHERE source = %s" in conn.log[0][1]


def test_delete_documents_uses_one_statement_and_commits():
    conn = FakeConnection()
    conn.rowcount = 2
    deleted = PostgresStore(conn).delete_documents("obsidian", ["a.md", "b.md"])

    assert deleted == 2
    assert conn.commits == 1
    sql, params = conn.log[0][1], conn.log[0][2]
    assert sql.startswith("DELETE FROM rag.documents")
    assert "external_id = ANY(%s)" in sql
    assert params == ("obsidian", ["a.md", "b.md"])


def test_deleting_nothing_issues_no_sql():
    conn = FakeConnection()
    assert PostgresStore(conn).delete_documents("obsidian", []) == 0
    assert conn.log == []
    assert conn.commits == 0


def test_a_failed_delete_rolls_back():
    conn = FakeConnection(raise_on="DELETE FROM rag.documents")
    with pytest.raises(StoreError):
        PostgresStore(conn).delete_documents("obsidian", ["a.md"])
    assert conn.commits == 0
    assert conn.rollbacks == 1


def test_close_closes_the_connection():
    conn = FakeConnection()
    PostgresStore(conn).close()
    assert conn.closed


# --------------------------------------------------------------------------


def test_missing_database_url_raises_a_clear_config_error():
    settings = DbSettings(database_url=None, supabase_url="x", supabase_service_role="y")
    with pytest.raises(ConfigError) as excinfo:
        PostgresStore.from_settings(settings)
    assert "DATABASE_URL" in str(excinfo.value)


def test_null_store_reports_everything_as_new_and_refuses_writes():
    store = NullStore()
    assert store.get_document_state("obsidian", "a.md") is None
    with pytest.raises(StoreError):
        store.replace_document(document(), "h", CHUNKS, VECTORS)
    store.close()


# --------------------------------------------------------------------------
# TLS: verify-full against the pinned CA, on both connect paths
# --------------------------------------------------------------------------


def _capture_connect(monkeypatch):
    import psycopg

    calls: list[tuple[str, dict]] = []

    def fake_connect(conninfo, **kwargs):
        calls.append((conninfo, kwargs))
        return FakeConnection()

    monkeypatch.setattr(psycopg, "connect", fake_connect)
    return calls


def _settings(tmp_path, **overrides) -> DbSettings:
    ca = tmp_path / "prod-ca.crt"
    ca.write_text("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n")
    fields = {
        "database_url": "postgresql://postgres.ref:pw@pooler.example:5432/postgres",
        "supabase_url": None,
        "supabase_service_role": None,
        "ssl_root_cert": str(ca),
    }
    fields.update(overrides)
    return DbSettings(**fields)


def test_initial_connect_verifies_the_server_against_the_pinned_ca(monkeypatch, tmp_path):
    calls = _capture_connect(monkeypatch)
    settings = _settings(tmp_path)

    PostgresStore.from_settings(settings)

    conninfo, kwargs = calls[0]
    assert conninfo == settings.database_url
    assert kwargs["sslmode"] == "verify-full"
    assert kwargs["sslrootcert"] == settings.ssl_root_cert
    assert kwargs["keepalives"] == 1  # the resilience kwargs survive too


def test_reconnect_uses_the_same_tls_and_keepalive_kwargs(monkeypatch, tmp_path):
    calls = _capture_connect(monkeypatch)
    settings = _settings(tmp_path)
    store = PostgresStore.from_settings(settings)

    assert store._reconnect() is True

    _, initial = calls[0]
    _, again = calls[1]
    assert again == initial, "the retry path must not regress TLS or keepalives"


def test_missing_ca_is_a_config_error_not_a_silent_downgrade(monkeypatch, tmp_path):
    calls = _capture_connect(monkeypatch)
    settings = _settings(tmp_path, ssl_root_cert=None)

    with pytest.raises(ConfigError) as excinfo:
        PostgresStore.from_settings(settings)

    assert "DATABASE_CA_CERT" in str(excinfo.value)
    assert calls == [], "must fail before any connection is attempted"


def test_unreadable_ca_path_is_a_config_error(monkeypatch, tmp_path):
    calls = _capture_connect(monkeypatch)
    settings = _settings(tmp_path, ssl_root_cert=str(tmp_path / "does-not-exist.crt"))

    with pytest.raises(ConfigError) as excinfo:
        PostgresStore.from_settings(settings)

    assert "does-not-exist.crt" in str(excinfo.value)
    assert calls == []


def test_tls_can_be_disabled_explicitly_for_a_local_postgres(monkeypatch, tmp_path):
    calls = _capture_connect(monkeypatch)
    settings = _settings(tmp_path, ssl_root_cert=None, ssl_disabled=True)

    PostgresStore.from_settings(settings)

    _, kwargs = calls[0]
    assert kwargs["sslmode"] == "disable"
    assert "sslrootcert" not in kwargs
