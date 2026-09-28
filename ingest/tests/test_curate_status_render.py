"""Tests for status.md rendering (curate/status_render.py, R-C4 and SC-4).

Statuses are built by hand, so each test controls exactly what reaches the page.
"""

from __future__ import annotations

import re

from ingest.curate.plan import PlanSourceProblem
from ingest.curate.status import (
    STATES,
    BriefItem,
    Claim,
    CollectionStatus,
    Evidence,
    RequirementIdCollision,
    RequirementStatus,
)
from ingest.curate.status_render import status_body, status_frontmatter

NOTES = {"session-a": ("projects/demo/sessions/aaaa1111.md", "2026-09-01T10:00:00+00:00"),
         "session-b": ("projects/demo/sessions/bbbb2222.md", "2026-09-03T00:00:00+00:00")}
HOSTILE_CLAIM = "done | [[x]] <b>bold</b>"


def req(rid: str, state: str, *, title: str = "", phase: str | None = "Phase A — first", claim: Claim | None = None,
        evidence=(), in_plan: bool = True) -> RequirementStatus:
    return RequirementStatus(id=rid, title=title, phase=phase, state=state, latest_claim=claim,
                             evidence=tuple(evidence), done_when=None, in_plan=in_plan,
                             claims=(claim,) if claim else ())


def status(requirements=(), briefs=(), problems=(), sources=("docs/plan.md",), id_collisions=()) -> CollectionStatus:
    counts = {state: sum(1 for r in requirements if r.state == state) for state in STATES}
    return CollectionStatus(collection="demo", realm_folder="projects", folder="projects/demo",
                            requirements=tuple(requirements), brief_items=tuple(briefs), problems=tuple(problems),
                            counts=counts, sources=tuple(sources), notes=2, extracted=2,
                            id_collisions=tuple(id_collisions))


def full() -> CollectionStatus:
    broken = Claim("broken", "parser broke", "session-b", "2026-09-03T00:00:00+00:00")
    done = Claim("done", "store written", "session-a", "2026-09-01T10:00:00+00:00")
    return status(
        requirements=[
            req("R-A1", "contradicted", title="Build the parser", claim=broken, evidence=[
                Evidence("plan", "docs/plan.md", None, "parser written"),
                Evidence("note", "session-a", "2026-09-01T10:00:00+00:00", None),
                Evidence("note", "session-b", "2026-09-03T00:00:00+00:00", "parser broke")]),
            req("R-A2", "verified", title="Write the store", claim=done, evidence=[
                Evidence("note", "session-a", "2026-09-01T10:00:00+00:00", "store written"),
                Evidence("commit", "0123456789abcdef", "2026-09-02T00:00:00+00:00", "feat: R-A2", landed=True),
                Evidence("pr", "4", "2026-09-04T00:00:00+00:00", "R-A2 store", landed=True)]),
            req("R-B1", "in progress", title="Ship it", phase="Phase B — second", evidence=[
                Evidence("commit", "fedcba9876543210", "2026-09-02T00:00:00+00:00", "wip", landed=False),
                Evidence("pr", "9", "2026-09-01T00:00:00+00:00", "wip R-B1")]),
            req("R-B2", "not started", title="Nobody touched this", phase="Phase B — second"),
            req("R-A3", "claimed done", title="Back in phase A", claim=done,
                evidence=[Evidence("note", "session-a", "2026-09-01T10:00:00+00:00", "store written")]),
            req("R-Z9", "in progress", phase=None, in_plan=False,
                evidence=[Evidence("note", "gone-note", None, None)]),
        ],
        briefs=[BriefItem("PHASE7", "Phase 7 — polish", "Similarity floor", True),
                BriefItem("PHASE7", "Phase 7 — polish", "[ ] golden cases", False)],
        problems=[PlanSourceProblem("C:/gone/requirements.md", "not found")],
    )


def test_the_frontmatter_follows_sc4() -> None:
    assert status_frontmatter("projects", "wa2 final", "2026-09-27T04:30:00+00:00", "c2-v1+abcd1234") == {
        "id": "curator-status-projects-wa2-final",
        "title": "wa2 final status",
        "type": "status",
        "captured_by": "curator",
        "collection": "wa2 final",
        "generated_at": "2026-09-27T04:30:00+00:00",
        "extractor_version": "c2-v1+abcd1234",
    }


def test_the_body_puts_the_state_table_first_then_open_items_briefs_and_sources() -> None:
    body = status_body(full(), NOTES)
    lines = body.splitlines()
    assert lines[0] == "# demo status"
    assert lines[1] == ""
    assert lines[2].startswith("Written by the curator")
    assert lines[3] == "" and lines[4] == "## Phase A — first"
    headings = [line for line in lines if line.startswith("## ")]
    assert headings == ["## Phase A — first", "## Phase B — second", "## Not in the plan", "## Open items",
                        "## Briefs", "## Plan sources"]
    assert body.count("| Requirement | State | Latest claim | Evidence |") == 3
    assert body.endswith("\n") and not body.endswith("\n\n")


def test_requirements_are_grouped_by_phase_in_plan_order() -> None:
    body = status_body(full(), NOTES)
    phase_a = body.split("## Phase A — first", 1)[1].split("## Phase B", 1)[0]
    assert [row.split(" | ")[0] for row in phase_a.splitlines() if row.startswith("| R-")] == [
        "| R-A1 Build the parser", "| R-A2 Write the store", "| R-A3 Back in phase A"]


