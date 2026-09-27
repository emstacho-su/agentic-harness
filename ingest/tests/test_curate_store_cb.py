"""The curator store's C-b tables (R-C5 history cache, R-C6 scores and proposals,
R-C7 decisions): their dataclasses, the in-memory store, the dry-run overlay,
the Postgres statements (through the fake connection of ``test_curate_store``)
and the migration that creates them. No test here opens a database.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

from ingest.curate import store as curate_store
from ingest.curate.dry_run_store import DryRunStore
from ingest.curate.store import (
    Decision,
    HistoryWeek,
    ImportanceJudgement,
    InMemoryCurateStore,
    NoteScore,
    PostgresCurateStore,
    Proposal,
)
from ingest.errors import StoreError
from ingest.migrations import DEFAULT_MIGRATIONS_DIR, FILENAME, discover

from test_curate_store import CREATED, FakeConnection, assert_parameterized, clock

CURATE_SCHEMA_VERSION = "20260927200342"
NOW = "2026-09-27T12:00:00+00:00"


def week(**overrides) -> HistoryWeek:
    fields = dict(
        collection="agentic-harness", week_start="2026-09-21", input_hash="ih1",
        history_version="hv1",
        narrative=({"text": "The hooks learned to capture.", "note_ids": ["s1", "s2"]},),
        titles={"s1": "Hook capture", "s2": "Capture tests"},
        model="haiku", input_tokens=900, output_tokens=120,
    )
    return HistoryWeek(**{**fields, **overrides})


def score(note_id: str = "s1", **overrides) -> NoteScore:
    fields = dict(
        note_id=note_id, scorer_version="sv1", run_day="2026-09-27", content_hash="h1",
        realm="projects", collection="agentic-harness", impact=3.5, relevance=0.25,
        features={"commits": 2, "prs": 1, "recency": 0.5},
    )
    return NoteScore(**{**fields, **overrides})


def judgement(**overrides) -> ImportanceJudgement:
    fields = dict(note_id="s1", content_hash="h1", scorer_version="sv1", importance=7, model="haiku")
    return ImportanceJudgement(**{**fields, **overrides})


def proposal(note_id: str = "s1", action: str = "prune", **overrides) -> Proposal:
    fields = dict(
        realm_folder="projects", report_day="2026-09-27", note_id=note_id, action=action,
        collection="agentic-harness", reasons=("no commit", "no decision"), no_loss=True,
    )
    return Proposal(**{**fields, **overrides})


def decision(accepted: bool = True, note_id: str = "s1", action: str = "prune", **overrides) -> Decision:
    fields = dict(realm_folder="projects", report_day="2026-09-27", note_id=note_id,
                  action=action, accepted=accepted)
    return Decision(**{**fields, **overrides})


# -- models ------------------------------------------------------------------------


def test_days_are_normalised_and_dates_accepted() -> None:
    assert score(run_day=date(2026, 9, 27)).run_day == "2026-09-27"
    assert week(week_start=" 2026-09-21 ").week_start == "2026-09-21"
    assert proposal(report_day=date(2026, 9, 1)).report_day == "2026-09-01"
    assert decision().report_day == "2026-09-27"


@pytest.mark.parametrize("bad_day", ["", "next monday", "2026-02-30", 20260927,
                                     datetime(2026, 9, 27, tzinfo=timezone.utc)])
def test_a_day_that_is_not_a_date_is_refused(bad_day) -> None:
    with pytest.raises(ValueError):
        score(run_day=bad_day)


@pytest.mark.parametrize("overrides", [
    {"collection": " "},
    {"input_hash": ""},
    {"history_version": ""},
    {"narrative": "a string"},
    {"narrative": ({"text": "", "note_ids": ["s1"]},)},
    {"narrative": ({"text": "ok"},)},
    {"narrative": ({"text": "ok", "note_ids": "s1"},)},
    {"narrative": ({"text": "ok", "note_ids": ["s1", ""]},)},
    {"narrative": ("not an object",)},
    {"titles": {"s1": ""}},
    {"titles": {"": "Title"}},
    {"titles": ["s1"]},
    {"input_tokens": -1},
])
def test_history_week_validates(overrides: dict) -> None:
    with pytest.raises(ValueError):
        week(**overrides)


@pytest.mark.parametrize("overrides", [
    {"note_id": ""},
    {"scorer_version": ""},
    {"content_hash": ""},
    {"collection": ""},
    {"impact": float("nan")},
    {"impact": float("inf")},
    {"relevance": "0.5"},
    {"relevance": True},
    {"features": {"commits": "two"}},
    {"features": {"commits": True}},
    {"features": {"recency": float("nan")}},
    {"features": {"": 1}},
    {"features": [("commits", 1)]},
    {"importance": 0},
    {"importance": 11},
    {"importance": 7.5},
    {"importance": True},
])
def test_note_score_validates(overrides: dict) -> None:
    with pytest.raises(ValueError):
        score(**overrides)


def test_note_score_numbers_are_floats_and_importance_is_optional() -> None:
    made = score(impact=3, relevance=0)
    assert made.impact == 3.0 and isinstance(made.impact, float)
    assert made.relevance == 0.0 and isinstance(made.relevance, float)
    assert made.importance is None
    assert score(importance=1).importance == 1 and score(importance=10).importance == 10
    assert made.key == ("s1", "sv1", "2026-09-27")


@pytest.mark.parametrize("importance", [0, 11, -3, 5.0, None, True, "7"])
def test_importance_judgement_is_one_to_ten(importance) -> None:
    with pytest.raises(ValueError):
        judgement(importance=importance)


@pytest.mark.parametrize("overrides", [
    {"action": "delete"},
    {"action": "Prune"},
    {"realm_folder": ""},
    {"collection": " "},
    {"reasons": "no commit"},
    {"reasons": ("no commit", "")},
    {"reasons": ("no commit", 3)},
    {"no_loss": "yes"},
    {"no_loss": 1},
])
def test_proposal_validates(overrides: dict) -> None:
    with pytest.raises(ValueError):
        proposal(**overrides)


@pytest.mark.parametrize("overrides", [
    {"action": "archive"}, {"accepted": "yes"}, {"accepted": 0}, {"note_id": ""},
])
def test_decision_validates(overrides: dict) -> None:
    with pytest.raises(ValueError):
        decision(**overrides)


def test_json_fields_are_fresh_copies_of_what_was_passed() -> None:
    narrative = [{"text": "t", "note_ids": ["s1"]}]
    titles = {"s1": "One"}
    features = {"commits": 2}
    made_week = week(narrative=narrative, titles=titles)
    made_score = score(features=features)
    narrative[0]["note_ids"].append("s9")
    titles["s1"] = "changed"
    features["commits"] = 99

    assert made_week.narrative == ({"text": "t", "note_ids": ["s1"]},)
    assert made_week.titles == {"s1": "One"}
    assert made_score.features == {"commits": 2}
    assert proposal(reasons=["a", "b"]).reasons == ("a", "b")


# -- in-memory: history weeks ------------------------------------------------------


def test_history_week_round_trips_and_a_second_put_is_ignored() -> None:
    store = InMemoryCurateStore(clock=clock)
    store.put_history_week(week())
    store.put_history_week(week(narrative=({"text": "second", "note_ids": []},)))

    found = store.get_history_week("agentic-harness", "2026-09-21", "ih1", "hv1")
    assert found == week(created_at=NOW)
    assert found.narrative[0]["text"] == "The hooks learned to capture."
    assert store.get_history_week("agentic-harness", date(2026, 9, 21), "ih1", "hv1") == found
    assert store.get_history_week("agentic-harness", "2026-09-21", "ih2", "hv1") is None
    assert store.get_history_week("agentic-harness", "2026-09-21", "ih1", "hv2") is None


def test_a_history_week_read_is_a_copy() -> None:
    store = InMemoryCurateStore(clock=clock)
    store.put_history_week(week())
    got = store.get_history_week("agentic-harness", "2026-09-21", "ih1", "hv1")
    got.narrative[0]["note_ids"].append("tampered")
    got.titles["s1"] = "tampered"

    again = store.get_history_week("agentic-harness", "2026-09-21", "ih1", "hv1")
    assert again.narrative[0]["note_ids"] == ["s1", "s2"]
    assert again.titles["s1"] == "Hook capture"
    assert again.narrative is not got.narrative and again.titles is not got.titles


# -- in-memory: note scores --------------------------------------------------------


def test_note_scores_are_unique_per_note_version_and_day() -> None:
    store = InMemoryCurateStore(clock=clock)
    assert store.put_note_score(score("s2")) is True
    assert store.put_note_score(score("s1")) is True
    assert store.put_note_score(score("s1", impact=9.0)) is False
    assert store.put_note_score(score("s1", scorer_version="sv2")) is True
    assert store.put_note_score(score("s1", run_day="2026-10-04")) is True
    assert store.put_note_score(score("s3", collection="bb2dash")) is True

    listed = store.note_scores("agentic-harness", "2026-09-27")
    assert [(s.note_id, s.scorer_version) for s in listed] == [("s1", "sv1"), ("s1", "sv2"), ("s2", "sv1")]
    assert listed[0].impact == 3.5 and listed[0].created_at == NOW
    assert store.note_scores("agentic-harness", date(2026, 10, 4))[0].run_day == "2026-10-04"
    assert store.note_scores("bb2dash", "2026-09-27")[0].note_id == "s3"
    assert store.note_scores("nothing", "2026-09-27") == ()


def test_a_note_score_read_is_a_copy() -> None:
    store = InMemoryCurateStore(clock=clock)
    store.put_note_score(score(importance=4))
    got = store.note_scores("agentic-harness", "2026-09-27")[0]
    got.features["commits"] = 99

    again = store.note_scores("agentic-harness", "2026-09-27")[0]
    assert again == score(importance=4, created_at=NOW)
    assert again.features is not got.features


# -- in-memory: importance judgements ----------------------------------------------


def test_the_first_importance_judgement_wins() -> None:
    store = InMemoryCurateStore(clock=clock)
    assert store.get_importance("s1", "h1", "sv1") is None
    store.put_importance(judgement(importance=7))
    store.put_importance(judgement(importance=2))
    store.put_importance(judgement(content_hash="h2", importance=3))

    assert store.get_importance("s1", "h1", "sv1") == judgement(importance=7, created_at=NOW)
    assert store.get_importance("s1", "h2", "sv1").importance == 3
    assert store.get_importance("s1", "h1", "sv2") is None


# -- in-memory: proposals ----------------------------------------------------------


def test_proposals_are_unique_and_ordered_by_day_action_note() -> None:
    store = InMemoryCurateStore(clock=clock)
    assert store.put_proposal(proposal("s2", "prune")) is True
    assert store.put_proposal(proposal("s1", "prune")) is True
    assert store.put_proposal(proposal("s9", "condense")) is True
    assert store.put_proposal(proposal("s1", "prune", reasons=("other",))) is False
    assert store.put_proposal(proposal("s1", "condense")) is True
    assert store.put_proposal(proposal("s0", "prune", report_day="2026-09-20")) is True
    assert store.put_proposal(proposal("s5", "prune", realm_folder="classes")) is True

    listed = store.proposals("projects")
    assert [(p.report_day, p.action, p.note_id) for p in listed] == [
        ("2026-09-20", "prune", "s0"),
        ("2026-09-27", "condense", "s1"),
        ("2026-09-27", "condense", "s9"),
        ("2026-09-27", "prune", "s1"),
        ("2026-09-27", "prune", "s2"),
    ]
    assert listed[3] == proposal("s1", created_at=NOW)
    assert [p.note_id for p in store.proposals("classes")] == ["s5"]


# -- in-memory: decisions ----------------------------------------------------------


def test_a_decision_is_recorded_only_when_it_changes_the_latest() -> None:
    store = InMemoryCurateStore(clock=clock)
    assert store.record_decision(decision(True)) is True       # no prior record: differs
    assert store.record_decision(decision(True)) is False      # same as latest
    assert store.record_decision(decision(False)) is True      # an untick
    assert store.record_decision(decision(False)) is False
    assert store.record_decision(decision(True)) is True       # ticked again
    assert store.record_decision(decision(False, action="condense")) is True
    assert store.record_decision(decision(False, report_day="2026-09-20")) is True
    assert store.record_decision(decision(True, realm_folder="classes")) is True

    listed = store.decisions("projects")
    assert [d.id for d in listed] == sorted(d.id for d in listed)
    assert [(d.report_day, d.action, d.accepted) for d in listed] == [
        ("2026-09-27", "prune", True), ("2026-09-27", "prune", False),
        ("2026-09-27", "prune", True), ("2026-09-27", "condense", False),
        ("2026-09-20", "prune", False),
    ]
    assert listed[0].recorded_at == NOW
    assert store.latest_decisions("projects", "2026-09-27") == {
        ("s1", "prune"): True, ("s1", "condense"): False,
    }
    assert store.latest_decisions("projects", date(2026, 9, 20)) == {("s1", "prune"): False}
    assert store.latest_decisions("projects", "2026-01-01") == {}
    assert store.latest_decisions("classes", "2026-09-27") == {("s1", "prune"): True}


def test_a_decision_keeps_a_recorded_at_it_was_given() -> None:
    store = InMemoryCurateStore(clock=clock)
    store.record_decision(decision(recorded_at="2026-09-28T09:00:00-04:00"))
    assert store.decisions("projects")[0].recorded_at == "2026-09-28T13:00:00+00:00"


def test_the_protocol_names_every_cb_method_and_all_stores_carry_them() -> None:
    wanted = {"get_history_week", "put_history_week", "put_note_score", "note_scores",
              "get_importance", "put_importance", "put_proposal", "proposals",
              "record_decision", "decisions", "latest_decisions"}
    assert wanted <= set(vars(curate_store.CurateStore))
    for implementation in (InMemoryCurateStore, PostgresCurateStore, DryRunStore):
        assert all(callable(getattr(implementation, name, None)) for name in wanted), implementation


# -- dry run -----------------------------------------------------------------------


class RefusingStore(InMemoryCurateStore):
    """A base store whose C-b writes raise: a dry run must never reach them."""

    def _refuse(self, *args, **kwargs):
        raise AssertionError("a dry run must not write to the base store")

    put_history_week = put_note_score = put_importance = put_proposal = record_decision = _refuse


def seeded_base() -> RefusingStore:
    base = RefusingStore(clock=clock)
    InMemoryCurateStore.put_history_week(base, week())
    InMemoryCurateStore.put_note_score(base, score("s1"))
    InMemoryCurateStore.put_importance(base, judgement())
    InMemoryCurateStore.put_proposal(base, proposal("s1"))
    InMemoryCurateStore.record_decision(base, decision(True))
    return base


def test_dry_run_reads_reach_the_base() -> None:
    overlay = DryRunStore(seeded_base())

    assert overlay.get_history_week("agentic-harness", "2026-09-21", "ih1", "hv1") == week(created_at=NOW)
    assert [s.note_id for s in overlay.note_scores("agentic-harness", "2026-09-27")] == ["s1"]
    assert overlay.get_importance("s1", "h1", "sv1").importance == 7
    assert [p.note_id for p in overlay.proposals("projects")] == ["s1"]
    assert [d.accepted for d in overlay.decisions("projects")] == [True]
    assert overlay.latest_decisions("projects", "2026-09-27") == {("s1", "prune"): True}


def test_dry_run_writes_stay_in_memory_and_are_visible_to_later_reads() -> None:
    base = seeded_base()
    overlay = DryRunStore(base)

    overlay.put_history_week(week(input_hash="ih2"))
    overlay.put_history_week(week(narrative=({"text": "ignored", "note_ids": []},)))
    assert overlay.get_history_week("agentic-harness", "2026-09-21", "ih2", "hv1") == week(input_hash="ih2")
    assert overlay.get_history_week("agentic-harness", "2026-09-21", "ih1", "hv1").narrative == week().narrative

    assert overlay.put_note_score(score("s1")) is False      # already in the base
    assert overlay.put_note_score(score("s0")) is True
    assert overlay.put_note_score(score("s0")) is False      # already in the overlay
    assert [s.note_id for s in overlay.note_scores("agentic-harness", "2026-09-27")] == ["s0", "s1"]

    overlay.put_importance(judgement(importance=2))           # the base's 7 wins
    overlay.put_importance(judgement(content_hash="h2", importance=4))
    overlay.put_importance(judgement(content_hash="h2", importance=9))
    assert overlay.get_importance("s1", "h1", "sv1").importance == 7
    assert overlay.get_importance("s1", "h2", "sv1").importance == 4

    assert overlay.put_proposal(proposal("s1")) is False
    assert overlay.put_proposal(proposal("s0", "condense")) is True
    assert overlay.put_proposal(proposal("s0", "condense")) is False
    assert [(p.action, p.note_id) for p in overlay.proposals("projects")] == [
        ("condense", "s0"), ("prune", "s1")]

    assert overlay.record_decision(decision(True)) is False  # same as the base's latest
    assert overlay.record_decision(decision(False)) is True
    assert overlay.record_decision(decision(False)) is False
    assert overlay.record_decision(decision(True, note_id="s0", action="condense")) is True
    listed = overlay.decisions("projects")
    assert [d.accepted for d in listed] == [True, False, True]
    assert [d.id for d in listed] == sorted(d.id for d in listed)
    assert len({d.id for d in listed}) == 3
    assert overlay.latest_decisions("projects", "2026-09-27") == {
        ("s1", "prune"): False, ("s0", "condense"): True}

    # The base is untouched.
    assert base.get_history_week("agentic-harness", "2026-09-21", "ih2", "hv1") is None
    assert [s.note_id for s in base.note_scores("agentic-harness", "2026-09-27")] == ["s1"]
    assert base.get_importance("s1", "h2", "sv1") is None
    assert [p.note_id for p in base.proposals("projects")] == ["s1"]
    assert base.latest_decisions("projects", "2026-09-27") == {("s1", "prune"): True}


def test_a_dry_run_over_an_empty_base_writes_nothing_to_it() -> None:
    base = RefusingStore(clock=clock)
    overlay = DryRunStore(base)
    assert overlay.record_decision(decision(True)) is True
    assert overlay.put_note_score(score()) is True
    assert overlay.put_proposal(proposal()) is True
    assert base.decisions("projects") == () and base.proposals("projects") == ()


class CountingStore(InMemoryCurateStore):
    """Counts the base reads a dry run's score and proposal writes make."""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.score_reads: list[tuple[str, str]] = []
        self.proposal_reads: list[str] = []

    def note_scores(self, collection, run_day):
        self.score_reads.append((collection, str(run_day)))
        return super().note_scores(collection, run_day)

    def proposals(self, realm_folder):
        self.proposal_reads.append(realm_folder)
        return super().proposals(realm_folder)


