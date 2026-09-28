"""Tests for the status stage's logic (curate/status.py, R-C4).

The state rule is table-driven, one row per precedence case. Evidence is
collected from a tmp vault's inventory, an :class:`InMemoryCurateStore` holding
hand-built Extraction rows, plan documents parsed from text, and hand-built git
facts; nothing reaches a model, a database, git or the real vault.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ingest.curate.gitfacts import Commit, GitFacts, PullRequest
from ingest.curate.inventory import build_inventory
from ingest.curate.plan import PlanSourceProblem, parse_plan
from ingest.curate.status import (
    STATES,
    Claim,
    Evidence,
    RequirementIdCollision,
    build_status,
    note_index,
    open_items,
    requirement_state,
)
from ingest.curate.store_models import Extraction, InMemoryCurateStore

VERSION = "c2-test+00000000"
BRIEF = Path(__file__).parent / "fixtures" / "plans" / "50_PHASE7_retrieval_polish.md"

HUB = """---
id: 'hub-demo'
title: 'demo'
collection: 'demo'
type: index
kind: project
---
# demo
"""

SESSION = """---
id: 'session-{stem}'
title: 'Title {stem}'
type: session
collection: 'demo'
session_id: '{stem}'
{date_line}
origin: 'cli'
captured_by: 'hook'
---
Body of {stem}.
"""

PLAN = """# Demo plan

## Phase A — first

### R-A1 Build the parser
- **Done when.** it parses the plan.
- [x] parser written

### R-A2 Write the store
- [ ] store written

## Phase B — second

### R-B1 Ship it