def test_the_table_rows() -> None:
    body = status_body(full(), NOTES)
    rows = {line.split(" ", 2)[1]: line for line in body.splitlines() if line.startswith("| R-")}
    assert rows["R-A1"] == ("| R-A1 Build the parser | contradicted | broken: parser broke "
                            "([[projects/demo/sessions/bbbb2222\\|2026-09-03]]) | plan ticked; 2 notes |")
    assert rows["R-A2"] == ("| R-A2 Write the store | verified | done: store written "
                            "([[projects/demo/sessions/aaaa1111\\|2026-09-01]]) | 1 note; commit 0123456; PR #4 |")
    assert rows["R-B1"] == "| R-B1 Ship it | in progress | — | commit fedcba9 (not on main); PR #9 (open) |"
    assert rows["R-B2"] == "| R-B2 Nobody touched this | not started | — | — |"
    assert rows["R-Z9"] == "| R-Z9 | in progress | — | 1 note |"


def test_open_items_list_every_unverified_requirement_most_urgent_first() -> None:
    body = status_body(full(), NOTES)
    section = body.split("## Open items", 1)[1].split("## Briefs", 1)[0]
    items = [line for line in section.splitlines() if line.startswith("- ")]
    assert items == [
        "- contradicted: R-A1 Build the parser — broken: parser broke "
        "([[projects/demo/sessions/bbbb2222|2026-09-03]])",
        "- claimed done: R-A3 Back in phase A — done: store written ([[projects/demo/sessions/aaaa1111|2026-09-01]])",
        "- in progress: R-B1 Ship it",
        "- in progress: R-Z9",
        "- not started: R-B2 Nobody touched this",
    ]


def test_briefs_are_plain_lines_never_live_checkboxes() -> None:
    body = status_body(full(), NOTES)
    section = body.split("## Briefs", 1)[1].split("## Plan sources", 1)[0]
    assert "### PHASE7 Phase 7 — polish" in section
    assert "- ticked: Similarity floor" in section
    assert "- not ticked: \\[ \\] golden cases" in section
    assert re.search(r"^\s*[-*+] \[[ xX]\]", body, re.MULTILINE) is None


def test_plan_sources_say_found_or_why_not() -> None:
    body = status_body(full(), NOTES)
    section = body.split("## Plan sources", 1)[1]
    assert "- docs/plan.md: found" in section
    assert "- C:/gone/requirements.md: not found" in section


def test_an_id_collision_is_visible_in_plan_sources() -> None:
    collision = RequirementIdCollision(id="R-C1", kept_source="docs/plan.md", kept_title="Inventory",
                                       other_source="docs/other.md", other_title="Line endings")
    body = status_body(status(id_collisions=[collision]), NOTES)
    section = body.split("## Plan sources", 1)[1]
    assert "R-C1" in section and "Inventory" in section and "Line endings" in section
    assert "docs/plan.md" in section and "docs/other.md" in section


def test_an_id_collision_title_is_escaped() -> None:
    collision = RequirementIdCollision(id="R-C1", kept_source="docs/plan.md", kept_title="<b>bold</b>",
                                       other_source="docs/other.md", other_title="[[x]]")
    body = status_body(status(id_collisions=[collision]), NOTES)
    assert "<b>" not in body and "[[x]]" not in body


def test_a_hostile_claim_is_escaped_in_the_table_and_the_open_items() -> None:
    claim = Claim("done", HOSTILE_CLAIM, "session-a", "2026-09-01T10:00:00+00:00")
    body = status_body(status([req("R-A1", "claimed done", title="T <i>", claim=claim)]), NOTES)
    row = next(line for line in body.splitlines() if line.startswith("| R-A1"))
    assert "done \\| \\[\\[x\\]\\] &lt;b&gt;bold&lt;/b&gt;" in row
    assert len(re.findall(r"(?<!\\)\|", row)) == 5  # four cells: the escaped pipes add no column
    assert "[[x]]" not in body and "<b>" not in body and "<i>" not in body
    open_line = next(line for line in body.splitlines() if line.startswith("- claimed done"))
    assert "\\[\\[x\\]\\]" in open_line


def test_untrusted_titles_commit_subjects_and_phases_are_escaped() -> None:
    requirement = req("R-A1", "in progress", title="# not a heading", phase="Phase <x> | y", evidence=[
        Evidence("commit", "not-a-sha|x", "2026-09-02T00:00:00+00:00", "[[evil]]", landed=True),
        Evidence("pr", "x|y", None, "t")])
    body = status_body(status([requirement]), NOTES)
    assert "## Phase &lt;x&gt; \\| y" in body
    assert "| R-A1 \\# not a heading |" in body
    assert "commit not-a-sha\\|x" in body and "PR x\\|y" in body


def test_a_note_without_an_index_entry_is_named_not_linked() -> None:
    claim = Claim("done", "ok", "gone-note", None)
    body = status_body(status([req("R-A1", "claimed done", claim=claim)]), NOTES)
    assert "done: ok (note gone-note)" in body


def test_many_commits_are_summarised() -> None:
    evidence = [Evidence("commit", f"{i:040x}", "2026-09-02T00:00:00+00:00", "s", landed=True) for i in range(5)]
    body = status_body(status([req("R-A1", "in progress", evidence=evidence)]), NOTES)
    assert "commit 0000000; commit 0000000; commit 0000000; +2 more commits" in body


def test_an_empty_status_says_so() -> None:
    body = status_body(status(sources=()), NOTES)
    assert "No requirements found in the plan sources or the notes." in body
    assert "## Open items" in body and "Nothing open." in body
    assert "## Briefs" not in body
    assert "No plan sources in the hub." in body


def test_the_body_is_deterministic_and_has_no_timestamps() -> None:
    first, second = status_body(full(), NOTES), status_body(full(), NOTES)
    assert first == second
    assert re.search(r"\d{2}:\d{2}", first) is None