def test_dry_run_score_and_proposal_writes_read_the_base_once_per_key() -> None:
    base = CountingStore(clock=clock)
    base.put_note_score(score("s1"))
    base.put_proposal(proposal("s1"))
    overlay = DryRunStore(base)

    results = [overlay.put_note_score(score(f"s{n}")) for n in range(1, 6)]
    assert results == [False, True, True, True, True]
    assert overlay.put_note_score(score("s1", run_day="2026-09-28")) is True
    assert base.score_reads == [("agentic-harness", "2026-09-27"), ("agentic-harness", "2026-09-28")]

    results = [overlay.put_proposal(proposal(f"s{n}")) for n in range(1, 6)]
    assert results == [False, True, True, True, True]
    assert overlay.put_proposal(proposal("s1", realm_folder="classes")) is True
    assert base.proposal_reads == ["projects", "classes"]


# -- Postgres, against a fake connection ------------------------------------------

WEEK_ROW = ("agentic-harness", date(2026, 9, 21), "ih1", "hv1",
            [{"text": "The hooks learned to capture.", "note_ids": ["s1", "s2"]}],
            {"s1": "Hook capture", "s2": "Capture tests"}, "haiku", 900, 120, CREATED)
SCORE_ROW = ("s1", "sv1", date(2026, 9, 27), "h1", "projects", "agentic-harness", 3.5, 0.25,
             {"commits": 2, "prs": 1, "recency": 0.5}, None, CREATED)
