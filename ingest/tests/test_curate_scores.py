"""R-C6's deterministic scores (curate/scores.py, score_features.py): features, impact,
the disagreement rule, relevance, and the judge's importance where features disagree.

No model, no database, no git: a fixture vault in ``tmp_path``, hand-built
extractions and git facts, :class:`FakeJudge`, :class:`InMemoryCurateStore`,
:class:`FakeEmbedder` and a dict of retrieval counts.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from conftest import FakeEmbedder
from ingest.curate import scores
from ingest.curate.dry_run_store import DryRunStore
from ingest.curate.extract_plan import Budget
from ingest.curate.gitfacts import Commit, GitFacts, PullRequest
from ingest.curate.inventory import build_inventory
from ingest.curate.judge import FakeJudge, JudgeError
from ingest.curate.ledger import Spend
from ingest.curate.retrieval_counts import DictRetrievalCounts
from ingest.curate.scores import (
    HALF_LIFE_DAYS,
    LEFT_BY_BUDGET,
    NoteFeatures,
    disagree,
    extract_features,
    impact,
    relevance,
    score_collection,
    scorer_version,
)
from ingest.curate.store_models import Extraction, InMemoryCurateStore, IssueEvent, IssueMember

EXTRACTOR = "c2-test+00000000"
RUN_DAY = "2026-09-27"
BIG = Budget(max_calls=100, max_tokens=10_000_000)
FENCE = re.compile(r"<<<NOTE N1 ([0-9a-f]+)>>>\n(.*?)\n<<<END NOTE N1 \1>>>", re.DOTALL)

HUB = """---
id: 'hub-demo'
title: 'demo'
type: index
kind: project
---
# demo
"""


def note_text(note_id: str, when: str, body: str, extra: str = "") -> str:
    return (f"---\nid: '{note_id}'\ntitle: 'Title of {note_id}'\ntype: session\ncollection: 'demo'\n"
            f"started_at: '{when}'\n{extra}---\n{body}\n")


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    root = tmp_path / "vault"
    demo = root / "projects" / "demo"
    (demo / "sessions").mkdir(parents=True)
    (demo / "notes").mkdir()
    (demo / "demo.md").write_text(HUB, encoding="utf-8")
    files = {
        "sessions/aaaa1111.md": note_text(
            "session-aaaa1111", "2026-09-20T10:00:00Z", "Built the store.",
            "commits: ['abc1234', 'zzzzzzz', 'fff0000']\nprs: [7, 99]\n"),
        "sessions/aaaa1111--agent1.md": note_text(
            "session-aaaa1111--agent1", "2026-09-20T11:00:00Z", "A worker ran the tests.",
            "parent_session: 'aaaa1111'\n"),
        "sessions/bbbb2222.md": note_text(
            "session-bbbb2222", "2026-09-21T09:00:00Z", "Carried on from aaaa1111 today."),
        "notes/early.md": note_text("note-early", "2026-09-01T00:00:00Z", "Planned aaaa1111 ahead of time."),
        "notes/plan.md": note_text(
            "note-plan", "2026-09-22T00:00:00Z", "See [[aaaa1111]] and session-bbbb2222 for the history."),
    }
    for relative, text in files.items():
        (demo / relative).write_text(text, encoding="utf-8")
    return root


def inventory(root: Path):
    return build_inventory(root, git_collector=None).collections[0]


def commit(sha: str, date: str) -> Commit:
    return Commit(sha=sha, date=date, subject="feat: x", type="feat", scope=None, breaking=False,
                  files=(), on_main=True)


def pr(number: int) -> PullRequest:
    return PullRequest(number=number, title="t", state="MERGED", head="b", created_at="2026-09-19T00:00:00Z",
                       merged_at="2026-09-20T00:00:00Z", merge_commit=None, commits=())


GIT = GitFacts(
    commits=(
        commit("abc1234" + "0" * 33, "2026-09-20T12:00:00Z"),
        commit("fff0000" + "1" * 33, "2026-09-20T13:00:00Z"),
        commit("fff0000" + "2" * 33, "2026-09-20T14:00:00Z"),  # makes the prefix fff0000 ambiguous
        commit("c1" + "0" * 38, "2026-09-21T08:00:00Z"),
        commit("c2" + "0" * 38, "2026-09-21T23:30:00-02:00"),  # 2026-09-22 in UTC
        commit("c3" + "0" * 38, "2026-09-22T01:00:00+03:00"),  # 2026-09-21 in UTC
        commit("c4" + "0" * 38, "2026-09-21T20:00:00Z"),
    ),
    prs=(pr(7),),
    warnings=(),
)


def items_for_aaaa() -> list[dict]:
    return [
        {"type": "issue", "kind": "bug", "summary": "s", "evidence": "e" * 12, "files": [], "claim": "found",
         "fix_ref": None},
        {"type": "issue", "kind": "bug", "summary": "t", "evidence": "e" * 12, "files": [], "claim": "fixed",
         "fix_ref": None},
        {"type": "decision", "summary": "d1", "evidence": "e" * 12},
        {"type": "decision", "summary": "d2", "evidence": "e" * 12},
        {"type": "requirement", "requirement_id": "R-C6"},
        {"type": "requirement", "requirement_id": "R-C7"},
        {"type": "status_claim", "requirement_id": "R-C6", "claim": "done", "evidence": "e" * 12},
    ]


def records_by_id(inv) -> dict:
    found = {}
    for group in inv.sessions:
        for record in (group.session, *group.subagents):
            found[record.note_id] = record
    for record in (*inv.notes, *inv.decisions):
        found[record.note_id] = record
    return found


def seed(store, inv, items_by_id: dict[str, list[dict]]) -> None:
    for note_id, record in records_by_id(inv).items():
        if note_id in items_by_id:
            store.put_extraction(Extraction(
                note_id=note_id, content_hash=record.content_hash, extractor_version=EXTRACTOR,
                collection="demo", note_path=record.path, result=items_by_id[note_id]))


def run(root: Path, store, judge=None, *, budget: Budget = BIG, counts=None, open_items=("R-C6 Scores",),
        run_day: str = RUN_DAY, spend: Spend | None = None, embedder: FakeEmbedder | None = None):
    spend = spend or Spend(budget)
    source = (lambda: judge) if judge is not None else None
    embedder = embedder or FakeEmbedder()
    result = score_collection(
        inventory(root), store, tuple(open_items), counts or DictRetrievalCounts(RETRIEVALS),
        lambda: embedder, source, spend, run_day=run_day, version=scorer_version(),
        extractor_version=EXTRACTOR, git=GIT)
    return result, spend


RETRIEVALS = {"session-aaaa1111": (6, 2), "note-plan": (5, 0)}


def fresh_store(root: Path) -> InMemoryCurateStore:
    """A store holding aaaa1111's extraction, so its knowledge matches its activity."""
    store = InMemoryCurateStore()
    seed(store, inventory(root), {"session-aaaa1111": items_for_aaaa()})
    return store