### R-B2 Nobody touched this
"""


# -- the state rule ------------------------------------------------------------------------------

D1, D2, D3 = "2026-09-01T00:00:00+00:00", "2026-09-02T00:00:00+00:00", "2026-09-03T00:00:00+00:00"


def claim(state: str, at: str | None, note: str = "session-x") -> Claim:
    return Claim(state=state, text=f"{state} claim", note_id=note, at=at)


def note(at: str | None = D1) -> Evidence:
    return Evidence("note", "session-x", at, None)


def commit(on_main: bool, at: str = D2) -> Evidence:
    return Evidence("commit", "a" * 40, at, "feat: R-A1", landed=on_main)


def pr(merged: bool, at: str = D2) -> Evidence:
    return Evidence("pr", "7", at, "R-A1 work", landed=merged)


def plan_tick() -> Evidence:
    return Evidence("plan", "plan.md", None, "parser written", landed=False)


STATE_CASES = [
    # (name, claims, evidence, expected)
    ("nothing", [], [], "not started"),
    ("a mention", [], [note()], "in progress"),
    ("a commit off main", [], [commit(False)], "in progress"),
    ("a commit on main without a done claim", [], [commit(True)], "in progress"),
    ("an unmerged PR", [], [pr(False)], "in progress"),
    ("an in-progress claim", [claim("in-progress", D1)], [note()], "in progress"),
    ("a blocked claim", [claim("blocked", D1)], [note()], "in progress"),
    ("a broken claim without a done claim", [claim("broken", D1)], [note()], "in progress"),
    ("a done note claim", [claim("done", D1)], [note()], "claimed done"),
    ("a ticked plan checkbox", [], [plan_tick()], "claimed done"),
    ("a done claim and a commit off main", [claim("done", D1)], [note(), commit(False)], "claimed done"),
    ("a done claim and an unmerged PR", [claim("done", D1)], [note(), pr(False)], "claimed done"),
    ("a merged PR alone", [], [pr(True)], "verified"),
    ("a done claim and a commit on main", [claim("done", D1)], [note(), commit(True)], "verified"),
    ("a ticked checkbox and a commit on main", [], [plan_tick(), commit(True)], "verified"),
    ("done, then broken", [claim("done", D1), claim("broken", D2)], [note()], "contradicted"),
    ("done, then broken, with a commit on main",
     [claim("done", D1), claim("broken", D3)], [note(), commit(True, D2)], "contradicted"),
    ("a ticked checkbox, then broken", [claim("broken", D2)], [plan_tick(), note()], "contradicted"),
    ("a merged PR, then broken", [claim("broken", D3)], [pr(True, D2), note()], "contradicted"),
    ("broken, then done", [claim("broken", D1), claim("done", D2)], [note()], "claimed done"),
    ("done, broken, done again", [claim("done", D1), claim("broken", D2), claim("done", D3)], [note()],
     "claimed done"),
    ("a merged PR after the break", [claim("done", D1), claim("broken", D2)], [note(), pr(True, D3)], "verified"),
    ("an undated broken claim is never later", [claim("done", D1), claim("broken", None)], [note()],
     "claimed done"),
    ("a broken claim at the same instant is not later", [claim("done", D1), claim("broken", D1)], [note()],
     "claimed done"),
]


@pytest.mark.parametrize("name, claims, evidence, expected", STATE_CASES, ids=[c[0] for c in STATE_CASES])
def test_the_state_rule(name: str, claims, evidence, expected: str) -> None:
    assert requirement_state(tuple(claims), tuple(evidence)) == expected


def test_the_five_states_are_the_spec_words() -> None:
    assert STATES == ("not started", "in progress", "claimed done", "verified", "contradicted")


# -- evidence from a collection ------------------------------------------------------------------


def add_note(root: Path, stem: str, date: str | None) -> None:
    folder = root / "projects" / "demo"
    (folder / "sessions").mkdir(parents=True, exist_ok=True)
    if not (folder / "demo.md").exists():
        (folder / "demo.md").write_text(HUB, encoding="utf-8")
    date_line = f"date: {date}" if date else "note: undated"
    (folder / "sessions" / f"{stem}.md").write_text(SESSION.format(stem=stem, date_line=date_line),
                                                   encoding="utf-8")


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    root = tmp_path / "vault"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / ".realm").write_text("projects", encoding="utf-8")
    for stem, date in (("s1", "2026-09-01"), ("s2", "2026-09-02"), ("s3", "2026-09-03T12:00:00+02:00"),
                       ("s4", None)):
        add_note(root, stem, date)
    return root


def inventory(root: Path):
    return build_inventory(root, git_collector=None).collections[0]


def seed(store: InMemoryCurateStore, root: Path, items: dict[str, list[dict]], version: str = VERSION) -> None:
    for group in inventory(root).sessions:
        stem = Path(group.session.path).stem
        if stem in items:
            store.put_extraction(Extraction(
                note_id=group.session.note_id, content_hash=group.session.content_hash, extractor_version=version,
                collection="demo", note_path=group.session.path, result=tuple(items[stem]),
            ))


def requirement(rid: str) -> dict:
    return {"type": "requirement", "requirement_id": rid}


def status_claim(rid: str | None, state: str, text: str) -> dict:
    return {"type": "status_claim", "requirement_id": rid, "state": state, "claim": text,
            "evidence": f"quote about {text}"}


def git_commit(sha: str, date: str, subject: str, on_main: bool = True) -> Commit:
    return Commit(sha, date, subject, None, None, False, (), on_main)


def git_pr(number: int, title: str, merged_at: str | None) -> PullRequest:
    return PullRequest(number, title, "MERGED" if merged_at else "OPEN", "branch", "2026-09-01T00:00:00Z",
                       merged_at, None, ())


def build(root: Path, store: InMemoryCurateStore, git=None, docs=None):
    plan_docs = (parse_plan(PLAN, "/repo/docs/plan.md"),) if docs is None else docs
    return build_status(inventory(root), store.get_extractions, plan_docs, git, version=VERSION)


def by_id(status):
    return {r.id: r for r in status.requirements}


def test_every_plan_requirement_in_order_then_the_ones_not_in_the_plan(vault: Path) -> None:
    store = InMemoryCurateStore()
    seed(store, vault, {"s1": [requirement("R-Z9"), requirement("R-A1")], "s2": [requirement("R-C3")]})
    status = build(vault, store)
    assert [r.id for r in status.requirements] == ["R-A1", "R-A2", "R-B1", "R-B2", "R-C3", "R-Z9"]
    assert [r.in_plan for r in status.requirements] == [True, True, True, True, False, False]
    first = status.requirements[0]
    assert (first.title, first.phase, first.done_when) == ("Build the parser", "Phase A — first",
                                                           "it parses the plan.")
    assert (status.collection, status.realm_folder, status.folder) == ("demo", "projects", "projects/demo")


def test_states_from_notes_plan_and_git(vault: Path) -> None:
    store = InMemoryCurateStore()
    seed(store, vault, {
        "s1": [requirement("R-A1"), status_claim("R-A1", "done", "parser done")],
        "s2": [status_claim("R-A2", "in-progress", "store half written")],
        "s3": [status_claim("R-A1", "broken", "parser broke")],
    })
    git = GitFacts(
        commits=(git_commit("b" * 40, "2026-09-02T10:00:00Z", "feat: R-B1 ship it"),
                 git_commit("c" * 40, "2026-09-02T11:00:00Z", "fix: R-A10 is another id")),
        prs=(git_pr(4, "R-A2: the store", "2026-09-04T00:00:00Z"),), warnings=())
    status = build(vault, store, git)
    states = {r.id: r.state for r in status.requirements}
    assert states == {"R-A1": "contradicted", "R-A2": "verified", "R-B1": "in progress", "R-B2": "not started"}
    assert status.counts == {"not started": 1, "in progress": 1, "claimed done": 0, "verified": 1,
                             "contradicted": 1}
    a1 = by_id(status)["R-A1"]
    assert a1.latest_claim == Claim("broken", "parser broke", "session-s3", "2026-09-03T10:00:00+00:00")
    assert [(e.kind, e.ref) for e in a1.evidence] == [
        ("plan", "/repo/docs/plan.md"), ("note", "session-s1"), ("note", "session-s3")]
    assert [e.kind for e in by_id(status)["R-A2"].evidence] == ["note", "pr"]
    b1 = by_id(status)["R-B1"].evidence
    assert b1 == (Evidence("commit", "b" * 40, "2026-09-02T10:00:00+00:00", "feat: R-B1 ship it", landed=True),)


def test_only_extractions_at_the_current_version_count(vault: Path) -> None:
    store = InMemoryCurateStore()
    seed(store, vault, {"s1": [status_claim("R-A1", "done", "parser done")]}, version="c2-old+11111111")
    status = build(vault, store)
    assert by_id(status)["R-A1"].state == "claimed done"  # the plan tick, nothing from the old row
    assert [e.kind for e in by_id(status)["R-A1"].evidence] == ["plan"]
    assert (status.notes, status.extracted) == (4, 0)


def test_the_latest_claim_is_the_latest_dated_note_claim(vault: Path) -> None:
    store = InMemoryCurateStore()
    seed(store, vault, {
        "s1": [status_claim("R-B1", "in-progress", "started")],
        "s2": [status_claim("R-B1", "blocked", "waiting on review")],
        "s4": [status_claim("R-B1", "done", "undated and done")],
    })
    b1 = by_id(build(vault, store))["R-B1"]
    assert b1.latest_claim.text == "waiting on review"  # the undated claim counts as earliest
    assert [c.text for c in b1.claims] == ["undated and done", "started", "waiting on review"]
    assert b1.state == "claimed done"


def test_malformed_items_and_unattributed_claims_are_ignored(vault: Path) -> None:
    store = InMemoryCurateStore()
    seed(store, vault, {"s1": [
        status_claim(None, "done", "something is done"),
        {"type": "status_claim", "requirement_id": "R-B1", "claim": "no state", "evidence": "x" * 12},
        {"type": "requirement", "requirement_id": 7},
        {"type": "requirement", "requirement_id": "not an id"},
        {"type": "issue", "summary": "R-B2 is broken", "claim": "found"},
    ]})
    status = build(vault, store)
    assert [r.id for r in status.requirements] == ["R-A1", "R-A2", "R-B1", "R-B2"]
    b1 = by_id(status)["R-B1"]
    assert b1.state == "in progress" and b1.latest_claim is None  # a claim with no state is a mention
    assert by_id(status)["R-B2"].state == "not started"


def test_git_names_an_id_only_as_a_whole_token_and_in_a_pr_title(vault: Path) -> None:
    git = GitFacts(
        commits=(git_commit("d" * 40, "2026-09-02T00:00:00Z", "feat: R-B10 and XR-B1 are not R-B-1"),),
        prs=(git_pr(9, "wip R-B2", None),), warnings=())
    status = build(vault, InMemoryCurateStore(), git)
    assert by_id(status)["R-B1"].evidence == ()
    assert by_id(status)["R-B2"].state == "in progress"
    assert by_id(status)["R-B2"].evidence == (Evidence("pr", "9", "2026-09-01T00:00:00+00:00", "wip R-B2"),)


def test_a_commit_body_names_the_id_when_git_facts_carry_one(vault: Path) -> None:
    class BodyCommit:
        sha, date, subject, on_main, body = "e" * 40, "2026-09-02T00:00:00Z", "chore: tidy", True, "Closes R-B2."

    status = build(vault, InMemoryCurateStore(), GitFacts((BodyCommit(),), (), ()))
    assert by_id(status)["R-B2"].state == "in progress"


def test_ids_seen_only_in_git_do_not_join_the_requirements(vault: Path) -> None:
    git = GitFacts((git_commit("f" * 40, "2026-09-02T00:00:00Z", "fix: UTF-8 in R-Q9 handling"),), (), ())
    status = build(vault, InMemoryCurateStore(), git)
    assert [r.id for r in status.requirements] == ["R-A1", "R-A2", "R-B1", "R-B2"]


def test_a_requirement_in_two_documents_is_one_row_with_both_checkboxes(vault: Path) -> None:
    other = parse_plan("# Other\n\n### R-A2 Store again\n- [x] store shipped\n", "/repo/docs/other.md")
    status = build(vault, InMemoryCurateStore(), docs=(parse_plan(PLAN, "/repo/docs/plan.md"), other))
    a2 = by_id(status)["R-A2"]
    assert [r.id for r in status.requirements].count("R-A2") == 1
    assert a2.title == "Write the store" and a2.state == "claimed done"
    assert [e.ref for e in a2.evidence] == ["/repo/docs/other.md"]


def test_a_title_mismatch_across_documents_is_reported_as_a_collision(vault: Path) -> None:
    # Two unrelated plan documents can reuse the same id by coincidence (each letters its own
    # phases independently). The merge itself stays as it is -- id is the sole key, so this is
    # still one row -- but the mismatch must be visible, never silently dropped.
    other = parse_plan("# Other\n\n### R-A2 Store again\n- [x] store shipped\n", "/repo/docs/other.md")
    status = build(vault, InMemoryCurateStore(), docs=(parse_plan(PLAN, "/repo/docs/plan.md"), other))
    assert status.id_collisions == (
        RequirementIdCollision(
            id="R-A2", kept_source="/repo/docs/plan.md", kept_title="Write the store",
            other_source="/repo/docs/other.md", other_title="Store again",
        ),
    )
    a2 = by_id(status)["R-A2"]
    assert a2.title == "Write the store" and a2.state == "claimed done"
    assert [e.ref for e in a2.evidence] == ["/repo/docs/other.md"]


def test_a_requirement_repeated_with_the_same_title_is_not_a_collision(vault: Path) -> None:
    other = parse_plan("# Other\n\n### R-A2 Write the store\nMore detail.\n", "/repo/docs/other.md")
    status = build(vault, InMemoryCurateStore(), docs=(parse_plan(PLAN, "/repo/docs/plan.md"), other))
    assert status.id_collisions == ()


def test_plan_problems_and_sources_are_kept(vault: Path) -> None:
    problem = PlanSourceProblem("C:/gone/requirements.md", "not found")
    status = build(vault, InMemoryCurateStore(), docs=(parse_plan(PLAN, "/repo/docs/plan.md"), problem))
    assert status.problems == (problem,)
    assert status.sources == ("/repo/docs/plan.md",)


def test_no_plan_and_no_evidence_is_an_empty_status(vault: Path) -> None:
    status = build(vault, InMemoryCurateStore(), docs=())
    assert status.requirements == () and status.brief_items == ()
    assert status.counts == {state: 0 for state in STATES}


def test_the_status_is_deterministic(vault: Path) -> None:
    store = InMemoryCurateStore()
    seed(store, vault, {"s1": [requirement("R-Z9"), status_claim("R-A1", "done", "a")],
                        "s2": [requirement("R-Y1"), status_claim("R-A1", "done", "b")]})
    assert build(vault, store) == build(vault, store)


# -- briefs, the note index and open items --------------------------------------------------------


def test_brief_items_are_each_brief_checkbox_with_its_ticked_state(vault: Path) -> None:
    brief = parse_plan(BRIEF.read_text(encoding="utf-8"), BRIEF.as_posix())
    status = build(vault, InMemoryCurateStore(), docs=(brief,))
    assert [(b.brief_id, b.checked) for b in status.brief_items] == [
        ("PHASE7", True), ("PHASE7", True), ("PHASE7", False), ("PHASE7", False)]
    assert status.brief_items[0].title == "Phase 7 — retrieval polish"
    assert status.brief_items[2].text == ("Empty-result message in the chat panel, worded as an answer "
                                          "rather than an error")
    assert status.requirements == ()


def test_the_note_index_holds_every_dated_note(vault: Path) -> None:
    index = note_index(inventory(vault))
    assert index["session-s3"] == ("projects/demo/sessions/s3.md", "2026-09-03T10:00:00+00:00")
    assert "session-s4" not in index


def test_open_items_are_every_requirement_not_verified(vault: Path) -> None:
    store = InMemoryCurateStore()
    seed(store, vault, {"s1": [status_claim("R-A1", "done", "parser done")],
                        "s2": [status_claim("R-A2", "blocked", "waiting on the schema")]})
    git = GitFacts((git_commit("a" * 40, "2026-09-02T00:00:00Z", "feat: R-A1 parser"),), (), ())
    items = open_items(build(vault, store, git))
    assert items == ("R-A2 Write the store — waiting on the schema", "R-B1 Ship it", "R-B2 Nobody touched this")


def test_an_open_item_without_a_title_is_its_id(vault: Path) -> None:
    store = InMemoryCurateStore()
    seed(store, vault, {"s1": [requirement("R-Z9")]})
    assert open_items(build(vault, store, docs=())) == ("R-Z9",)
