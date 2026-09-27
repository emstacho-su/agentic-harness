"""Tests for the history stage's weeks and judge calls (curate/history.py, R-C5).

No model and no database: a :class:`FakeJudge` and an :class:`InMemoryCurateStore`
over tmp vaults whose dates each test chooses. The helpers here are shared by the
render and CLI tests.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from ingest.curate import history
from ingest.curate.dry_run_store import DryRunStore
from ingest.curate.extract_plan import Budget
from ingest.curate.gitfacts import Commit, GitFacts, PullRequest
from ingest.curate.history import build_history, history_version, week_inputs
from ingest.curate.inventory import build_inventory
from ingest.curate.judge import FakeJudge, JudgeError, JudgeUsage
from ingest.curate.ledger import MAX_CONSECUTIVE_FAILURES, STOP_BUDGET, STOP_FAILURES, Spend
from ingest.curate.store_models import Extraction, HistoryWeek, InMemoryCurateStore

VERSION = "c2-test+00000000"
HVERSION = "c5-test+00000000"
BIG = Budget(max_calls=100, max_tokens=10_000_000)

HUB = """---
id: 'hub-demo'
title: 'demo'
collection: 'demo'
type: index
kind: project
---
# demo
"""

NOTE = """---
id: '{note_id}'
title: 'Title {stem}'
type: {type}
collection: 'demo'
{extra}{date_line}
captured_by: 'hook'
---
{body}
"""


# -- vault helpers (shared with the render and CLI tests) ---------------------------------------


def _write(root: Path, relative: str, note_id: str, stem: str, date: str | None, body: str,
           type_: str = "session", extra: str = "") -> None:
    folder = root / "projects" / "demo"
    folder.mkdir(parents=True, exist_ok=True)
    if not (folder / "demo.md").exists():
        (folder / "demo.md").write_text(HUB, encoding="utf-8")
    target = folder / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    date_line = f"date: {date}" if date else "note: undated"
    target.write_text(NOTE.format(note_id=note_id, stem=stem, type=type_, extra=extra, date_line=date_line,
                                  body=body), encoding="utf-8")


def add_session(root: Path, stem: str, date: str | None, body: str | None = None) -> None:
    _write(root, f"sessions/{stem}.md", f"session-{stem}", stem, date, body or f"Body of {stem}.",
           extra=f"session_id: '{stem}'\norigin: 'cli'\n")


def add_subagent(root: Path, parent: str, agent: str, date: str | None) -> None:
    stem = f"{parent}--{agent}"
    _write(root, f"sessions/{stem}.md", f"session-{stem}", stem, date, f"Subagent {agent} of {parent}.",
           extra=f"parent_session: '{parent}'\norigin: 'cli'\n")


def add_note(root: Path, stem: str, date: str | None) -> None:
    _write(root, f"notes/{stem}.md", f"note-{stem}", stem, date, f"Note {stem}.", type_="note")


def add_decision(root: Path, stem: str, date: str | None) -> None:
    _write(root, f"decisions/{stem}.md", f"decision-{stem}", stem, date, f"Decision {stem}.", type_="decision")


def make_vault(tmp_path: Path) -> Path:
    root = tmp_path / "vault"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / ".realm").write_text("projects", encoding="utf-8")
    return root


def inventory(root: Path, git=None):
    collector = (lambda repo_path, repo_slug: git) if git is not None else None
    return build_inventory(root, git_collector=collector, runner=_no_runner).collections[0]


def _no_runner(args, cwd=None):  # pragma: no cover - no hub here names a repo
    raise AssertionError("no command here")


def records_by_id(inv) -> dict:
    from ingest.curate.extract_plan import collection_notes

    return {r.note_id: r for r in collection_notes(inv)}


def seed(store, inv, items_by_id: dict[str, list[dict]], version: str = VERSION) -> None:
    for note_id, items in items_by_id.items():
        r = records_by_id(inv)[note_id]
        store.put_extraction(Extraction(note_id=r.note_id, content_hash=r.content_hash, extractor_version=version,
                                        collection="demo", note_path=r.path, result=tuple(items)))


def narrative_answer(labels=("S1",), text: str = "Worked on the parser.") -> dict:
    return {"paragraphs": [{"text": text, "cites": list(labels)}], "titles": []}


def labels_in(prompt: str) -> list[str]:
    return re.findall(r"<<<SESSION (S\d+) [0-9a-f]+>>>", prompt)


def run(inv, store, judge=None, *, budget: Budget = BIG, spend=None, dry_run: bool = False):
    spend = spend or Spend(budget)
    source = None if dry_run else (lambda: judge)
    result = build_history(inv, store, source, spend, version=HVERSION, extractor_version=VERSION,
                           nonce=lambda texts: "feedc0de")
    return result, spend


def commit(sha: str, date: str, subject: str = "feat: a thing") -> Commit:
    return Commit(sha, date, subject, "feat", None, False, (), True)


def pr(number: int, merged_at: str | None, title: str = "a PR") -> PullRequest:
    state = "MERGED" if merged_at else "OPEN"
    return PullRequest(number, title, state, "branch", "2026-09-01T00:00:00Z", merged_at, None, ())


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    root = make_vault(tmp_path)
    add_session(root, "sun", "2026-09-20")          # Sunday: week of 2026-09-14
    add_subagent(root, "sun", "agent1", "2026-09-21")  # nested under its Sunday parent
    add_session(root, "mon", "2026-09-21")          # Monday: week of 2026-09-21
    add_note(root, "tue", "2026-09-22")
    add_decision(root, "early", "2026-09-15")
    add_session(root, "nodate", None)
    return root


# -- weeks ----------------------------------------------------------------------------------------


def test_records_group_by_iso_week_with_subagents_under_their_parent(vault: Path) -> None:
    weeks = week_inputs(inventory(vault), InMemoryCurateStore().get_extractions, None, version=VERSION)
    assert [w.week_start for w in weeks] == ["2026-09-14", "2026-09-21"]
    assert [r.record.note_id for r in weeks[0].records] == [
        "decision-early", "session-sun", "session-sun--agent1"]
    assert [r.record.note_id for r in weeks[1].records] == ["session-mon", "note-tue"]


def test_undated_records_are_left_out_and_reported(vault: Path) -> None:
    inv = inventory(vault)
    weeks = week_inputs(inv, InMemoryCurateStore().get_extractions, None, version=VERSION)
    assert "session-nodate" not in {r.record.note_id for w in weeks for r in w.records}
    result, _ = run(inv, InMemoryCurateStore(), FakeJudge(lambda p, s: narrative_answer()))
    assert result.undated == ("projects/demo/sessions/nodate.md",)


def test_an_undated_subagent_follows_its_dated_parent(tmp_path: Path) -> None:
    root = make_vault(tmp_path)
    add_session(root, "p", "2026-09-23")
    add_subagent(root, "p", "a", None)
    (only,) = week_inputs(inventory(root), InMemoryCurateStore().get_extractions, None, version=VERSION)
    assert [r.record.note_id for r in only.records] == ["session-p", "session-p--a"]
    assert only.records[1].effective_at == only.records[0].effective_at


def test_commits_and_merged_prs_fall_in_their_utc_week(vault: Path) -> None:
    git = GitFacts(
        commits=(commit("a" * 40, "2026-09-20T23:30:00-04:00"),   # Monday 03:30 UTC
                 commit("b" * 40, "2026-09-16T12:00:00+00:00"),
                 commit("c" * 40, "2026-08-01T12:00:00+00:00")),  # a week with no notes: left out
        prs=(pr(1, "2026-09-21T09:00:00Z"), pr(2, None), pr(3, "2026-09-19T09:00:00Z")),
        warnings=(),
    )
    weeks = week_inputs(inventory(vault), InMemoryCurateStore().get_extractions, git, version=VERSION)
    assert [w.week_start for w in weeks] == ["2026-09-14", "2026-09-21"]
    assert [c.sha[0] for c in weeks[0].commits] == ["b"] and [p.number for p in weeks[0].prs] == [3]
    assert [c.sha[0] for c in weeks[1].commits] == ["a"] and [p.number for p in weeks[1].prs] == [1]


def test_items_come_from_the_current_extractor_version_only(vault: Path) -> None:
    inv = inventory(vault)
    store = InMemoryCurateStore()
    seed(store, inv, {"session-mon": [{"type": "decision", "summary": "use weeks", "evidence": "e" * 12}]})
    seed(store, inv, {"session-sun": [{"type": "decision", "summary": "stale", "evidence": "e" * 12}]},
         version="c2-old+11111111")
    weeks = week_inputs(inv, store.get_extractions, None, version=VERSION)
    items = {r.record.note_id: r.items for w in weeks for r in w.records}
    assert items["session-mon"] == ({"type": "decision", "summary": "use weeks", "evidence": "e" * 12},)
    assert items["session-sun"] == ()


def test_the_input_hash_is_stable_and_moves_with_its_inputs(vault: Path) -> None:
    lookup = InMemoryCurateStore().get_extractions
    first = week_inputs(inventory(vault), lookup, None, version=VERSION)
    again = week_inputs(inventory(vault), lookup, None, version=VERSION)
    assert [w.input_hash for w in first] == [w.input_hash for w in again]
    assert all(re.fullmatch(r"[0-9a-f]{64}", w.input_hash) for w in first)

    other_version = week_inputs(inventory(vault), lookup, None, version="c2-other+22222222")
    assert all(a.input_hash != b.input_hash for a, b in zip(first, other_version))

    with_git = week_inputs(inventory(vault), lookup, GitFacts((commit("d" * 40, "2026-09-23T00:00:00Z"),), (), ()),
                           version=VERSION)
    assert with_git[0].input_hash == first[0].input_hash and with_git[1].input_hash != first[1].input_hash

    add_session(vault, "mon", "2026-09-21", body="Body of mon, edited.")
    edited = week_inputs(inventory(vault), lookup, None, version=VERSION)
    assert edited[0].input_hash == first[0].input_hash and edited[1].input_hash != first[1].input_hash


def test_history_version_is_a_fingerprinted_c5_version() -> None:
    assert re.fullmatch(r"c5-v1\+[0-9a-f]{8}", history_version())
    assert history_version() == history_version()


# -- judge calls ----------------------------------------------------------------------------------


def test_each_uncached_week_costs_one_call_and_is_stored(vault: Path) -> None:
    store = InMemoryCurateStore()
    judge = FakeJudge(lambda prompt, schema: narrative_answer(labels_in(prompt)[:1]))
    inv = inventory(vault)
    result, spend = run(inv, store, judge)
    assert len(judge.calls) == 2 and result.judge_calls == 2 and spend.calls == 2
    assert result.cached == 0 and result.pending == 0 and result.would_ask == 0
    for w in result.weeks:
        stored = store.get_history_week("demo", w.week_start, w.input_hash, HVERSION)
        assert stored is not None and stored.model == "fake-judge"
        assert stored.narrative == ({"text": "Worked on the parser.", "note_ids": [w.records[0].record.note_id]},)
    assert spend.tokens > 0


def test_a_cache_hit_skips_the_judge(vault: Path) -> None:
    store = InMemoryCurateStore()
    inv = inventory(vault)
    run(inv, store, FakeJudge(lambda p, s: narrative_answer()))
    judge = FakeJudge([])
    result, spend = run(inventory(vault), store, judge)
    assert judge.calls == () and spend.calls == 0
    assert result.cached == 2 and result.judge_calls == 0 and result.pending == 0
    assert set(result.narratives) == {"2026-09-14", "2026-09-21"}


def test_the_answer_is_mapped_back_with_drops_counted(vault: Path) -> None:
    def answer(prompt: str, schema: dict) -> dict:
        labels = labels_in(prompt)
        return {
            "paragraphs": [
                {"text": "Cited paragraph.", "cites": [labels[-1], labels[0]]},
                {"text": "Uncited paragraph.", "cites": []},
            ],
            "titles": [
                {"ref": labels[0], "title": "first title"},
                {"ref": labels[0], "title": "duplicate title"},
                {"ref": labels[-1], "title": "t" * 200},
            ],
        }

    store = InMemoryCurateStore()
    result, _ = run(inventory(vault), store, FakeJudge(answer))
    first = result.narratives["2026-09-14"]
    week = result.weeks[0]
    ids = [r.record.note_id for r in week.records]
    assert first.narrative == ({"text": "Cited paragraph.", "note_ids": [ids[0], ids[-1]]},)
    assert first.titles == {ids[0]: "first title", ids[-1]: "t" * 120}
    assert result.dropped_paragraphs == 2 and result.dropped_titles == 2 and result.dropped_citations == 0


def test_a_week_whose_paragraphs_all_drop_is_still_cached(vault: Path) -> None:
    store = InMemoryCurateStore()
    result, _ = run(inventory(vault), store, FakeJudge(lambda p, s: {"paragraphs": [{"text": "x", "cites": []}],
                                                                        "titles": []}))
    assert result.pending == 0 and all(n.narrative == () for n in result.narratives.values())


def test_the_prompt_uses_the_collection_kind_and_labels_every_record(vault: Path) -> None:
    judge = FakeJudge(lambda p, s: narrative_answer())
    run(inventory(vault), InMemoryCurateStore(), judge)
    first = judge.calls[0]
    assert labels_in(first.prompt) == ["S1", "S2", "S3"]
    assert "software project" in first.prompt
    assert first.schema["properties"]["titles"]["items"]["properties"]["ref"]["enum"] == ["S1", "S2", "S3"]


def test_a_budget_stop_leaves_later_weeks_pending(vault: Path) -> None:
    store = InMemoryCurateStore()
    judge = FakeJudge(lambda p, s: narrative_answer())
    result, spend = run(inventory(vault), store, judge, budget=Budget(max_calls=1, max_tokens=10_000_000))
    assert len(judge.calls) == 1 and spend.stopped == STOP_BUDGET
    assert result.pending == 1 and result.left == 1 and "2026-09-21" not in result.narratives
    assert history.exit_code([result], spend) == history.EXIT_BUDGET


def test_a_token_budget_too_small_for_one_week_asks_nothing(vault: Path) -> None:
    judge = FakeJudge([])
    result, spend = run(inventory(vault), InMemoryCurateStore(), judge, budget=Budget(max_calls=10, max_tokens=5))
    assert judge.calls == () and spend.stopped == STOP_BUDGET and result.pending == 2


def test_consecutive_judge_failures_stop_the_run(tmp_path: Path) -> None:
    root = make_vault(tmp_path)
    for day in ("2026-09-01", "2026-09-08", "2026-09-15"):
        add_session(root, f"s{day[-2:]}", day)
    failing = JudgeError("backend down")
    failing.usage = JudgeUsage(100, 5, None)
    judge = FakeJudge([failing, JudgeError("still down"), {"paragraphs": [], "titles": []}])
    result, spend = run(inventory(root), InMemoryCurateStore(), judge)
    assert MAX_CONSECUTIVE_FAILURES == 2
    assert len(judge.calls) == 2 and spend.stopped == STOP_FAILURES
    assert [week for week, _ in result.failed] == ["2026-08-31", "2026-09-07"]
    assert result.left == 1 and result.pending == 3
    assert spend.tokens >= 105  # the reported usage of the first failure is charged
    assert history.exit_code([result], spend) == history.EXIT_FAILED


def test_a_failure_between_successes_does_not_stop_the_run(tmp_path: Path) -> None:
    root = make_vault(tmp_path)
    for day in ("2026-09-01", "2026-09-08", "2026-09-15"):
        add_session(root, f"s{day[-2:]}", day)
    judge = FakeJudge([narrative_answer(), JudgeError("blip"), narrative_answer()])
    result, spend = run(inventory(root), InMemoryCurateStore(), judge)
    assert spend.stopped is None and len(judge.calls) == 3
    assert result.pending == 1 and len(result.failed) == 1
    assert history.exit_code([result], spend) == history.EXIT_FAILED


def test_a_dry_run_calls_nothing_and_stores_nothing(vault: Path) -> None:
    base = InMemoryCurateStore()
    result, spend = run(inventory(vault), DryRunStore(base), None, dry_run=True)
    assert result.would_ask == 2 and result.judge_calls == 0 and spend.calls == 0
    assert result.estimated_tokens > 0 and result.pending == 2
    assert all(base.get_history_week("demo", w.week_start, w.input_hash, HVERSION) is None for w in result.weeks)
    assert history.exit_code([result], spend) == history.EXIT_DONE


def test_a_dry_run_counts_cached_weeks_as_cached(vault: Path) -> None:
    store = InMemoryCurateStore()
    inv = inventory(vault)
    (first, _) = week_inputs(inv, store.get_extractions, None, version=VERSION)
    store.put_history_week(HistoryWeek("demo", first.week_start, first.input_hash, HVERSION, (), {}))
    result, _ = run(inv, store, None, dry_run=True)
    assert result.cached == 1 and result.would_ask == 1


def test_the_note_index_covers_every_dated_record(vault: Path) -> None:
    result, _ = run(inventory(vault), InMemoryCurateStore(), None, dry_run=True)
    assert set(result.note_index) == {r.record.note_id for w in result.weeks for r in w.records}
    assert result.note_index["session-sun"] == ("projects/demo/sessions/sun.md", "2026-09-20T00:00:00+00:00")