# -- features -----------------------------------------------------------------------------------


def features_of(root: Path, extractions=None, counts=None) -> dict[str, NoteFeatures]:
    inv = inventory(root)
    return extract_features(inv, extractions or {}, GIT, counts if counts is not None else RETRIEVALS)


def test_features_of_a_session_with_everything(vault: Path) -> None:
    inv = inventory(vault)
    record = records_by_id(inv)["session-aaaa1111"]
    extraction = Extraction(note_id=record.note_id, content_hash=record.content_hash, extractor_version=EXTRACTOR,
                            collection="demo", note_path=record.path, result=items_for_aaaa())

    found = extract_features(inv, {record.note_id: extraction}, GIT, RETRIEVALS)["session-aaaa1111"]

    assert found == NoteFeatures(
        commits=1,  # abc1234 names one commit; zzzzzzz is not a sha; fff0000 is ambiguous
        prs=1,  # 99 is not in git facts
        decisions=2, issues_found=1, issues_fixed=1, requirement_refs=2,
        citations=2,  # bbbb2222 and plan are later and name it; early is earlier
        retrievals=6, used=2, children=1, body_chars=len("Built the store."),
    )


def test_a_session_listing_no_commits_takes_the_same_utc_day(vault: Path) -> None:
    found = features_of(vault)["session-bbbb2222"]

    assert found.commits == 3  # c1, c3 (22:00 UTC on the 21st) and c4; not c2 (the 22nd in UTC)
    assert found.citations == 1  # plan names session-bbbb2222


def test_a_session_whose_listed_commits_match_nothing_gets_no_fallback(vault: Path) -> None:
    path = vault / "projects" / "demo" / "sessions" / "bbbb2222.md"
    path.write_text(path.read_text(encoding="utf-8").replace("---\nCarried", "commits: ['9999999']\n---\nCarried"),
                    encoding="utf-8")

    assert features_of(vault)["session-bbbb2222"].commits == 0


def test_subagents_and_notes_do_not_take_the_same_day_commits(vault: Path) -> None:
    found = features_of(vault)

    assert found["session-aaaa1111--agent1"].commits == 0
    assert found["note-plan"].commits == 0