IMPORTANCE_ROW = ("s1", "h1", "sv1", 7, "haiku", CREATED)
PROPOSAL_ROW = ("projects", date(2026, 9, 27), "s1", "prune", "agentic-harness",
                ["no commit", "no decision"], True, CREATED)
DECISION_ROW = (4, "projects", date(2026, 9, 27), "s1", "prune", True, CREATED)


def test_postgres_history_week_round_trip() -> None:
    conn = FakeConnection({"FROM curate.history_weeks": [WEEK_ROW]})
    store = PostgresCurateStore(conn)

    assert store.get_history_week("agentic-harness", "2026-09-21", "ih1", "hv1") == week(created_at=NOW)
    assert conn.log[0][1] == ("agentic-harness", "2026-09-21", "ih1", "hv1")
    store.put_history_week(week())
    sql, params = conn.log[1]
    assert "ON CONFLICT (collection, week_start, input_hash, history_version) DO NOTHING" in sql
    assert '[{"text": "The hooks learned to capture.", "note_ids": ["s1", "s2"]}]' in params
    assert '{"s1": "Hook capture", "s2": "Capture tests"}' in params
    assert conn.commits == 1
    assert_parameterized(conn.log, "agentic-harness", "ih1", "Hook capture")


def test_postgres_json_columns_decode_from_text_too() -> None:
    import json

    row = (*WEEK_ROW[:4], json.dumps(WEEK_ROW[4]), json.dumps(WEEK_ROW[5]), *WEEK_ROW[6:])
    found = PostgresCurateStore(FakeConnection({"FROM curate.history_weeks": [row]})).get_history_week(
        "agentic-harness", "2026-09-21", "ih1", "hv1")
    assert found == week(created_at=NOW)


