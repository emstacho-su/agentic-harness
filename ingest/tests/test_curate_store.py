"""The curator's store (R-C2 cache, R-C3 ledger): the ``curate`` schema, its
in-memory twin, and the migration that creates it.

The in-memory store is what every other curator test runs against, so its
semantics (on-conflict, id format, ordering) are pinned here and the Postgres
class is held to the same statements through a fake connection. No test here
opens a database.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ingest.config import DbSettings
from ingest.curate import store as curate_store
from ingest.curate.store import InMemoryCurateStore, PostgresCurateStore
from ingest.curate.store_models import (
    Extraction,
    Issue,
    IssueEvent,
    IssueMember,
    format_issue_id,
    to_utc_iso,
)
from ingest.errors import ConfigError, StoreError
from ingest.migrations import DEFAULT_MIGRATIONS_DIR, FILENAME, discover

FIXED_NOW = datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)
# The newest migration before this unit; the curate one must sort after it.
PREVIOUS_NEWEST = "20260924201225"


def clock() -> datetime:
    return FIXED_NOW


def extraction(note_id: str = "sessions/a.md", content_hash: str = "h1", version: str = "v1",
               **overrides) -> Extraction:
    fields = dict(
        note_id=note_id, content_hash=content_hash, extractor_version=version,
        collection="agentic-harness", note_path=f"projects/agentic-harness/{note_id}",
        result=({"type": "issue", "summary": "hook crashed"},),
    )
    return Extraction(**{**fields, **overrides})


def event(issue_id: str, kind: str = "found", ref: str = "sessions/a.md",
          effective_at: str = "2026-09-20T10:00:00Z", **overrides) -> IssueEvent:
    fields = dict(
        issue_id=issue_id, to_state="open" if kind == "found" else None, event_kind=kind,
        effective_at=effective_at, cause_type="note", cause_ref=ref,
    )
    return IssueEvent(**{**fields, **overrides})


def new_issue(store, collection: str = "agentic-harness", summary: str = "hook crashed") -> Issue:
    return store.create_issue(collection, "bug", summary, ["hooks/capture.mjs"], "2026-09-20")


# -- ids ---------------------------------------------------------------------------


@pytest.mark.parametrize(("collection", "seq", "expected"), [
    ("agentic-harness", 1, "ISSUE-agentic-harness-001"),
    ("agentic-harness", 42, "ISSUE-agentic-harness-042"),
    ("bb2dash", 999, "ISSUE-bb2dash-999"),
    ("bb2dash", 1000, "ISSUE-bb2dash-1000"),
    ("wta dog finder", 3, "ISSUE-wta-dog-finder-003"),
    ("unit  3", 7, "ISSUE-unit-3-007"),
])
def test_format_issue_id(collection: str, seq: int, expected: str) -> None:
    assert format_issue_id(collection, seq) == expected


@pytest.mark.parametrize(("collection", "seq"), [("", 1), ("   ", 1), ("x", 0), ("x", -1)])
def test_format_issue_id_rejects_nonsense(collection: str, seq: int) -> None:
    with pytest.raises(ValueError):
        format_issue_id(collection, seq)


def test_a_spaced_collection_keeps_its_name_in_the_column() -> None:
    store = InMemoryCurateStore(clock=clock)
    issue = new_issue(store, collection="wta dog finder")

    assert issue.issue_id == "ISSUE-wta-dog-finder-001"
    assert issue.collection == "wta dog finder"
    assert store.list_issues("wta dog finder") == (issue,)
    assert store.list_issues("wta-dog-finder") == ()


# -- models ------------------------------------------------------------------------


def test_timestamps_normalise_to_utc_iso() -> None:
    assert to_utc_iso("2026-09-20") == "2026-09-20T00:00:00+00:00"
    assert to_utc_iso("2026-09-20T12:00:00Z") == "2026-09-20T12:00:00+00:00"
    assert to_utc_iso("2026-09-20T08:00:00-04:00") == "2026-09-20T12:00:00+00:00"
    assert to_utc_iso(datetime(2026, 9, 20, 12, tzinfo=timezone.utc)) == "2026-09-20T12:00:00+00:00"
    with pytest.raises(ValueError):
        to_utc_iso("last tuesday")


def test_extraction_items_are_tuples_of_json_copies() -> None:
    item = {"type": "issue", "files": ("a.py",)}
    made = extraction(result=[item], rejected=[{"reason": "quote not in note"}])

    assert isinstance(made.result, tuple) and isinstance(made.rejected, tuple)
    assert made.result == ({"type": "issue", "files": ["a.py"]},)
    item["type"] = "changed"
    assert made.result[0]["type"] == "issue"
    assert made.key == ("sessions/a.md", "h1", "v1")


def test_extraction_rejects_a_non_object_item() -> None:
    with pytest.raises(ValueError):
        extraction(result=("just a string",))


@pytest.mark.parametrize("overrides", [
    {"event_kind": "deleted"},
    {"cause_type": "email"},
    {"to_state": "closed"},
    {"cause_ref": ""},
])
def test_issue_event_validates_its_vocabulary(overrides: dict) -> None:
    with pytest.raises(ValueError):
        event("ISSUE-x-001", **overrides)


def test_an_annotation_event_has_no_state() -> None:
    made = event("ISSUE-x-001", kind="fix-commit", ref="abc123", cause_type="commit")
    assert made.to_state is None
    assert made.effective_at == "2026-09-20T10:00:00+00:00"


def test_issue_member_rejects_a_negative_index() -> None:
    with pytest.raises(ValueError):
        IssueMember("ISSUE-x-001", "n", "h", "v", -1)


# -- in-memory: extraction cache ---------------------------------------------------


def test_put_then_get_extraction() -> None:
    store = InMemoryCurateStore(clock=clock)
    store.put_extraction(extraction(model="haiku", input_tokens=900, output_tokens=120))

    found = store.get_extraction("sessions/a.md", "h1", "v1")
    assert found is not None
    assert found.model == "haiku" and found.input_tokens == 900
    assert found.created_at == "2026-09-27T12:00:00+00:00"
    assert store.get_extraction("sessions/a.md", "h2", "v1") is None
    assert store.get_extraction("sessions/a.md", "h1", "v2") is None


def test_a_second_put_on_the_same_key_does_nothing() -> None:
    store = InMemoryCurateStore(clock=clock)
    store.put_extraction(extraction(result=({"type": "issue", "summary": "first"},)))
    store.put_extraction(extraction(result=({"type": "issue", "summary": "second"},)))

    found = store.get_extraction("sessions/a.md", "h1", "v1")
    assert found is not None and found.result[0]["summary"] == "first"


def test_a_new_hash_or_version_is_a_new_row_and_old_ones_stay() -> None:
    store = InMemoryCurateStore(clock=clock)
    store.put_extraction(extraction())
    store.put_extraction(extraction(content_hash="h2"))
    store.put_extraction(extraction(version="v2"))

    keys = [("sessions/a.md", "h1", "v1"), ("sessions/a.md", "h2", "v1"), ("sessions/a.md", "h1", "v2")]
    assert set(store.get_extractions(keys)) == set(keys)


def test_batch_get_returns_only_the_hits() -> None:
    store = InMemoryCurateStore(clock=clock)
    store.put_extraction(extraction("a.md"))
    store.put_extraction(extraction("b.md"))

    found = store.get_extractions([("a.md", "h1", "v1"), ("c.md", "h1", "v1"), ("b.md", "h1", "v1")])
    assert sorted(found) == [("a.md", "h1", "v1"), ("b.md", "h1", "v1")]
    assert found[("b.md", "h1", "v1")].note_id == "b.md"
    assert store.get_extractions([]) == {}


def test_a_caller_cannot_mutate_the_cached_result() -> None:
    store = InMemoryCurateStore(clock=clock)
    store.put_extraction(extraction())
    got = store.get_extraction("sessions/a.md", "h1", "v1")
    assert got is not None
    got.result[0]["summary"] = "tampered"

    again = store.get_extraction("sessions/a.md", "h1", "v1")
    assert again is not None and again.result[0]["summary"] == "hook crashed"


# -- in-memory: issues -------------------------------------------------------------


def test_ids_are_allocated_per_collection() -> None:
    store = InMemoryCurateStore(clock=clock)
    a1, a2 = new_issue(store), new_issue(store, summary="second")
    b1 = new_issue(store, collection="bb2dash")

    assert (a1.issue_id, a1.seq) == ("ISSUE-agentic-harness-001", 1)
    assert (a2.issue_id, a2.seq) == ("ISSUE-agentic-harness-002", 2)
    assert (b1.issue_id, b1.seq) == ("ISSUE-bb2dash-001", 1)
    assert a1.files == ("hooks/capture.mjs",)
    assert a1.first_seen_at == "2026-09-20T00:00:00+00:00"
    assert a1.created_at == "2026-09-27T12:00:00+00:00"


def test_ids_grow_past_999() -> None:
    store = InMemoryCurateStore(clock=clock)
    issues = [new_issue(store, summary=f"issue {n}") for n in range(1000)]

    assert issues[8].issue_id == "ISSUE-agentic-harness-009"
    assert issues[998].issue_id == "ISSUE-agentic-harness-999"
    assert issues[999].issue_id == "ISSUE-agentic-harness-1000"
    assert [i.seq for i in store.list_issues("agentic-harness")] == list(range(1, 1001))


def test_colliding_collection_names_are_a_store_error() -> None:
    store = InMemoryCurateStore(clock=clock)
    new_issue(store, collection="wta dog finder")

    with pytest.raises(StoreError, match="ISSUE-wta-dog-finder-001"):
        new_issue(store, collection="wta-dog-finder")


def test_create_issue_rejects_an_empty_summary() -> None:
    store = InMemoryCurateStore(clock=clock)
    with pytest.raises(ValueError):
        new_issue(store, summary="  ")
    assert new_issue(store).seq == 1


# -- in-memory: members ------------------------------------------------------------


def test_members_are_unique_per_item_and_scoped_by_collection() -> None:
    store = InMemoryCurateStore(clock=clock)
    a, b = new_issue(store), new_issue(store, collection="bb2dash")
    member = IssueMember(a.issue_id, "n1", "h1", "v1", 0)

    assert store.add_member(member) is True
    assert store.add_member(member) is False
    # The same item cannot join a second issue either: it belongs to one.
    assert store.add_member(IssueMember(b.issue_id, "n1", "h1", "v1", 0)) is False
    assert store.add_member(IssueMember(a.issue_id, "n1", "h1", "v1", 1)) is True

    assert [m.item_index for m in store.members("agentic-harness")] == [0, 1]
    assert store.members("bb2dash") == ()


def test_a_member_of_an_unknown_issue_is_a_store_error() -> None:
    store = InMemoryCurateStore(clock=clock)
    with pytest.raises(StoreError):
        store.add_member(IssueMember("ISSUE-nope-001", "n1", "h1", "v1", 0))


# -- in-memory: events -------------------------------------------------------------


def test_events_are_unique_on_issue_kind_and_cause() -> None:
    store = InMemoryCurateStore(clock=clock)
    issue = new_issue(store)

    assert store.add_event(event(issue.issue_id)) is True
    assert store.add_event(event(issue.issue_id, evidence="different text")) is False
    assert store.add_event(event(issue.issue_id, ref="sessions/b.md")) is True
    assert len(store.events("agentic-harness")) == 2


def test_events_are_ordered_by_effective_time_then_id() -> None:
    store = InMemoryCurateStore(clock=clock)
    issue, other = new_issue(store), new_issue(store, collection="bb2dash")
    store.add_event(event(issue.issue_id, ref="late", effective_at="2026-09-22T00:00:00Z"))
    store.add_event(event(issue.issue_id, kind="claim-fixed", ref="tie-1",
                          effective_at="2026-09-21T00:00:00Z", to_state="claimed-fixed"))
    store.add_event(event(issue.issue_id, kind="claim-fixed", ref="tie-2",
                          effective_at="2026-09-21T04:00:00+04:00", to_state="claimed-fixed"))
    store.add_event(event(issue.issue_id, ref="early", effective_at="2026-09-20"))
    store.add_event(event(other.issue_id, ref="elsewhere"))

    listed = store.events("agentic-harness")
    assert [e.cause_ref for e in listed] == ["early", "tie-1", "tie-2", "late"]
    assert all(e.id is not None for e in listed)
    assert listed[1].id < listed[2].id
    assert listed[0].recorded_at == "2026-09-27T12:00:00+00:00"


def test_an_event_keeps_a_recorded_at_it_was_given() -> None:
    store = InMemoryCurateStore(clock=clock)
    issue = new_issue(store)
    store.add_event(event(issue.issue_id, recorded_at="2026-09-25T00:00:00Z"))

    assert store.events("agentic-harness")[0].recorded_at == "2026-09-25T00:00:00+00:00"


def test_an_event_for_an_unknown_issue_is_a_store_error() -> None:
    store = InMemoryCurateStore(clock=clock)
    with pytest.raises(StoreError):
        store.add_event(event("ISSUE-nope-001"))


# -- in-memory: judge confirmations ------------------------------------------------


def test_confirmations_are_cached_and_the_first_verdict_wins() -> None:
    store = InMemoryCurateStore(clock=clock)

    assert store.get_confirmation("item-1", "ISSUE-x-001", "v1") is None
    store.put_confirmation("item-1", "ISSUE-x-001", "v1", True, "haiku")
    store.put_confirmation("item-1", "ISSUE-x-001", "v1", False, "haiku")
    store.put_confirmation("item-1", "ISSUE-x-001", "v2", False, None)

    assert store.get_confirmation("item-1", "ISSUE-x-001", "v1") is True
    assert store.get_confirmation("item-1", "ISSUE-x-001", "v2") is False
    store.close()


def test_both_stores_implement_the_whole_protocol() -> None:
    wanted = {name for name in vars(curate_store.CurateStore) if not name.startswith("_")}
    assert {"get_extractions", "create_issue", "add_event", "put_confirmation", "close"} <= wanted
    for implementation in (InMemoryCurateStore, PostgresCurateStore):
        assert all(callable(getattr(implementation, name, None)) for name in wanted), implementation


# -- Postgres, against a fake connection ------------------------------------------


class FakeCursor:
    def __init__(self, connection: "FakeConnection") -> None:
        self.connection = connection
        self._rows: list[tuple] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.connection.log.append((sql, params))
        if self.connection.raise_on and self.connection.raise_on in sql:
            raise self.connection.error
        self._rows = next(
            (list(rows) for marker, rows in self.connection.responses.items() if marker in sql), []
        )

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class FakeConnection:
    """Answers each statement with the rows registered under a substring of its SQL."""

    def __init__(self, responses=None, raise_on=None, error=None) -> None:
        self.responses = responses or {}
        self.raise_on = raise_on
        self.error = error or RuntimeError("simulated database error")
        self.log: list[tuple[str, object]] = []
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


CREATED = datetime(2026, 9, 27, 12, tzinfo=timezone.utc)
EXTRACTION_ROW = ("a.md", "h1", "v1", "projects", "agentic-harness", "projects/a.md",
                  [{"type": "issue"}], [], "haiku", 10, 2, CREATED)


def assert_parameterized(log: list[tuple[str, object]], *values: str) -> None:
    for sql, params in log:
        assert "curate." in sql, sql
        assert "'%s'" not in sql and "{" not in sql, sql
        placeholders = sql.count("%s")
        assert placeholders == (len(params) if params else 0), sql
        for value in values:
            assert value not in sql, f"{value!r} interpolated into {sql}"


def test_every_sql_constant_targets_curate_and_is_parameterized() -> None:
    constants = {name: value for name, value in vars(curate_store).items()
                 if name.startswith(("_SELECT", "_INSERT", "_NEXT")) and isinstance(value, str)}
    assert len(constants) >= 10
    for name, sql in constants.items():
        assert "curate." in sql, name
        assert "'%s'" not in sql and "{" not in sql, name
    inserts = [sql for name, sql in constants.items() if name.startswith("_INSERT")]
    assert all("ON CONFLICT" in sql for sql in inserts if "curate.issues " not in sql)


def test_postgres_get_extraction_maps_the_row() -> None:
    conn = FakeConnection({"FROM curate.extractions": [EXTRACTION_ROW]})
    found = PostgresCurateStore(conn).get_extraction("a.md", "h1", "v1")

    assert found == Extraction("a.md", "h1", "v1", "agentic-harness", "projects/a.md",
                               ({"type": "issue"},), (), realm="projects", model="haiku",
                               input_tokens=10, output_tokens=2,
                               created_at="2026-09-27T12:00:00+00:00")
    assert conn.log[0][1] == ("a.md", "h1", "v1")
    assert conn.rollbacks == 1
    assert_parameterized(conn.log, "a.md")


def test_postgres_batch_get_passes_arrays_not_interpolated_keys() -> None:
    conn = FakeConnection({"unnest": [EXTRACTION_ROW]})
    found = PostgresCurateStore(conn).get_extractions([("a.md", "h1", "v1"), ("b.md", "h1", "v1")])

    assert list(found) == [("a.md", "h1", "v1")]
    sql, params = conn.log[0]
    assert params == (["a.md", "b.md"], ["h1", "h1"], ["v1", "v1"])
    assert_parameterized(conn.log, "a.md", "b.md")
    assert PostgresCurateStore(FakeConnection()).get_extractions([]) == {}


def test_postgres_put_extraction_is_insert_on_conflict_do_nothing() -> None:
    conn = FakeConnection()
    PostgresCurateStore(conn).put_extraction(extraction("a.md", rejected=[{"reason": "no quote"}]))

    sql, params = conn.log[0]
    assert "ON CONFLICT (note_id, content_hash, extractor_version) DO NOTHING" in sql
    assert '[{"type": "issue", "summary": "hook crashed"}]' in params
    assert '[{"reason": "no quote"}]' in params
    assert conn.commits == 1
    assert_parameterized(conn.log, "a.md", "hook crashed")


def test_postgres_create_issue_allocates_and_inserts_in_one_transaction() -> None:
    conn = FakeConnection({"curate.issue_counters": [(1000,)], "INSERT INTO curate.issues": [(CREATED,)]})
    issue = PostgresCurateStore(conn).create_issue(
        "wta dog finder", "bug", "map blank", ["src/map.ts"], "2026-09-20")

    assert issue.issue_id == "ISSUE-wta-dog-finder-1000"
    assert issue.collection == "wta dog finder" and issue.files == ("src/map.ts",)
    assert len(conn.log) == 2 and conn.commits == 1
    counter_sql, counter_params = conn.log[0]
    assert "ON CONFLICT (collection) DO UPDATE" in counter_sql and counter_params == ("wta dog finder",)
    assert conn.log[1][1][:3] == ("ISSUE-wta-dog-finder-1000", "wta dog finder", 1000)
    assert_parameterized(conn.log, "wta dog finder", "map blank")


def test_postgres_add_member_and_event_report_whether_a_row_landed() -> None:
    landed = FakeConnection({"INSERT INTO curate.issue_members": [(1,)],
                             "INSERT INTO curate.issue_events": [(7,)]})
    store = PostgresCurateStore(landed)
    assert store.add_member(IssueMember("ISSUE-x-001", "n1", "h1", "v1", 0)) is True
    assert store.add_event(event("ISSUE-x-001")) is True
    assert "ON CONFLICT (issue_id, event_kind, cause_type, cause_ref) DO NOTHING" in landed.log[1][0]
    assert_parameterized(landed.log, "ISSUE-x-001", "sessions/a.md")

    skipped = PostgresCurateStore(FakeConnection())
    assert skipped.add_member(IssueMember("ISSUE-x-001", "n1", "h1", "v1", 0)) is False
    assert skipped.add_event(event("ISSUE-x-001")) is False


def test_postgres_reads_issues_members_events_and_confirmations() -> None:
    conn = FakeConnection({
        "FROM curate.issues": [("ISSUE-x-001", "x", 1, "bug", "s", ["a.py"], CREATED, CREATED)],
        "FROM curate.issue_members": [("ISSUE-x-001", "n1", "h1", "v1", 0)],
        "FROM curate.issue_events": [(3, "ISSUE-x-001", "open", "found", CREATED, CREATED,
                                      "note", "n1", "quote")],
        "FROM curate.judge_confirmations": [(True,)],
    })
    store = PostgresCurateStore(conn)

    assert store.list_issues("x")[0].files == ("a.py",)
    assert store.members("x") == (IssueMember("ISSUE-x-001", "n1", "h1", "v1", 0),)
    assert store.events("x")[0].id == 3
    assert store.get_confirmation("k", "ISSUE-x-001", "v1") is True
    assert "ORDER BY e.effective_at, e.id" in conn.log[2][0]
    store.put_confirmation("k", "ISSUE-x-001", "v1", False, "haiku")
    assert "DO NOTHING" in conn.log[-1][0]
    assert_parameterized(conn.log, "ISSUE-x-001")


def test_postgres_errors_become_store_errors_and_roll_back() -> None:
    conn = FakeConnection(raise_on="curate.issue_events")
    store = PostgresCurateStore(conn)

    with pytest.raises(StoreError, match="simulated database error"):
        store.add_event(event("ISSUE-x-001"))
    assert conn.rollbacks >= 1 and conn.commits == 0


def test_postgres_create_issue_is_not_retried_after_a_dropped_connection() -> None:
    import psycopg

    conn = FakeConnection(raise_on="INSERT INTO curate.issues",
                          error=psycopg.OperationalError("server closed the connection"),
                          responses={"curate.issue_counters": [(1,)]})
    store = PostgresCurateStore(conn, database_url="postgresql://example/db")

    with pytest.raises(StoreError):
        store.create_issue("x", "bug", "s", [], "2026-09-20")
    assert sum("curate.issue_counters" in sql for sql, _ in conn.log) == 1


def test_postgres_idempotent_writes_reconnect_once_on_a_dropped_connection(monkeypatch) -> None:
    import psycopg

    dead = FakeConnection(raise_on="curate.extractions",
                          error=psycopg.OperationalError("server closed the connection"))
    fresh = FakeConnection()
    monkeypatch.setattr(psycopg, "connect", lambda url, **kw: fresh)
    store = PostgresCurateStore(dead, database_url="postgresql://example/db")

    store.put_extraction(extraction())
    assert dead.closed and fresh.commits == 1


def test_from_settings_uses_the_shared_connect_kwargs(monkeypatch) -> None:
    import psycopg

    captured: dict[str, object] = {}

    def fake_connect(url, **kwargs):
        captured.update(kwargs)
        return FakeConnection()

    monkeypatch.setattr(psycopg, "connect", fake_connect)
    settings = DbSettings(database_url="postgresql://example/db", supabase_url=None,
                          supabase_service_role=None, ssl_disabled=True)
    PostgresCurateStore.from_settings(settings)

    assert captured["sslmode"] == "disable" and captured["autocommit"] is False
    assert captured["keepalives"] == 1


def test_from_settings_without_a_url_is_a_config_error() -> None:
    settings = DbSettings(database_url=None, supabase_url=None, supabase_service_role=None)
    with pytest.raises(ConfigError, match="DATABASE_URL"):
        PostgresCurateStore.from_settings(settings)


def test_a_failed_connect_does_not_leak_the_url(monkeypatch) -> None:
    import psycopg

    url = "postgresql://user:hunter2@db.example/db"

    def refuse(target, **kwargs):
        raise psycopg.OperationalError(f"could not connect to {target} with password hunter2")

    monkeypatch.setattr(psycopg, "connect", refuse)
    settings = DbSettings(database_url=url, supabase_url=None, supabase_service_role=None,
                          ssl_disabled=True)
    with pytest.raises(StoreError) as caught:
        PostgresCurateStore.from_settings(settings)
    assert "hunter2" not in str(caught.value) and url not in str(caught.value)


# -- the migration -----------------------------------------------------------------


def curate_migration() -> Path:
    matches = sorted(DEFAULT_MIGRATIONS_DIR.glob("*_curate_schema.sql"))
    assert len(matches) == 1, matches
    return matches[0]


def test_the_migration_file_name_is_valid_and_sorts_last_of_its_era() -> None:
    path = curate_migration()
    match = FILENAME.match(path.name)
    assert match is not None
    version = match["version"]
    datetime.strptime(version, "%Y%m%d%H%M%S")
    assert version > PREVIOUS_NEWEST
    versions = [m.version for m in discover()]
    assert versions.count(version) == 1
    assert all(v < version for v in versions if v <= PREVIOUS_NEWEST)


def test_every_curate_table_has_row_level_security_and_nothing_is_granted() -> None:
    sql = curate_migration().read_text(encoding="utf-8").lower()
    tables = re.findall(r"create table (curate\.\w+)", sql)

    assert set(tables) >= {"curate.extractions", "curate.issues", "curate.issue_members",
                           "curate.issue_events", "curate.judge_confirmations"}
    for table in tables:
        assert re.search(rf"alter table {re.escape(table)}\s+enable row level security", sql), table
    assert not re.search(r"\bgrant\b", sql)
    assert "create policy" not in sql


def test_the_migration_carries_the_contract_constraints() -> None:
    sql = " ".join(curate_migration().read_text(encoding="utf-8").lower().split())

    assert "primary key (note_id, content_hash, extractor_version)" in sql
    assert "unique (collection, seq)" in sql
    assert "primary key (note_id, content_hash, extractor_version, item_index)" in sql
    assert "unique (issue_id, event_kind, cause_type, cause_ref)" in sql
    assert "primary key (item_key, issue_id, extractor_version)" in sql
    assert "on delete cascade" not in sql
    for state in ("'open'", "'claimed-fixed'", "'verified'", "'regressed'"):
        assert state in sql
    for kind in ("'found'", "'claim-fixed'", "'claim-workaround'", "'claim-wontfix'",
                 "'fix-commit'", "'merged-pr'", "'recurrence'"):
        assert kind in sql