def test_without_git_facts_no_commit_or_pr_counts(vault: Path) -> None:
    found = extract_features(inventory(vault), {}, None, {})["session-aaaa1111"]

    assert (found.commits, found.prs) == (0, 0)


def test_citations_need_a_later_note_and_a_whole_token(vault: Path) -> None:
    found = features_of(vault)

    assert found["note-plan"].citations == 0
    assert found["note-early"].citations == 0
    assert found["session-aaaa1111--agent1"].citations == 0  # aaaa1111 inside aaaa1111--agent1 is not it


def test_children_and_usage(vault: Path) -> None:
    found = features_of(vault)

    assert found["session-aaaa1111"].children == 1
    assert found["session-bbbb2222"].children == 0
    assert (found["note-plan"].retrievals, found["note-plan"].used) == (5, 0)
    assert (found["note-early"].retrievals, found["note-early"].used) == (0, 0)


# -- arithmetic ---------------------------------------------------------------------------------


def test_impact_of_nothing_is_zero() -> None:
    assert impact(NoteFeatures()) == 0.0


def test_impact_is_the_weighted_log_sum() -> None:
    features = NoteFeatures(commits=1, prs=3, decisions=2, used=1, body_chars=99_999)
    # 1.2 ln 2 + 1.5 ln 4 + 1.0 ln 3 + 1.0 ln 2; body_chars carries no weight
    expected = 1.2 * 0.6931471805599453 + 1.5 * 1.3862943611198906 + 1.0986122886681098 + 0.6931471805599453
    assert impact(features) == pytest.approx(expected, abs=1e-12)
    assert impact(features) == pytest.approx(4.7029776, abs=1e-6)


def test_impact_is_capped_at_ten() -> None:
    assert impact(NoteFeatures(commits=500, prs=500, decisions=500)) == 10.0


@pytest.mark.parametrize(("features", "expected"), [
    (NoteFeatures(), False),
    (NoteFeatures(commits=3), True),  # activity without knowledge
    (NoteFeatures(commits=1, prs=1, children=1), True),
    (NoteFeatures(commits=2), False),
    (NoteFeatures(commits=3, decisions=1), False),
    (NoteFeatures(decisions=3), True),  # knowledge without activity
    (NoteFeatures(issues_found=1, issues_fixed=1, requirement_refs=1), True),
    (NoteFeatures(decisions=3, prs=1), False),
    (NoteFeatures(retrievals=5), True),  # usage without either
    (NoteFeatures(retrievals=3, used=2), True),
    (NoteFeatures(retrievals=4), False),
    (NoteFeatures(retrievals=5, decisions=1), False),
    (NoteFeatures(citations=9, body_chars=9_000), False),  # neither activity, knowledge nor usage
])
def test_disagree(features: NoteFeatures, expected: bool) -> None:
    assert disagree(features) is expected


def test_relevance_combines_similarity_recency_and_the_ledger() -> None:
    value = relevance([1.0, 0.0], [[0.0, 1.0], [1.0, 0.0]], 90, 90, True)
    assert value == pytest.approx(0.5 * 1.0 + 0.3 * 0.5 + 0.2)


def test_relevance_without_open_items_is_recency_and_ledger_only() -> None:
    assert relevance([1.0, 0.0], [], 0, 42, False) == pytest.approx(0.3)
    assert relevance([1.0, 0.0], [], 42, 42, True) == pytest.approx(0.3 * 0.5 + 0.2)


def test_relevance_stays_in_zero_to_one() -> None:
    assert relevance([1.0, 0.0], [[-1.0, 0.0]], 10_000, 90, False) == pytest.approx(0.0, abs=1e-12)
    assert relevance([1.0, 0.0], [[1.0, 0.0]], -5, 90, True) == pytest.approx(1.0)
    assert relevance([1.0, 0.0], [[1.0, 0.0]], None, 90, False) == pytest.approx(0.5)


def test_relevance_with_fake_embedder_vectors() -> None:
    embedder = FakeEmbedder()
    note, same, other = embedder.embed(["abcd", "wxyz", "a much longer open item"])
    assert relevance(note, [same], 0, 90, False) == pytest.approx(0.8)  # same length, same vector
    assert 0.3 < relevance(note, [other], 0, 90, False) < 0.8


def test_half_lives_per_profile_kind() -> None:
    assert HALF_LIFE_DAYS == {"project": 90, "class": 42}


def test_scorer_version_is_stable_and_fingerprinted(monkeypatch) -> None:
    first = scorer_version()
    assert first == scorer_version()
    assert re.fullmatch(r"c6-v1\+[0-9a-f]{8}", first)
    monkeypatch.setitem(scores.WEIGHTS, "commits", 9.9)
    assert scorer_version() != first