def test_postgres_a_wrongly_shaped_json_column_is_a_store_error() -> None:
    row = (*WEEK_ROW[:5], ["not", "an", "object"], *WEEK_ROW[6:])
    store = PostgresCurateStore(FakeConnection({"FROM curate.history_weeks": [row]}))
    with pytest.raises(StoreError):
        store.get_history_week("agentic-harness", "2026-09-21", "ih1", "hv1")


def test_postgres_note_scores() -> None:
    landed = FakeConnection({"INSERT INTO curate.note_scores": [("s1",)],
                             "FROM curate.note_scores": [SCORE_ROW]})
    store = PostgresCurateStore(landed)
    assert store.put_note_score(score(importance=6)) is True
    sql, params = landed.log[0]
    assert "ON CONFLICT (note_id, scorer_version, run_day) DO NOTHING" in sql and "RETURNING" in sql
    assert '{"commits": 2, "prs": 1, "recency": 0.5}' in params and 6 in params

    assert store.note_scores("agentic-harness", date(2026, 9, 27)) == (score(created_at=NOW),)
    sql, params = landed.log[1]
    assert params == ("agentic-harness", "2026-09-27")
    assert "ORDER BY note_id, scorer_version" in sql
    assert_parameterized(landed.log, "s1", "agentic-harness")

    assert PostgresCurateStore(FakeConnection()).put_note_score(score()) is False


