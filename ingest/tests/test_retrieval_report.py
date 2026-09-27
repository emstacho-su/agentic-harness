"""``ingest report retrievals`` (R-P3): what the sessions searched for, and what came back.

The numbers are pure functions over plain rows, tested on a fixture event set;
the CLI runs against a scripted connection. Nothing here touches a database.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from ingest.errors import ConfigError
from ingest.report_cli import HEADINGS, run_report
from ingest.retrieval_report import (
    DocumentRow,
    EventRow,
    build_report,
    cross_collection,
    empty_queries,
    most_retrieved,
    never_retrieved,
    parse_since,
    per_collection,
    similarity_distribution,
    totals,
)

NOW = datetime(2026, 9, 24, 12, 0, tzinfo=timezone.utc)
HARNESS = "agentic-harness"
CLASS = "ist323"


def at(day: int, hour: int = 10) -> datetime:
    return datetime(2026, 9, day, hour, 0, tzinfo=timezone.utc)


def event(
    note: str,
    index: int,
    rank: int | None,
    *,
    session: str = "s1",
    collection: str | None = HARNESS,
    channel: str = "tool",
    tool: str = "search_context",
    query: str = "q",
    filters: dict | None = None,
    when: datetime | None = None,
    source: str | None = "obsidian",
    external_id: str | None = "a.md",
    similarity: float | None = 0.80,
    title: str | None = "A",
    doc_collection: str | None = HARNESS,
) -> EventRow:
    empty = rank is None
    return EventRow(
        session_id=session,
        note_external_id=note,
        retrieval_index=index,
        collection=collection,
        channel=channel,
        tool=tool,
        query=query,
        filters=filters or {},
        retrieved_at=when or at(20),
        rank=rank,
        source=None if empty else source,
        external_id=None if empty else external_id,
        similarity=None if empty else similarity,
        title=None if empty else title,
        doc_collection=None if empty else doc_collection,
    )


# Fifteen rows, eight retrievals, four sessions, two note collections.
EVENTS: tuple[EventRow, ...] = (
    # s1 (harness note n1): retrieval 0, three results
    event("n1", 0, 1, external_id="a.md", similarity=0.92, when=at(20)),
    event("n1", 0, 2, external_id="b.md", similarity=0.81, title="B", when=at(20)),
    event("n1", 0, 3, source="claude-mem", external_id="461", similarity=0.72, title="Mem 461",
          doc_collection=None, when=at(20)),
    # s1: retrieval 1, empty result
    event("n1", 1, None, query="nothing about this", filters={"collection": HARNESS}, when=at(21)),
    # s1: retrieval 2, a session-start injection
    event("n1", 2, 1, channel="session-start", tool="session-start", query="", external_id="a.md",
          similarity=0.88, when=at(21, 9)),
    # s2 (harness note n2): retrieval 0, filtered to the class collection: cross-collection
    event("n2", 0, 1, session="s2", query="syllabus late policy", filters={"collection": CLASS},
          external_id="ist323/syllabus.md", title="Syllabus", doc_collection=CLASS, similarity=0.77,
          when=at(22)),
    event("n2", 0, 2, session="s2", query="syllabus late policy", filters={"collection": CLASS},
          external_id="a.md", similarity=0.45, when=at(22)),
    # s2: retrieval 1, get_document: no similarity
    event("n2", 1, 1, session="s2", tool="get_document", external_id="a.md", similarity=None,
          when=at(22, 11)),
    # s3 (class note n3): retrieval 0, two results
    event("n3", 0, 1, session="s3", collection=CLASS, filters={"collection": CLASS},
          external_id="ist323/syllabus.md", title="Syllabus", doc_collection=CLASS, similarity=0.86,
          when=at(23)),
    event("n3", 0, 2, session="s3", collection=CLASS, filters={"collection": CLASS},
          external_id="b.md", title="B", similarity=0.64, when=at(23)),
    # s3: retrieval 1, empty
    event("n3", 1, None, session="s3", collection=CLASS, query="grading rubric week 9", when=at(23, 12)),
    # s4 (class note n4): retrieval 0, filtered to harness: cross-collection, three results
    event("n4", 0, 1, session="s4", collection=CLASS, query="hook redaction",
          filters={"collection": HARNESS, "limit": 5}, external_id="a.md", similarity=0.97,
          when=at(24, 8)),
    event("n4", 0, 2, session="s4", collection=CLASS, query="hook redaction",
          filters={"collection": HARNESS, "limit": 5}, external_id="c.md", title="C",
          similarity=0.53, when=at(24, 8)),
    event("n4", 0, 3, session="s4", collection=CLASS, query="hook redaction",
          filters={"collection": HARNESS, "limit": 5}, external_id="b.md", title="B",
          similarity=1.0, when=at(24, 8)),
    # s4: retrieval 1, filter on its own collection: not cross-collection
    event("n4", 1, 1, session="s4", collection=CLASS, filters={"collection": CLASS},
          external_id="ist323/syllabus.md", title="Syllabus", doc_collection=CLASS, similarity=0.51,
          when=at(24, 9)),
)

NEVER: tuple[DocumentRow, ...] = (
    DocumentRow(source="obsidian", external_id="z.md", title="Z", collection=HARNESS),
    DocumentRow(source="obsidian", external_id="y.md", title="Y", collection=HARNESS),
    DocumentRow(source="obsidian", external_id="ist323/w1.md", title="Week 1", collection=CLASS),
    DocumentRow(source="claude-mem", external_id="12", title="Mem 12", collection=None),
)


# --------------------------------------------------------------------------
# --since
# --------------------------------------------------------------------------


def test_since_accepts_an_iso_date_as_midnight_utc():
    assert parse_since("2026-09-10", NOW) == datetime(2026, 9, 10, tzinfo=timezone.utc)


def test_since_accepts_an_iso_datetime_with_z():
    assert parse_since("2026-09-10T08:30:00Z", NOW) == datetime(2026, 9, 10, 8, 30, tzinfo=timezone.utc)


def test_since_reads_a_naive_datetime_as_utc():
    assert parse_since("2026-09-10T08:30", NOW) == datetime(2026, 9, 10, 8, 30, tzinfo=timezone.utc)


def test_since_accepts_a_number_of_days_back_from_now():
    assert parse_since("14d", NOW) == NOW - timedelta(days=14)


@pytest.mark.parametrize("bad", ["", "yesterday", "0d", "-3d", "14", "d", "2026-13-01", "3w"])
def test_since_refuses_anything_else(bad: str):
    with pytest.raises(ConfigError, match="--since"):
        parse_since(bad, NOW)


# --------------------------------------------------------------------------
# sections
# --------------------------------------------------------------------------


def test_most_retrieved_counts_result_rows_and_distinct_sessions():
    top = most_retrieved(EVENTS, limit=3)
    assert [(d["source"], d["external_id"], d["count"], d["sessions"]) for d in top] == [
        ("obsidian", "a.md", 5, 3),
        ("obsidian", "b.md", 3, 3),
        ("obsidian", "ist323/syllabus.md", 3, 3),
    ]
    assert top[0]["title"] == "A" and top[0]["collection"] == HARNESS
    assert top[2]["collection"] == CLASS


def test_most_retrieved_honours_the_limit_and_skips_empty_rows():
    assert len(most_retrieved(EVENTS, limit=2)) == 2
    everything = most_retrieved(EVENTS, limit=50)
    assert len(everything) == 5
    assert all(d["external_id"] is not None for d in everything)


def test_never_retrieved_counts_per_collection_and_samples_in_order():
    section = never_retrieved(NEVER, limit=3)
    assert section["total"] == 4
    assert section["by_collection"] == {HARNESS: 2, CLASS: 1, "(none)": 1}
    assert [(d["collection"], d["external_id"]) for d in section["sample"]] == [
        (None, "12"),
        (HARNESS, "y.md"),
        (HARNESS, "z.md"),
    ]


def test_empty_queries_are_most_recent_first_and_capped():
    section = empty_queries(EVENTS, limit=1)
    assert section["total"] == 2
    assert [q["query"] for q in section["queries"]] == ["grading rubric week 9"]
    only = section["queries"][0]
    assert only["session_id"] == "s3" and only["collection"] == CLASS
    assert only["tool"] == "search_context" and only["filters"] == {}
    assert only["retrieved_at"] == "2026-09-23T12:00:00+00:00"
    both = empty_queries(EVENTS, limit=10)["queries"]
    assert both[1]["filters"] == {"collection": HARNESS}


def test_similarity_buckets_run_in_steps_of_005_from_050_with_below_and_na():
    section = similarity_distribution(EVENTS)
    buckets = {b["bucket"]: b["count"] for b in section["buckets"]}
    labels = [b["bucket"] for b in section["buckets"]]
    assert labels[0] == "<0.50" and labels[-1] == "n/a"
    assert labels[1] == "0.50-0.55" and labels[-2] == "0.95-1.00"
    assert len(labels) == 12
    assert buckets == {
        "<0.50": 1,
        "0.50-0.55": 2,
        "0.55-0.60": 0,
        "0.60-0.65": 1,
        "0.65-0.70": 0,
        "0.70-0.75": 1,
        "0.75-0.80": 1,
        "0.80-0.85": 1,
        "0.85-0.90": 2,
        "0.90-0.95": 1,
        "0.95-1.00": 2,
        "n/a": 1,
    }
    assert section["results"] == 13
    assert sum(b["share"] for b in section["buckets"]) == pytest.approx(1.0)
    assert (section["min"], section["max"]) == (0.45, 1.0)
    assert section["median"] == pytest.approx(0.79)


def test_a_bucket_boundary_belongs_to_the_bucket_above_it():
    rows = (event("n", 0, 1, similarity=0.55), event("n", 0, 2, similarity=0.70))
    counts = {b["bucket"]: b["count"] for b in similarity_distribution(rows)["buckets"]}
    assert counts["0.55-0.60"] == 1 and counts["0.70-0.75"] == 1


def test_similarity_of_nothing_has_no_stats():
    section = similarity_distribution(())
    assert section["results"] == 0
    assert (section["min"], section["median"], section["max"]) == (None, None, None)
    assert all(b["share"] == 0.0 for b in section["buckets"])


def test_per_collection_counts_retrievals_results_empties_sessions_and_channels():
    rows = {c["collection"]: c for c in per_collection(EVENTS)}
    assert rows[HARNESS] == {
        "collection": HARNESS,
        "retrievals": 5,
        "results": 7,
        "empty": 1,
        "sessions": 2,
        "channels": {"tool": 4, "session-start": 1},
    }
    assert rows[CLASS] == {
        "collection": CLASS,
        "retrievals": 4,
        "results": 6,
        "empty": 1,
        "sessions": 2,
        "channels": {"tool": 4, "session-start": 0},
    }


def test_cross_collection_counts_retrievals_not_rows():
    section = cross_collection(EVENTS, limit=10)
    assert section["total"] == 2
    assert [(r["session_id"], r["note_collection"], r["filter_collection"]) for r in section["retrievals"]] == [
        ("s4", CLASS, HARNESS),
        ("s2", HARNESS, CLASS),
    ]
    assert section["retrievals"][0]["query"] == "hook redaction"
    assert cross_collection(EVENTS, limit=1)["total"] == 2
    assert len(cross_collection(EVENTS, limit=1)["retrievals"]) == 1


def test_totals_name_the_range_and_the_bound():
    bound = datetime(2026, 9, 1, tzinfo=timezone.utc)
    assert totals(EVENTS, since=bound) == {
        "events": 15,
        "retrievals": 9,
        "sessions": 4,
        "first": "2026-09-20T10:00:00+00:00",
        "last": "2026-09-24T09:00:00+00:00",
        "since": "2026-09-01T00:00:00+00:00",
    }
    assert totals((), since=None) == {
        "events": 0, "retrievals": 0, "sessions": 0, "first": None, "last": None, "since": None,
    }


def test_the_report_has_every_section():
    report = build_report(EVENTS, NEVER, since=None, limit=5)
    assert set(report) == {
        "totals",
        "most_retrieved",
        "never_retrieved",
        "empty_queries",
        "similarity_distribution",
        "per_collection",
        "cross_collection",
    }


def test_filters_arriving_as_a_json_string_are_read():
    row = event("n", 0, None, collection=HARNESS, filters=None)
    row = EventRow(**{**row.__dict__, "filters": json.dumps({"collection": CLASS})})
    assert cross_collection((row,), limit=5)["total"] == 1


# --------------------------------------------------------------------------
# the CLI, against a scripted connection
# --------------------------------------------------------------------------


def as_tuple(row: EventRow) -> tuple:
    return (
        row.session_id, row.note_external_id, row.retrieval_index, row.collection, row.channel,
        row.tool, row.query, row.filters, row.retrieved_at, row.rank, row.source, row.external_id,
        row.similarity, row.title, row.doc_collection,
    )


class ScriptedCursor:
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
        if "to_regclass" in text:
            self._rows = [("rag.retrieval_events" if self.connection.table_exists else None,)]
        elif "not exists" in text:
            self._rows = [(d.source, d.external_id, d.title, d.collection) for d in NEVER]
        elif "from rag.retrieval_events" in text:
            self._rows = [as_tuple(e) for e in EVENTS]
        else:
            self._rows = []

    def fetchall(self):
        return list(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None


class ScriptedConnection:
    def __init__(self, *, table_exists: bool = True) -> None:
        self.table_exists = table_exists
        self.log: list[tuple[str, object]] = []
        self.rollbacks = 0

    def cursor(self):
        return ScriptedCursor(self)

    def commit(self):
        raise AssertionError("a report never commits")

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        pass


def events_calls(conn: ScriptedConnection) -> list[tuple[str, object]]:
    return [(sql, p) for sql, p in conn.log if "from rag.retrieval_events e" in sql and "not exists" not in sql]


FIXTURE_VALUES = {"s1", "s2", "n1", "n2", "a.md", "syllabus late policy", "hook redaction", HARNESS, CLASS}


def test_json_is_one_object_with_every_section(capsys):
    conn = ScriptedConnection()
    assert run_report(["retrievals", "--json"], connection=conn) == 0
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert set(payload) >= {
        "totals", "most_retrieved", "never_retrieved", "empty_queries",
        "similarity_distribution", "per_collection", "cross_collection",
    }
    assert payload["totals"]["events"] == 15
    assert payload["never_retrieved"]["by_collection"] == {HARNESS: 2, CLASS: 1, "(none)": 1}


def test_text_has_every_heading(capsys):
    assert run_report(["retrievals", "--limit", "3"], connection=ScriptedConnection()) == 0
    out = capsys.readouterr().out
    for heading in HEADINGS.values():
        assert heading in out
    assert "whole store" in out


def test_every_query_is_parameterised_and_since_is_bound(capsys):
    conn = ScriptedConnection()
    assert run_report(["retrievals", "--since", "2026-09-10", "--json"], connection=conn) == 0
    capsys.readouterr()
    for sql, _ in conn.log:
        assert not any(value in sql for value in FIXTURE_VALUES), sql
        assert "2026-09-10" not in sql
    events_query = events_calls(conn)
    assert len(events_query) == 1
    assert datetime(2026, 9, 10, tzinfo=timezone.utc) in events_query[0][1]
    never_query = [(sql, p) for sql, p in conn.log if "not exists" in sql]
    assert len(never_query) == 1 and not never_query[0][1]


def test_without_since_the_bound_is_null(capsys):
    conn = ScriptedConnection()
    assert run_report(["retrievals", "--json"], connection=conn) == 0
    assert json.loads(capsys.readouterr().out)["totals"]["since"] is None
    assert events_calls(conn)[0][1] == (None, None)


def test_days_back_binds_a_recent_bound(capsys):
    conn = ScriptedConnection()
    assert run_report(["retrievals", "--since", "14d", "--json"], connection=conn) == 0
    capsys.readouterr()
    bound = events_calls(conn)[0][1][0]
    expected = datetime.now(timezone.utc) - timedelta(days=14)
    assert abs((bound - expected).total_seconds()) < 60


def test_a_bad_since_is_a_usage_error(capsys):
    conn = ScriptedConnection()
    assert run_report(["retrievals", "--since", "last week"], connection=conn) == 2
    captured = capsys.readouterr()
    assert "--since" in captured.err and captured.out == ""
    assert conn.log == []


def test_a_bad_limit_is_a_usage_error(capsys):
    assert run_report(["retrievals", "--limit", "0"], connection=ScriptedConnection()) == 2
    assert "--limit" in capsys.readouterr().err


def test_a_missing_table_says_to_migrate(capsys):
    conn = ScriptedConnection(table_exists=False)
    assert run_report(["retrievals", "--json"], connection=conn) == 1
    captured = capsys.readouterr()
    assert "uv run ingest db migrate" in captured.err
    assert captured.out == ""
    assert len(conn.log) >= 1 and all("to_regclass" in sql or "read only" in sql.lower() for sql, _ in conn.log)


def test_a_database_error_is_exit_1(capsys):
    import psycopg

    class Broken(ScriptedConnection):
        def cursor(self):
            raise psycopg.OperationalError("server closed the connection")

    assert run_report(["retrievals", "--json"], connection=Broken()) == 1
    captured = capsys.readouterr()
    assert "server closed the connection" in captured.err and captured.out == ""


def test_the_report_rolls_back_its_read_only_transaction(capsys):
    conn = ScriptedConnection()
    run_report(["retrievals"], connection=conn)
    assert conn.rollbacks == 1


def test_the_cli_dispatches_report_to_this_module(capsys):
    from ingest.cli import main

    # --limit 0 fails before any connection is opened, so no database is needed.
    assert main(["report", "retrievals", "--limit", "0"]) == 2
    assert "--limit" in capsys.readouterr().err