# -- the run ------------------------------------------------------------------------------------


def disagreeing_judge(*answers: int) -> FakeJudge:
    return FakeJudge([{"importance": value} for value in answers])


def test_the_judge_is_asked_only_where_features_disagree(vault: Path) -> None:
    store = fresh_store(vault)
    judge = disagreeing_judge(8, 3)

    result, spend = run(vault, store, judge)

    # bbbb2222: three same-day commits and no knowledge; plan: five retrievals and nothing else
    assert result.judge_calls == 2 and spend.calls == 2 and len(judge.calls) == 2
    assert result.notes["session-bbbb2222"].importance == 8
    assert result.notes["note-plan"].importance == 3
    assert result.notes["session-aaaa1111"].importance is None
    base = impact(NoteFeatures(commits=3, body_chars=len("Carried on from aaaa1111 today."), citations=1))
    assert result.notes["session-bbbb2222"].impact == pytest.approx((base + 8) / 2)
    assert store.get_importance("note-plan", records_by_id(inventory(vault))["note-plan"].content_hash,
                                scorer_version()).importance == 3
    assert result.written == 5 and result.problems == ()


def test_the_importance_prompt_is_fenced_and_names_no_id_or_path(vault: Path) -> None:
    store = fresh_store(vault)
    judge = disagreeing_judge(8, 3)

    run(vault, store, judge)

    prompt, schema = judge.calls[0].prompt, judge.calls[0].schema
    fenced = FENCE.search(prompt)
    assert fenced is not None and "Carried on from aaaa1111 today." in fenced.group(2)
    assert "title: Title of session-bbbb2222" in fenced.group(2)  # the title is inside the fence
    outside = prompt.replace(fenced.group(0), "")
    assert "bbbb2222" not in outside and "projects/demo" not in prompt
    assert schema["properties"]["importance"] == {"type": "integer", "minimum": 1, "maximum": 10}


def test_the_prompt_carries_at_most_1500_body_chars(vault: Path) -> None:
    path = vault / "projects" / "demo" / "notes" / "plan.md"
    path.write_text(path.read_text(encoding="utf-8").replace("See [[", "x" * 1480 + "TAIL-MARKER See [["),
                    encoding="utf-8")
    judge = FakeJudge(lambda prompt, schema: {"importance": 5})

    run(vault, fresh_store(vault), judge)

    plan_prompt = next(call.prompt for call in judge.calls if "x" * 100 in call.prompt)
    assert "TAIL-MARKER" in plan_prompt and "history" not in FENCE.search(plan_prompt).group(2)


def test_a_rerun_uses_the_cached_importance(vault: Path) -> None:
    store = fresh_store(vault)
    run(vault, store, disagreeing_judge(8, 3))
    again = disagreeing_judge()

    result, _ = run(vault, store, again, run_day="2026-10-04")

    assert again.calls == () and result.judge_calls == 0 and result.cached_importance == 2
    assert result.notes["session-bbbb2222"].importance == 8
    assert result.written == 5


def test_a_same_day_rerun_writes_nothing_and_is_not_an_error(vault: Path) -> None:
    store = fresh_store(vault)
    run(vault, store, disagreeing_judge(8, 3))

    result, _ = run(vault, store, disagreeing_judge())

    assert result.written == 0 and result.already_scored == 5 and result.problems == ()
    assert len(store.note_scores("demo", RUN_DAY)) == 5


def test_a_budget_stop_leaves_the_rest_for_the_next_run(vault: Path) -> None:
    store = fresh_store(vault)

    result, spend = run(vault, store, disagreeing_judge(8), budget=Budget(max_calls=1, max_tokens=10_000_000))

    assert spend.stopped == "budget" and result.judge_calls == 1 and result.left == 1
    assert [p.reason for p in result.problems] == [LEFT_BY_BUDGET]
    assert result.problems[0].path == "projects/demo/notes/plan.md"
    stored = {score.note_id for score in store.note_scores("demo", RUN_DAY)}
    assert "note-plan" not in stored and len(stored) == 4
    assert result.notes["note-plan"].importance is None


def test_judge_failures_are_charged_and_stop_the_run(vault: Path) -> None:
    store = fresh_store(vault)
    judge = FakeJudge([JudgeError("backend down"), JudgeError("backend down")])

    result, spend = run(vault, store, judge)

    assert spend.stopped == "failures" and spend.calls == 2 and spend.tokens > 0
    assert all(p.reason.startswith("judge failed") for p in result.problems) and len(result.problems) == 2
    assert result.left == 2 and store.get_importance("note-plan", "x", scorer_version()) is None