def test_postgres_importance() -> None:
    conn = FakeConnection({"FROM curate.importance_judgements": [IMPORTANCE_ROW]})
    store = PostgresCurateStore(conn)
    assert store.get_importance("s1", "h1", "sv1") == judgement(created_at=NOW)
    assert PostgresCurateStore(FakeConnection()).get_importance("s1", "h1", "sv1") is None
    store.put_importance(judgement())
    assert "ON CONFLICT (note_id, content_hash, scorer_version) DO NOTHING" in conn.log[1][0]
    assert conn.log[1][1][:4] == ("s1", "h1", "sv1", 7)
    assert_parameterized(conn.log, "s1", "haiku")


def test_postgres_proposals() -> None:
    conn = FakeConnection({"INSERT INTO curate.proposals": [("s1",)],
                           "FROM curate.proposals": [PROPOSAL_ROW]})
    store = PostgresCurateStore(conn)
    assert store.put_proposal(proposal()) is True
    sql, params = conn.log[0]
    assert "ON CONFLICT (realm_folder, report_day, note_id, action) DO NOTHING" in sql
    assert '["no commit", "no decision"]' in params and True in params

    assert store.proposals("projects") == (proposal(created_at=NOW),)
    assert "ORDER BY report_day, action, note_id" in conn.log[1][0]
    assert_parameterized(conn.log, "projects", "no commit")
    assert PostgresCurateStore(FakeConnection()).put_proposal(proposal()) is False


