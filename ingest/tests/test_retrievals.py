"""Retrieval provenance (R-P2): parsing SC-1 frontmatter and projecting it.

A session note carries ``retrievals:`` — one entry per search the session made.
Ingest turns each entry into rows of ``rag.retrieval_events`` (one per result, or
one with a null rank for an empty result) and keeps them out of
``documents.metadata``. Everything here runs against fakes.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ingest.migrations import DEFAULT_MIGRATIONS_DIR, discover
from ingest.models import RetrievalEvent, SourceDocument
from ingest.retrievals import parse_retrievals, session_fields_from
from ingest.store import NullStore, PostgresStore

SESSION = {
    "session_id": "1a2b3c4d",
    "parent_session": None,
    "machine": "stack-desktop",
    "collection": "agentic-harness",
    "realm": "projects",
}


def entry(**overrides) -> dict:
    base = {
        "at": "2026-09-24T14:03:11Z",
        "channel": "tool",
        "tool": "search_context",
        "query": "redacted query text",
        "filters": {"collection": "agentic-harness", "limit": 10},
        "results": ["obsidian:session-1a2b@0.8123", "claude-mem:461@0.8540"],
        "chunks": ["1849/4752@0.016393", "581/783@0.016393"],
    }
    return {**base, **overrides}


def parse(value, session=SESSION):
    return parse_retrievals(value, note_external_id="projects/x/sessions/1a2b.md", session_fields=session)


# --------------------------------------------------------------------------
# token grammar
# --------------------------------------------------------------------------


def test_one_row_per_result_in_rank_order():
    events, warnings = parse([entry()])
    assert warnings == []
    assert [(e.rank, e.source, e.external_id, e.similarity) for e in events] == [
        (1, "obsidian", "session-1a2b", 0.8123),
        (2, "claude-mem", "461", 0.8540),
    ]


def test_every_row_carries_the_retrieval_and_the_session():
    event = parse([entry()])[0][0]
    assert event.note_source == "obsidian"
    assert event.note_external_id == "projects/x/sessions/1a2b.md"
    assert event.session_id == "1a2b3c4d"
    assert event.machine == "stack-desktop"
    assert event.collection == "agentic-harness"
    assert event.realm == "projects"
    assert event.parent_session is None
    assert event.channel == "tool"
    assert event.tool == "search_context"
    assert event.query == "redacted query text"
    assert event.filters == {"collection": "agentic-harness", "limit": 10}
    assert event.limit == 10
    assert event.retrieval_index == 0
    assert event.retrieved_at == datetime(2026, 9, 24, 14, 3, 11, tzinfo=timezone.utc)


def test_the_source_splits_on_the_first_colon_and_similarity_on_the_last_at():
    events, _ = parse([entry(results=["claude-mem:summary:12@0.7712"], chunks=[])])
    assert (events[0].source, events[0].external_id, events[0].similarity) == (
        "claude-mem",
        "summary:12",
        0.7712,
    )


def test_a_token_without_at_has_null_similarity():
    events, warnings = parse([entry(tool="get_document", results=["claude-mem:prompt:9"], chunks=None)])
    assert warnings == []
    assert (events[0].external_id, events[0].similarity) == ("prompt:9", None)


def test_an_at_that_is_not_a_number_belongs_to_the_id():
    events, _ = parse([entry(results=["obsidian:notes/me@home.md"], chunks=None)])
    assert (events[0].external_id, events[0].similarity) == ("notes/me@home.md", None)


def test_chunk_tokens_align_with_results_by_index_and_may_be_shorter():
    events, warnings = parse([entry(chunks=["1849/4752@0.016393"])])
    assert warnings == []
    assert (events[0].chunk_id, events[0].rrf) == (4752, 0.016393)
    assert (events[1].chunk_id, events[1].rrf) == (None, None)


def test_a_chunk_token_may_omit_the_chunk_and_the_rrf():
    events, _ = parse([entry(results=["obsidian:a", "obsidian:b"], chunks=["12", "13@0.01"])])
    assert (events[0].chunk_id, events[0].rrf) == (None, None)
    assert (events[1].chunk_id, events[1].rrf) == (None, 0.01)


def test_an_empty_result_is_one_row_with_a_null_rank():
    events, warnings = parse([entry(results=[], chunks=[])])
    assert warnings == []
    assert len(events) == 1
    assert (events[0].rank, events[0].source, events[0].external_id) == (None, None, None)
    assert events[0].query == "redacted query text"


def test_a_session_start_injection_is_accepted():
    events, _ = parse([entry(channel="session-start", tool="session-start", query="", filters=None, chunks=None)])
    assert {e.channel for e in events} == {"session-start"}
    assert events[0].filters == {} and events[0].limit is None


def test_retrieval_index_is_the_position_in_the_frontmatter_list():
    events, warnings = parse([entry(channel="nope"), entry(results=["obsidian:x@0.9"], chunks=None)])
    assert len(warnings) == 1
    assert [e.retrieval_index for e in events] == [1]


def test_absent_or_null_retrievals_parse_to_nothing():
    assert parse(None) == ([], [])
    assert parse([]) == ([], [])


# --------------------------------------------------------------------------
# malformed entries are dropped, never a failed document
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"channel": "email"}, "channel"),
        ({"tool": ""}, "tool"),
        ({"at": "yesterday"}, "at"),
        ({"at": None}, "at"),
        ({"results": "obsidian:a@0.9"}, "results"),
        ({"results": ["no-colon@0.9"]}, "result 1"),
        ({"results": [":empty-source"]}, "result 1"),
        ({"results": ["obsidian:"]}, "result 1"),
        ({"chunks": ["doc-17"]}, "chunk 1"),
        ({"filters": ["collection"]}, "filters"),
        ({"query": 42}, "query"),
    ],
)
def test_a_malformed_entry_is_dropped_with_a_warning_naming_it(overrides, reason):
    events, warnings = parse([entry(), entry(**overrides)])
    assert [e.retrieval_index for e in events] == [0, 0]
    assert len(warnings) == 1
    assert warnings[0].startswith("retrievals[1]")
    assert reason in warnings[0]


def test_filters_nested_too_deep_drop_the_entry_not_the_note():
    deep: dict = {}
    cursor = deep
    for _ in range(40):
        cursor["x"] = {}
        cursor = cursor["x"]
    events, warnings = parse([entry(filters=deep), entry()])
    assert [e.retrieval_index for e in events] == [1, 1]
    assert len(warnings) == 1 and "filters" in warnings[0]


def test_an_entry_that_is_not_a_mapping_is_dropped():
    events, warnings = parse(["just a string", entry()])
    assert [e.retrieval_index for e in events] == [1, 1]
    assert warnings and warnings[0].startswith("retrievals[0]")


def test_retrievals_that_are_not_a_list_yield_one_warning():
    events, warnings = parse({"at": "2026-09-24T14:03:11Z"})
    assert events == []
    assert len(warnings) == 1 and "list" in warnings[0]


def test_a_note_without_a_session_id_keeps_no_events():
    events, warnings = parse([entry()], session={**SESSION, "session_id": ""})
    assert events == []
    assert len(warnings) == 1 and "session_id" in warnings[0]


def test_a_naive_timestamp_is_read_as_utc():
    events, _ = parse([entry(at="2026-09-24T14:03:11")])
    assert events[0].retrieved_at.tzinfo is not None
    assert events[0].retrieved_at.utcoffset().total_seconds() == 0


def test_an_unquoted_yaml_timestamp_is_accepted():
    moment = datetime(2026, 9, 24, 14, 3, 11, tzinfo=timezone.utc)
    events, warnings = parse([entry(at=moment)])
    assert warnings == [] and events[0].retrieved_at == moment


def test_a_non_integer_limit_is_kept_in_filters_but_not_as_the_limit():
    events, warnings = parse([entry(filters={"limit": "ten"})])
    assert warnings == []
    assert events[0].limit is None and events[0].filters == {"limit": "ten"}


def test_the_event_is_frozen():
    event = parse([entry()])[0][0]
    with pytest.raises(AttributeError):
        event.rank = 9  # type: ignore[misc]


# --------------------------------------------------------------------------
# session fields from the note's frontmatter
# --------------------------------------------------------------------------


def test_session_fields_come_from_frontmatter_and_the_realm():
    fields = session_fields_from(
        {"session_id": "abc", "parent_session": "", "machine": "box", "collection": "ignored"},
        collection="agentic-harness",
        realm="projects",
    )
    assert fields == {
        "session_id": "abc",
        "parent_session": None,
        "machine": "box",
        "collection": "agentic-harness",
        "realm": "projects",
    }


# --------------------------------------------------------------------------
# the migration
# --------------------------------------------------------------------------


def events_migration() -> str:
    found = [m for m in discover(DEFAULT_MIGRATIONS_DIR) if m.name == "rag_retrieval_events"]
    assert len(found) == 1, "exactly one rag_retrieval_events migration"
    return found[0].sql


def test_the_migration_sorts_after_every_search_migration():
    versions = [m.version for m in discover(DEFAULT_MIGRATIONS_DIR)]
    events_version = next(m.version for m in discover(DEFAULT_MIGRATIONS_DIR) if m.name == "rag_retrieval_events")
    assert events_version == versions[-1]
    assert events_version > "20260921223612"


def test_the_migration_creates_the_table_with_its_key_and_rls():
    sql = " ".join(events_migration().lower().split())
    assert "create table rag.retrieval_events" in sql
    assert re.search(
        r"create unique index \w+ on rag\.retrieval_events "
        r"\(note_source, note_external_id, retrieval_index, rank\) nulls not distinct",
        sql,
    )
    assert "alter table rag.retrieval_events enable row level security" in sql
    # A pruned session note takes its events with it (count matches the notes).
    assert re.search(r"document_id bigint references rag\.documents\(id\) on delete cascade", sql)
    assert "on delete set null" not in sql
    assert "check (channel in ('tool', 'session-start'))" in sql
    for column in ("session_id", "source, external_id", "retrieved_at", "collection", "document_id"):
        assert re.search(rf"create index \w+ on rag\.retrieval_events \({column}\)", sql), column


def test_the_migration_names_every_column_the_store_writes():
    sql = events_migration()
    for column in (
        "note_source", "note_external_id", "document_id", "session_id", "parent_session", "machine",
        "realm", "collection", "channel", "tool", "query", "filters", '"limit"', "retrieval_index",
        "retrieved_at", "rank", "source", "external_id", "result_document_id", "chunk_id",
        "similarity", "rrf", "search_version", "used", "judged_relevant", "created_at",
    ):
        assert column in sql, column


# --------------------------------------------------------------------------
# PostgresStore projection, against a scripted fake connection
# --------------------------------------------------------------------------


class ScriptedCursor:
    def __init__(self, connection) -> None:
        self.connection = connection
        self._row = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        text = " ".join(sql.split())
        self.connection.log.append(("execute", text, params))
        if self.connection.raise_on and self.connection.raise_on.lower() in text.lower():
            raise RuntimeError("simulated database error")
        self._row = None
        for marker, row in self.connection.answers.items():
            if marker in text:
                self._row = row
                break

    def executemany(self, sql, seq):
        rows = list(seq)
        self.connection.log.append(("executemany", " ".join(sql.split()), rows))

    def fetchone(self):
        return self._row


class ScriptedConnection:
    def __init__(self, answers: dict[str, tuple], raise_on: str | None = None) -> None:
        self.answers = answers
        self.raise_on = raise_on
        self.log: list[tuple] = []
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        return ScriptedCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        return None

    def statements(self) -> list[str]:
        return [entry[1] for entry in self.log]


TABLE_PRESENT = {
    "to_regclass('rag.retrieval_events')": ("rag.retrieval_events",),
    "to_regclass('rag_meta.schema_migrations')": ("rag_meta.schema_migrations",),
    "max(version)": ("20260921223612",),
    "count(*)": (2,),
}


def session_document() -> SourceDocument:
    events, _ = parse([entry()])
    return SourceDocument(
        source="obsidian",
        external_id="projects/x/sessions/1a2b.md",
        body="Session body.",
        retrievals=tuple(events),
    )


def test_replace_deletes_the_notes_rows_then_inserts_all_in_one_transaction():
    conn = ScriptedConnection(TABLE_PRESENT)
    written = PostgresStore(conn).replace_retrieval_events(41, session_document())

    assert written == 2
    kinds = [(kind, text.split()[0].lower()) for kind, text, _ in conn.log if "to_regclass" not in text and "max(version)" not in text]
    assert kinds == [("execute", "delete"), ("executemany", "insert")]
    delete = next(e for e in conn.log if e[1].lower().startswith("delete"))
    assert delete[2] == ("obsidian", "projects/x/sessions/1a2b.md")
    insert = next(e for e in conn.log if e[0] == "executemany")
    assert "select d.id from rag.documents d where d.source = %s and d.external_id = %s" in insert[1].lower()
    assert len(insert[2]) == 2
    assert conn.commits == 1


def test_each_row_carries_the_session_note_id_and_the_search_version():
    conn = ScriptedConnection(TABLE_PRESENT)
    PostgresStore(conn).replace_retrieval_events(41, session_document())
    row = next(e for e in conn.log if e[0] == "executemany")[2][0]
    assert 41 in row
    assert "20260921223612" in row
    assert "session-1a2b" in row and "1a2b3c4d" in row


def test_the_insert_binds_exactly_one_parameter_per_placeholder():
    from ingest.store import _INSERT_EVENT, _event_row

    for event in parse([entry(), entry(results=[], chunks=[])])[0]:
        assert _INSERT_EVENT.count("%s") == len(_event_row(event, 41, "v"))


def test_the_table_and_the_search_version_are_checked_once_per_run():
    conn = ScriptedConnection(TABLE_PRESENT)
    store = PostgresStore(conn)
    store.replace_retrieval_events(41, session_document())
    store.replace_retrieval_events(41, session_document())
    store.count_retrieval_events(session_document())
    assert sum("to_regclass('rag.retrieval_events')" in s for s in conn.statements()) == 1
    assert sum("max(version)" in s for s in conn.statements()) == 1


def test_a_missing_ledger_leaves_the_search_version_null():
    answers = {**TABLE_PRESENT, "to_regclass('rag_meta.schema_migrations')": (None,)}
    conn = ScriptedConnection(answers)
    PostgresStore(conn).replace_retrieval_events(41, session_document())
    assert not any("max(version)" in s for s in conn.statements())
    row = next(e for e in conn.log if e[0] == "executemany")[2][0]
    assert "20260921223612" not in row


def test_a_missing_table_warns_once_and_writes_nothing(caplog):
    conn = ScriptedConnection({"to_regclass('rag.retrieval_events')": (None,)})
    store = PostgresStore(conn)
    with caplog.at_level("WARNING"):
        assert store.replace_retrieval_events(41, session_document()) == 0
        assert store.replace_retrieval_events(41, session_document()) == 0
        assert store.count_retrieval_events(session_document()) is None
    assert sum("rag.retrieval_events does not exist" in r.message for r in caplog.records) == 1
    assert "uv run ingest db migrate" in caplog.text
    assert not any(s.lower().startswith(("delete", "insert")) for s in conn.statements())


def test_count_reads_the_notes_rows():
    conn = ScriptedConnection(TABLE_PRESENT)
    assert PostgresStore(conn).count_retrieval_events(session_document()) == 2
    count = next(e for e in conn.log if "count(*)" in e[1])
    assert count[2] == ("obsidian", "projects/x/sessions/1a2b.md")


def test_a_failed_projection_rolls_back_and_raises_a_store_error():
    from ingest.errors import StoreError

    conn = ScriptedConnection(TABLE_PRESENT, raise_on="delete from rag.retrieval_events")
    with pytest.raises(StoreError, match="retrieval events"):
        PostgresStore(conn).replace_retrieval_events(41, session_document())
    assert conn.rollbacks >= 1


def test_the_null_store_counts_nothing_and_refuses_to_write():
    from ingest.errors import StoreError

    store = NullStore()
    assert store.count_retrieval_events(session_document()) == 0
    with pytest.raises(StoreError):
        store.replace_retrieval_events(1, session_document())


def test_retrieval_event_rows_are_frozen_models():
    assert RetrievalEvent.__dataclass_params__.frozen  # type: ignore[attr-defined]
    assert Path(DEFAULT_MIGRATIONS_DIR).is_dir()