def test_a_dry_run_counts_would_ask_and_writes_nothing(vault: Path) -> None:
    base = fresh_store(vault)

    result, spend = run(vault, DryRunStore(base))

    assert result.would_ask == 2 and result.judge_calls == 0 and spend.calls == 0
    assert base.note_scores("demo", RUN_DAY) == ()
    assert result.written == 5


def test_relevance_uses_the_open_items_and_the_ledger(vault: Path) -> None:
    store = fresh_store(vault)
    record = records_by_id(inventory(vault))["session-aaaa1111"]
    issue = store.create_issue("demo", "bug", "s", [], "2026-09-20T10:00:00Z")
    store.add_member(IssueMember(issue.issue_id, record.note_id, record.content_hash, EXTRACTOR, 0))
    store.add_event(IssueEvent(issue_id=issue.issue_id, to_state="open", event_kind="found",
                               effective_at="2026-09-20T10:00:00Z", cause_type="note", cause_ref=record.note_id))
    embedder = FakeEmbedder()

    result, _ = run(vault, store, disagreeing_judge(8, 3), embedder=embedder)

    score = result.notes["session-aaaa1111"]
    assert score.features["open_issue"] == 1 and result.notes["note-plan"].features["open_issue"] == 0
    assert score.features["recency"] == pytest.approx(2 ** (-7 / 90))
    assert 0.0 <= score.relevance <= 1.0
    expected = 0.5 * score.features["similarity"] + 0.3 * 2 ** (-7 / 90) + 0.2
    assert score.relevance == pytest.approx(expected)
    assert len(embedder.calls) == 2  # the notes once, the open items once
    assert embedder.calls[1] == ["R-C6 Scores"]
    assert embedder.calls[0][0].startswith("Title of session-aaaa1111\n")


def test_a_verified_issue_is_not_open(vault: Path) -> None:
    store = fresh_store(vault)
    record = records_by_id(inventory(vault))["session-aaaa1111"]
    issue = store.create_issue("demo", "bug", "s", [], "2026-09-20T10:00:00Z")
    store.add_member(IssueMember(issue.issue_id, record.note_id, record.content_hash, EXTRACTOR, 0))
    for state, kind, at in (("open", "found", "2026-09-20T10:00:00Z"), ("verified", "merged-pr", "2026-09-21T00:00:00Z")):
        store.add_event(IssueEvent(issue_id=issue.issue_id, to_state=state, event_kind=kind, effective_at=at,
                                   cause_type="note" if kind == "found" else "pr",
                                   cause_ref=record.note_id if kind == "found" else "7"))

    result, _ = run(vault, store, disagreeing_judge(8, 3))

    assert result.notes["session-aaaa1111"].features["open_issue"] == 0


def test_no_open_items_means_no_similarity_and_no_embedding(vault: Path) -> None:
    embedder = FakeEmbedder()

    result, _ = run(vault, fresh_store(vault), disagreeing_judge(8, 3), open_items=(), embedder=embedder)

    assert embedder.calls == []
    assert all(score.features["similarity"] == 0.0 for score in result.notes.values())


def test_scores_carry_the_features_and_the_run(vault: Path) -> None:
    result, _ = run(vault, fresh_store(vault), disagreeing_judge(8, 3))

    score = result.notes["session-aaaa1111"]
    assert (score.run_day, score.scorer_version, score.collection, score.realm) == (
        RUN_DAY, scorer_version(), "demo", None)  # a vault without realm markers
    assert score.features["commits"] == 1 and score.features["children"] == 1
    assert 0.0 <= score.impact <= 10.0


def test_the_run_day_defaults_to_the_clock(vault: Path) -> None:
    store = fresh_store(vault)

    result = score_collection(
        inventory(vault), store, (), DictRetrievalCounts({}), FakeEmbedder, None, Spend(BIG),
        version=scorer_version(), extractor_version=EXTRACTOR, git=GIT,
        clock=lambda: datetime(2026, 10, 1, 23, 30, tzinfo=timezone.utc))

    assert {score.run_day for score in result.notes.values()} == {"2026-10-01"}


def test_retrieval_counts_are_asked_once_by_note_id(vault: Path) -> None:
    counts = DictRetrievalCounts(RETRIEVALS)

    run(vault, fresh_store(vault), disagreeing_judge(8, 3), counts=counts)

    assert len(counts.asked) == 1
    assert set(counts.asked[0]) == {"session-aaaa1111", "session-aaaa1111--agent1", "session-bbbb2222",
                                    "note-early", "note-plan"}