def test_postgres_record_decision_checks_the_latest_in_one_transaction() -> None:
    differs = FakeConnection({"SELECT accepted FROM curate.decisions": [(False,)],
                              "INSERT INTO curate.decisions": [(5,)]})
    assert PostgresCurateStore(differs).record_decision(decision(True)) is True
    statements = [sql for sql, _ in differs.log]
    assert any("LOCK TABLE curate.decisions" in sql for sql in statements)
    assert sum("INSERT INTO curate.decisions" in sql for sql in statements) == 1
    assert differs.commits == 1
    select = next(p for sql, p in differs.log if "SELECT accepted" in sql)
    assert select == ("projects", "2026-09-27", "s1", "prune")
    assert_parameterized(differs.log, "projects", "s1")

    first = FakeConnection({"INSERT INTO curate.decisions": [(1,)]})
    assert PostgresCurateStore(first).record_decision(decision(False)) is True

    same = FakeConnection({"SELECT accepted FROM curate.decisions": [(True,)]})
    assert PostgresCurateStore(same).record_decision(decision(True)) is False
    assert not any("INSERT" in sql for sql, _ in same.log)
    assert same.commits == 1  # the (empty) transaction still ends, releasing the lock


def test_postgres_record_decision_errors_roll_back() -> None:
    conn = FakeConnection(raise_on="INSERT INTO curate.decisions")
    with pytest.raises(StoreError, match="simulated database error"):
        PostgresCurateStore(conn).record_decision(decision())
    assert conn.rollbacks >= 1 and conn.commits == 0


