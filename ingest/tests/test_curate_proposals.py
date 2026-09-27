"""R-C6's condense and prune candidates and R-C7's no-loss verifier (curate/proposals.py).

Pure: a tmp vault read by the inventory, hand-built extractions, ledger members
and scores. No store, no judge, no git.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ingest.curate.inventory import build_inventory
from ingest.curate.proposals import (
    ACTION_CONDENSE,
    ACTION_PRUNE,
    SHORT_BODY_CHARS,
    Candidate,
    is_scratchpad,
    normalise,
    propose,
    verify_no_loss,
)
from ingest.curate.scores import CollectionScores
from ingest.curate.store_models import Extraction, NoteScore

EXTRACTOR = "c2-test+00000000"
LONG = "A long body. " * 60  # well over SHORT_BODY_CHARS

HUB = """---
id: 'hub-demo'
title: 'demo'
type: index
kind: project
---
# demo
"""

PARENT = "session-aaaa1111"
CHILD = "session-aaaa1111--agent1"
ORPHAN = "session-cccc3333--agent9"
SCRATCH = "note-scratch"
SHORT = "note-short"
KEEPER = "note-keeper"


def note(note_id: str, when: str, body: str, extra: str = "") -> str:
    return (f"---\nid: '{note_id}'\ntitle: 'Title of {note_id}'\ntype: session\ncollection: 'demo'\n"
            f"started_at: '{when}'\n{extra}---\n{body}\n")


@pytest.fixture
def inv(tmp_path: Path):
    root = tmp_path / "vault"
    demo = root / "projects" / "demo"
    (demo / "sessions").mkdir(parents=True)
    (demo / "notes").mkdir()
    (root / "projects" / ".realm").write_text("projects", encoding="utf-8")
    (demo / "demo.md").write_text(HUB, encoding="utf-8")
    files = {
        "sessions/aaaa1111.md": note(PARENT, "2026-09-20T10:00:00Z", LONG),
        "sessions/aaaa1111--agent1.md": note(CHILD, "2026-09-20T11:00:00Z", LONG, "parent_session: 'aaaa1111'\n"),
        "sessions/cccc3333--agent9.md": note(ORPHAN, "2026-09-21T11:00:00Z", LONG, "parent_session: 'cccc3333'\n"),
        "notes/scratch.md": note(SCRATCH, "2026-09-22T00:00:00Z", LONG,
                                 "cwd: 'C:\\Users\\estac\\AppData\\Local\\Temp\\claude\\x'\n"),
        "notes/short.md": note(SHORT, "2026-09-23T00:00:00Z", "Tiny."),
        "notes/keeper.md": note(KEEPER, "2026-09-24T00:00:00Z", LONG),
    }
    for relative, text in files.items():
        (demo / relative).write_text(text, encoding="utf-8")
    return build_inventory(root, git_collector=None).collections[0]


def record(inv, note_id: str):
    for group in inv.sessions:
        for item in (group.session, *group.subagents):
            if item.note_id == note_id:
                return item
    for group in inv.orphans:
        for item in group.subagents:
            if item.note_id == note_id:
                return item
    return next(item for item in (*inv.notes, *inv.decisions) if item.note_id == note_id)


def extraction(inv, note_id: str, items: list[dict]) -> Extraction:
    found = record(inv, note_id)
    return Extraction(note_id=note_id, content_hash=found.content_hash, extractor_version=EXTRACTOR,
                      collection="demo", note_path=found.path, result=tuple(items))


def scores(inv, **features: dict) -> CollectionScores:
    """Every note scored with all features zero, except those given per note id (underscored)."""
    notes = {}
    for note_id in (PARENT, CHILD, ORPHAN, SCRATCH, SHORT, KEEPER):
        given = features.get(note_id.replace("-", "_"), {})
        body = len(record(inv, note_id).body)
        values = {"commits": 0, "prs": 0, "decisions": 0, "issues_found": 0, "issues_fixed": 0,
                  "requirement_refs": 0, "citations": 0, "retrievals": 0, "used": 0, "children": 0,
                  "body_chars": body, "similarity": 0.0, "recency": 0.5, "open_issue": 0, **given}
        notes[note_id] = NoteScore(note_id=note_id, scorer_version="c6-test", run_day="2026-09-27",
                                   content_hash=record(inv, note_id).content_hash, collection="demo",
                                   impact=0.0, relevance=0.0, features=values)
    return CollectionScores(folder="projects/demo", collection="demo", notes=notes, written=0, already_scored=0,
                            would_ask=0, judge_calls=0, cached_importance=0, left=0, not_extracted=0, problems=())


def decision(summary: str) -> dict:
    return {"type": "decision", "summary": summary, "evidence": "e" * 12}


def issue(summary: str) -> dict:
    return {"type": "issue", "kind": "bug", "summary": summary, "evidence": "e" * 12, "files": [],
            "claim": "found", "fix_ref": None}


def requirement(rid: str) -> dict:
    return {"type": "requirement", "requirement_id": rid}


def claim(text: str, rid: str | None = "R-C6") -> dict:
    return {"type": "status_claim", "requirement_id": rid, "state": "done", "claim": text, "evidence": "e" * 12}


def question(text: str) -> dict:
    return {"type": "open_question", "question": text, "evidence": "e" * 12}


def everything_extracted(inv, **items: list[dict]) -> dict[str, Extraction]:
    return {note_id: extraction(inv, note_id, items.get(note_id.replace("-", "_"), []))
            for note_id in (PARENT, CHILD, ORPHAN, SCRATCH, SHORT, KEEPER)}


def the_child_with(inv, child_items: list[dict], parent_items: list[dict]):
    return everything_extracted(inv, **{PARENT.replace("-", "_"): parent_items,
                                        CHILD.replace("-", "_"): child_items})


def busy(inv) -> dict:
    """Features that keep the parent, the orphan and the keeper out of the prune list."""
    return {PARENT.replace("-", "_"): {"commits": 2, "children": 1},
            ORPHAN.replace("-", "_"): {"decisions": 1}, KEEPER.replace("-", "_"): {"retrievals": 3}}


def by_id(candidates) -> dict[str, Candidate]:
    return {c.note_id: c for c in candidates}


# -- condense -----------------------------------------------------------------------------------


def child_items() -> list[dict]:
    return [issue("the build broke"), decision("Use  Postgres,  not SQLite."), requirement("R-C6"),
            claim("R-C6 is done!"), question("What about Windows?")]


def parent_items() -> list[dict]:
    return [decision("use postgres not sqlite"), requirement("R-C6"), claim("r-c6 is done"),
            question("what about windows")]


def ledgered(inv, extractions: dict[str, Extraction], note_id: str, *indices: int) -> dict:
    e = extractions[note_id]
    return {(e.note_id, e.content_hash, e.extractor_version, index): "ISSUE-demo-001" for index in indices}


def test_a_subagent_fully_represented_is_a_condense_candidate(inv) -> None:
    extractions = the_child_with(inv, child_items(), parent_items())
    members = ledgered(inv, extractions, CHILD, 0)
    found = by_id(propose(inv, extractions, members, scores(inv, **busy(inv))))
    assert set(found) == {CHILD, SCRATCH, SHORT}
    child = found[CHILD]
    assert (child.action, child.collection, child.no_loss, child.path) == (
        ACTION_CONDENSE, "demo", True, "projects/demo/sessions/aaaa1111--agent1.md")
    assert child.reasons == (f"subagent of {PARENT}", "no commit or PR",
                             "every item represented in the parent or ledger (5 items)")


def test_a_subagent_with_no_items_is_condensed(inv) -> None:
    extractions = the_child_with(inv, [], [])
    found = by_id(propose(inv, extractions, {}, scores(inv, **busy(inv))))
    assert found[CHILD].action == ACTION_CONDENSE and found[CHILD].no_loss


def test_a_subagent_with_a_commit_is_not_condensed(inv) -> None:
    extractions = the_child_with(inv, [], [])
    features = {**busy(inv), CHILD.replace("-", "_"): {"commits": 1}}
    assert CHILD not in by_id(propose(inv, extractions, {}, scores(inv, **features)))


def test_a_subagent_with_a_pr_is_not_condensed(inv) -> None:
    extractions = the_child_with(inv, [], [])
    features = {**busy(inv), CHILD.replace("-", "_"): {"prs": 1}}
    assert CHILD not in by_id(propose(inv, extractions, {}, scores(inv, **features)))


def test_an_issue_not_in_the_ledger_blocks_condense(inv) -> None:
    extractions = the_child_with(inv, child_items(), parent_items())
    assert CHILD not in by_id(propose(inv, extractions, {}, scores(inv, **busy(inv))))


def test_a_decision_missing_from_the_parent_blocks_condense(inv) -> None:
    extractions = the_child_with(inv, child_items(), [p for p in parent_items() if p["type"] != "decision"])
    members = ledgered(inv, extractions, CHILD, 0)
    assert CHILD not in by_id(propose(inv, extractions, members, scores(inv, **busy(inv))))


def test_a_requirement_id_missing_from_the_parent_blocks_condense(inv) -> None:
    extractions = the_child_with(inv, [requirement("R-C7")], parent_items())
    assert CHILD not in by_id(propose(inv, extractions, {}, scores(inv, **busy(inv))))


def test_an_orphan_subagent_is_never_condensed(inv) -> None:
    extractions = everything_extracted(inv)
    found = by_id(propose(inv, extractions, {}, scores(inv, **{**busy(inv), ORPHAN.replace("-", "_"): {}})))
    assert ORPHAN not in found  # quiet and empty, but it has no parent to be condensed into


def test_a_note_not_extracted_yet_is_never_a_candidate(inv) -> None:
    extractions = everything_extracted(inv)
    del extractions[CHILD], extractions[SHORT]
    found = by_id(propose(inv, extractions, {}, scores(inv, **busy(inv))))
    assert CHILD not in found and SHORT not in found


# -- prune --------------------------------------------------------------------------------------


def test_prune_by_scratchpad_cwd_and_by_short_body(inv) -> None:
    found = by_id(propose(inv, everything_extracted(inv), {}, scores(inv, **busy(inv))))
    scratch, short = found[SCRATCH], found[SHORT]
    assert scratch.action == short.action == ACTION_PRUNE
    assert scratch.reasons == ("no commit, PR, decision, issue, citation or retrieval", "scratchpad cwd")
    assert short.reasons == ("no commit, PR, decision, issue, citation or retrieval",
                             f"body {len(record(inv, SHORT).body)} chars")
    assert scratch.no_loss and short.no_loss
    assert KEEPER not in found  # quiet, long, not in a scratchpad


@pytest.mark.parametrize("feature", ["commits", "prs", "decisions", "issues_found", "issues_fixed",
                                     "requirement_refs", "citations", "retrievals", "used", "children"])
def test_any_non_zero_impact_feature_blocks_prune(inv, feature: str) -> None:
    features = {**busy(inv), SHORT.replace("-", "_"): {feature: 1}}
    assert SHORT not in by_id(propose(inv, everything_extracted(inv), {}, scores(inv, **features)))


def test_prune_no_loss_is_false_when_the_note_has_items(inv) -> None:
    extractions = everything_extracted(inv, **{SHORT.replace("-", "_"): [question("why?"), claim("started")]})
    found = by_id(propose(inv, extractions, {}, scores(inv, **busy(inv))))
    assert found[SHORT].no_loss is False
    assert "2 extracted items" in found[SHORT].reasons


def test_a_note_is_never_both(inv) -> None:
    # The child is quiet and in a short body too: condense wins.
    extractions = the_child_with(inv, [], [])
    found = propose(inv, extractions, {}, scores(inv, **busy(inv)))
    assert [c.action for c in found if c.note_id == CHILD] == [ACTION_CONDENSE]
    assert len({c.note_id for c in found}) == len(found)


def test_candidates_come_sorted_by_note_id(inv) -> None:
    found = propose(inv, everything_extracted(inv), {}, scores(inv))
    assert [c.note_id for c in found] == sorted(c.note_id for c in found)


@pytest.mark.parametrize("cwd, expected", [
    ("C:\\Users\\estac\\AppData\\Local\\Temp\\claude\\abc", True),
    ("C:/Users/estac/appdata/local/temp/CLAUDE/abc", True),
    ("/home/u/.claude/projects/-home-u-x", True),
    ("C:\\Users\\estac\\.claude\\projects\\C--x", True),
    ("C:/Users/estac/Documents/agentic-harness", False),
    ("/home/u/.claude/settings", False),
    (None, False),
])
def test_is_scratchpad(cwd: str | None, expected: bool) -> None:
    assert is_scratchpad(cwd) is expected


def test_short_body_threshold() -> None:
    assert SHORT_BODY_CHARS == 400


# -- the verifier -------------------------------------------------------------------------------


def test_normalise() -> None:
    assert normalise("  Use  Postgres,\n not SQLite!  ") == "use postgres not sqlite"


def test_verify_no_loss_accepts_what_the_parent_holds() -> None:
    assert verify_no_loss(child_items()[1:], parent_items())
    assert verify_no_loss([], [])


def test_verify_no_loss_needs_the_same_type() -> None:
    assert not verify_no_loss([question("use postgres not sqlite")], [decision("use postgres not sqlite")])


def test_verify_no_loss_counts_ledgered_issues_only() -> None:
    items = [issue("the build broke")]
    assert not verify_no_loss(items, [issue("the build broke")])
    assert verify_no_loss(items, [], ledgered={0})


def test_verify_no_loss_needs_a_status_claims_requirement_id() -> None:
    assert not verify_no_loss([claim("done", rid="R-C9")], [claim("done", rid=None)])
    assert verify_no_loss([claim("done", rid="R-C9")], [claim("done", rid=None), requirement("R-C9")])


def test_verify_no_loss_refuses_an_unknown_item_type() -> None:
    assert not verify_no_loss([{"type": "novel", "summary": "x"}], [{"type": "novel", "summary": "x"}])