def test_postgres_decisions_and_latest() -> None:
    conn = FakeConnection({
        "SELECT id, realm_folder": [DECISION_ROW],
        "SELECT DISTINCT ON": [("s1", "prune", False), ("s2", "condense", True)],
    })
    store = PostgresCurateStore(conn)
    assert store.decisions("projects") == (decision(True, id=4, recorded_at=NOW),)
    assert "ORDER BY id" in conn.log[0][0]
    assert store.latest_decisions("projects", date(2026, 9, 27)) == {
        ("s1", "prune"): False, ("s2", "condense"): True}
    sql, params = conn.log[1]
    assert params == ("projects", "2026-09-27")
    assert "ORDER BY note_id, action, id DESC" in sql
    assert_parameterized(conn.log, "projects")


# -- the migration -----------------------------------------------------------------


def cb_migration() -> Path:
    matches = sorted(DEFAULT_MIGRATIONS_DIR.glob("*_curate_status_scores.sql"))
    assert len(matches) == 1, matches
    return matches[0]


def test_the_cb_migration_sorts_after_the_curate_schema() -> None:
    path = cb_migration()
    match = FILENAME.match(path.name)
    assert match is not None
    version = match["version"]
    datetime.strptime(version, "%Y%m%d%H%M%S")
    assert version.startswith("20260927") and version > CURATE_SCHEMA_VERSION
    assert [m.version for m in discover()].count(version) == 1


def test_the_cb_tables_have_row_level_security_and_nothing_is_granted() -> None:
    sql = cb_migration().read_text(encoding="utf-8").lower()
    tables = re.findall(r"create table (curate\.\w+)", sql)

    assert set(tables) == {"curate.history_weeks", "curate.note_scores",
                           "curate.importance_judgements", "curate.proposals", "curate.decisions"}
    for table in tables:
        assert re.search(rf"alter table {re.escape(table)}\s+enable row level security", sql), table
        assert f"comment on table {table} is" in sql, table
    assert not re.search(r"\bgrant\b", sql)
    assert "create policy" not in sql
    assert "revoke all on all tables in schema curate" in sql
    assert "revoke all on all sequences in schema curate" in sql


def test_the_cb_migration_carries_the_contract_constraints() -> None:
    sql = " ".join(cb_migration().read_text(encoding="utf-8").lower().split())

    assert "primary key (collection, week_start, input_hash, history_version)" in sql
    assert "primary key (note_id, scorer_version, run_day)" in sql
    assert "primary key (note_id, content_hash, scorer_version)" in sql
    assert "primary key (realm_folder, report_day, note_id, action)" in sql
    assert "id bigint generated always as identity primary key" in sql
    assert sql.count("check (action in ('condense', 'prune'))") == 2
    assert "importance between 1 and 10" in sql
    assert "jsonb_typeof(narrative) = 'array'" in sql
    assert "jsonb_typeof(titles) = 'object'" in sql
    assert "jsonb_typeof(features) = 'object'" in sql
    assert "jsonb_typeof(reasons) = 'array'" in sql
    assert "on delete cascade" not in sql
    # A new file only adds: it never reshapes or empties what the curate schema already holds.
    assert not re.search(r"\b(drop (table|schema|column)|delete from|update curate|truncate)\b", sql)
    assert not re.search(r"alter table curate\.\w+ (add|drop|alter|rename)\b", sql)
