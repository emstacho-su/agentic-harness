"""Tests for curate/plan.py (R-C4): the plan-document parser and plan-source loader.

The two real requirement documents in ``docs/`` are the format R-C4's parser is
tested against (Phase C, *Curator safety*); ``tests/fixtures/plans`` holds a
numbered phase brief in bb2dash's ``docs/planning/`` style, which has no
requirement-id headings at all.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from ingest.curate.extract_schema import requirement_in_body
from ingest.curate.plan import (
    PlanBrief,
    PlanCheckbox,
    PlanDocument,
    PlanSourceProblem,
    load_plan_sources,
    parse_plan,
    requirement_ids_in,
)
from ingest.curate.profile import build_profile

DOCS = Path(__file__).resolve().parents[2] / "docs"
MEMORY_SPRINT = DOCS / "memory-sprint-requirements.md"
VAULT_MIGRATION = DOCS / "vault-migration-requirements.md"
BRIEF = Path(__file__).parent / "fixtures" / "plans" / "50_PHASE7_retrieval_polish.md"

PHASE_N = "Phase N — names a person can read"
PHASE_H = "Phase H — the harness's own realm"
PHASE_P = "Phase P — retrieval provenance"
PHASE_Q = "Phase Q — is RAG correct, and is it used"
PHASE_C = "Phase C — the curator, read-only"

MEMORY_SPRINT_REQUIREMENTS = [
    ("R-N1", "Hub notes are named after their folder", PHASE_N),
    ("R-N2", "Subagent links resolve and never create stray notes", PHASE_N),
    ("R-N3", "Session titles that say something, shown in the graph", PHASE_N),
    ("R-H1", "A `harness` realm", PHASE_H),
    ("R-H2", "Harness sessions are routed there from wherever they start", PHASE_H),
    ("R-H3", "The existing harness history moves, and the store follows", PHASE_H),
    ("R-H4", "A harness session starts knowing where the project is", PHASE_H),
    ("R-H5", "`~/.claude` travels too", PHASE_H),
    ("R-H6", "One command brings up a machine", PHASE_H),
    ("R-P1", "Every retrieval is captured from the transcript", PHASE_P),
    ("R-P2", "Stored markdown-first, projected into the store", PHASE_P),
    ("R-P3", "Visible", PHASE_P),
    ("R-Q1", "`uv run ingest verify` audits the store", PHASE_Q),
    ("R-Q2", "Boilerplate noise: measured, then fixed behind the eval", PHASE_Q),
    ("R-Q3", "Every collection is covered by the golden set", PHASE_Q),
    ("R-Q4", "The location matrix", PHASE_Q),
    ("R-Q5", '"Used properly" is a number', PHASE_Q),
    ("R-C1", "Inventory and timeline", PHASE_C),
    ("R-C2", "Extraction, cached and checked", PHASE_C),
    ("R-C3", "The issue ledger, bi-temporal", PHASE_C),
    ("R-C4", "Status against the plan", PHASE_C),
    ("R-C5", "A readable history", PHASE_C),
    ("R-C6", "Scores and proposals, no action", PHASE_C),
    ("R-C7", "The road to fully automatic", PHASE_C),
]

VAULT_MIGRATION_IDS = [
    "R-A1", "R-A2", "R-A3", "R-A4", "R-B1", "R-B2", "R-B3", "R-B4", "R-C1", "R-C2", "R-C3", "R-C4",
    "R-D1", "R-D2", "R-D3", "R-E1", "R-E2", "R-E3", "R-F1", "R-F2",
]


@pytest.fixture(scope="module")
def sprint() -> PlanDocument:
    return parse_plan(MEMORY_SPRINT.read_text(encoding="utf-8"), MEMORY_SPRINT.as_posix())


@pytest.fixture(scope="module")
def migration() -> PlanDocument:
    return parse_plan(VAULT_MIGRATION.read_text(encoding="utf-8"), VAULT_MIGRATION.as_posix())


def by_id(document: PlanDocument, requirement_id: str):
    return next(r for r in document.requirements if r.id == requirement_id)


# -- the memory sprint document ----------------------------------------------------------


def test_memory_sprint_requirements_in_document_order_with_titles_and_phases(sprint: PlanDocument) -> None:
    assert [(r.id, r.title, r.phase) for r in sprint.requirements] == MEMORY_SPRINT_REQUIREMENTS
    assert {r.level for r in sprint.requirements} == {3}
    assert sprint.title == "Memory sprint: requirements, tests and definitions of done"
    assert sprint.brief is None
    assert sprint.source == MEMORY_SPRINT.as_posix()


def test_memory_sprint_requirement_lines_point_at_their_headings(sprint: PlanDocument) -> None:
    lines = MEMORY_SPRINT.read_text(encoding="utf-8").split("\n")
    for requirement in sprint.requirements:
        assert lines[requirement.line - 1].startswith(f"### {requirement.id} ")


def test_memory_sprint_phase_table(sprint: PlanDocument) -> None:
    assert [phase.name.split()[0] for phase in sprint.phases] == ["N", "H", "P", "Q", "C", "G"]
    first = sprint.phases[0]
    assert first.name == "N — names a person can read"
    assert first.cells == {
        "Phase": "N — names a person can read",
        "Asks": "2",
        "PRs": "1",
        "Why this order": "Smallest; touches the link code H also touches",
    }
    assert sprint.phases[3].cells["PRs"] == "1–2"
    lines = MEMORY_SPRINT.read_text(encoding="utf-8").split("\n")
    assert lines[first.line - 1].startswith("| N — names")


def test_memory_sprint_done_when_and_tests(sprint: PlanDocument) -> None:
    c4 = by_id(sprint, "R-C4")
    assert c4.done_when is not None and "signs off" in c4.done_when
    assert c4.tests == (
        "Unit: parsers against this file and `vault-migration-requirements.md`. Pilot: Stack "
        "reviews `status.md` for `agentic-harness`."
    )
    n1 = by_id(sprint, "R-N1")
    # A continuation line joins with one space; the bullet ends at the blank line.
    assert n1.done_when.startswith("`Get-ChildItem C:\\Users\\estac\\vault -Recurse -Filter index.md` is empty; a link check")
    assert n1.done_when.endswith("golden case `ist323-index` still hits.")
    assert "\n" not in n1.done_when
    assert all(r.done_when for r in sprint.requirements)


def test_the_phase_p_record_checkboxes_belong_to_no_requirement(sprint: PlanDocument) -> None:
    assert len(sprint.checkboxes) == 6
    assert all(box.requirement_id is None and not box.checked for box in sprint.checkboxes)
    assert sprint.checkboxes[0].text == "MANUAL: check in Obsidian's graph that `retrieved:` draws session → note edges."
    assert sprint.checkboxes[4].text == (
        "Deferred from review: stale events for an unchanged note whose `retrievals:` is removed by "
        "hand; a projection error after the document commit marks it FAILED."
    )
    assert by_id(sprint, "R-P3").checkboxes == ()


# -- the vault migration document --------------------------------------------------------


def test_vault_migration_requirements_each_with_done_when(migration: PlanDocument) -> None:
    assert [r.id for r in migration.requirements] == VAULT_MIGRATION_IDS
    first = migration.requirements[0]
    assert (first.title, first.phase) == (
        "Line endings are the repo's policy, not each machine's",
        "Phase A — the repo hygiene that has to exist before the first commit",
    )
    assert all(r.done_when for r in migration.requirements)
    assert by_id(migration, "R-F1").done_when == "The script exits 0 and its output is attached to the migration PR."
    assert by_id(migration, "R-C4").phase == "Phase C — the relocation itself"


def test_vault_migration_order_and_gates_table(migration: PlanDocument) -> None:
    assert [phase.name for phase in migration.phases] == ["A", "B", "C", "D", "E", "F"]
    assert set(migration.phases[0].cells) == {"Phase", "Blocks", "Gate"}
    assert migration.phases[0].cells["Gate"] == "R-A1–A4 done in code and tests, on `main`"
    assert migration.phases[-1].cells == {"Phase": "F", "Blocks": "—", "Gate": "R-F1 script exit 0; R-F2 after 21 days"}
    assert migration.checkboxes == ()


# -- headings, sections and fields -------------------------------------------------------


def test_heading_levels_and_the_nearest_enclosing_heading_is_the_phase() -> None:
    text = (
        "# Plan\n\n## Part one\n\n### R-X1 Three deep\n\n#### R-X2 Four deep\n\n"
        "## R-X3 Two deep\n\n## Part two\n\n#### R-X4 Skips a level\n"
    )
    document = parse_plan(text, "plan.md")
    assert [(r.id, r.level, r.phase, r.line) for r in document.requirements] == [
        ("R-X1", 3, "Part one", 5),
        ("R-X2", 4, "R-X1 Three deep", 7),
        ("R-X3", 2, None, 9),
        ("R-X4", 4, "Part two", 13),
    ]


def test_the_document_title_is_not_a_phase_and_falls_back_to_the_filename() -> None:
    assert parse_plan("# Plan\n\n### R-X1 Alone\n", "p.md").requirements[0].phase is None
    assert parse_plan("## Sub\n\nno h1\n", "C:/docs/plan-notes.md").title == "plan-notes"


def test_an_id_that_is_not_the_first_token_is_not_a_requirement() -> None:
    text = "# Plan\n\n### See R-X1 for this\n\n### `R-X2` quoted\n\n### R-X3\n\n### R-X4: colon\n"
    document = parse_plan(text, "plan.md")
    assert [(r.id, r.title) for r in document.requirements] == [("R-X3", "")]


def test_headings_and_checkboxes_inside_a_code_fence_are_ignored() -> None:
    text = "# Plan\n\n```md\n### R-X1 Not real\n- [ ] not real\n| Phase | x |\n| --- | --- |\n| A | b |\n```\n"
    document = parse_plan(text, "plan.md")
    assert (document.requirements, document.checkboxes, document.phases) == ((), (), ())


def test_fields_are_read_from_the_requirement_section_only() -> None:
    text = (
        "# Plan\n\n### R-X1 First\n- **Requirement.** Do it.\n- **Tests.** Unit.\n\n"
        "### R-X2 Second\n- **Done when.** it\n  is done.\n- **Why.** Because.\n\n"
        "## Notes\n- **Done when.** not a requirement's\n"
    )
    document = parse_plan(text, "plan.md")
    first, second = document.requirements
    assert (first.done_when, first.tests) == (None, "Unit.")
    assert (second.done_when, second.tests) == ("it is done.", None)


def test_a_field_label_may_close_with_a_colon() -> None:
    document = parse_plan("### R-X1 A\n- **Done when:** shipped\n", "plan.md")
    assert document.requirements[0].done_when == "shipped"


# -- tables ------------------------------------------------------------------------------


def test_a_table_without_a_phase_header_is_ignored_and_the_header_is_case_insensitive() -> None:
    text = (
        "| Lever | Trigger |\n| --- | --- |\n| a | b |\n\n"
        "| PHASE | Gate |\n|:---|---:|\n| A | one \\| two |\n| B |\n\nafter\n"
    )
    document = parse_plan(text, "plan.md")
    assert [(p.name, p.cells, p.line) for p in document.phases] == [
        ("A", {"PHASE": "A", "Gate": "one | two"}, 7),
        ("B", {"PHASE": "B", "Gate": ""}, 8),
    ]


def test_a_phase_header_without_a_divider_row_is_not_a_table() -> None:
    assert parse_plan("| Phase | Gate |\n| A | b |\n", "plan.md").phases == ()


# -- checkboxes --------------------------------------------------------------------------


def test_checkboxes_are_attributed_to_the_requirement_section_they_sit_in() -> None:
    text = (
        "# Plan\n\n- [x] before any requirement\n\n### R-X1 One\n- [ ] first\n* [X] second\n\n"
        "#### Detail\n  - [ ] nested under a sub-heading\n\n### Log\n- [ ] after the section\n"
    )
    document = parse_plan(text, "plan.md")
    assert document.checkboxes == (
        PlanCheckbox("before any requirement", True, 3, None),
        PlanCheckbox("first", False, 6, "R-X1"),
        PlanCheckbox("second", True, 7, "R-X1"),
        PlanCheckbox("nested under a sub-heading", False, 10, "R-X1"),
        PlanCheckbox("after the section", False, 13, None),
    )
    assert document.requirements[0].checkboxes == document.checkboxes[1:4]


def test_a_malformed_box_is_not_a_checkbox() -> None:
    assert parse_plan("- [] no\n- [y] no\n-[ ] no\n- [ ]\n", "plan.md").checkboxes == ()


def test_crlf_input_gives_the_same_document_as_lf() -> None:
    text = "# Plan\n\n| Phase | Gate |\n| --- | --- |\n| A | b |\n\n### R-X1 One\n- **Done when.** a\n  b\n- [x] box\n"
    assert parse_plan(text.replace("\n", "\r\n"), "plan.md") == parse_plan(text, "plan.md")
    assert parse_plan(text.replace("\n", "\r"), "plan.md") == parse_plan(text, "plan.md")


# -- numbered phase briefs ---------------------------------------------------------------


def test_a_numbered_phase_brief_gets_its_id_from_the_filename() -> None:
    document = parse_plan(BRIEF.read_text(encoding="utf-8"), BRIEF.as_posix())
    assert document.requirements == ()
    assert document.brief == PlanBrief("PHASE7", "Phase 7 — retrieval polish")
    assert [(b.text, b.checked, b.requirement_id) for b in document.checkboxes] == [
        ("Similarity floor at 0.70 on the vector arm", True, "PHASE7"),
        ("Per-document cap of three chunks", True, "PHASE7"),
        ("Empty-result message in the chat panel, worded as an answer rather than an error", False, "PHASE7"),
        ("Golden cases for every course", False, "PHASE7"),
    ]
    assert document.phases == ()  # its table has no Phase header


@pytest.mark.parametrize(
    ("source", "brief_id"),
    [
        ("docs/planning/50_PHASE7_retrieval_polish.md", "PHASE7"),
        ("C:\\repo\\docs\\planning\\10_phase2_setup.md", "PHASE2"),
        ("docs/planning/PHASE12.md", "PHASE12"),
        ("docs/planning/syllabus.md", "syllabus"),
        ("docs/planning/50_PHASED_rollout.md", "50_PHASED_rollout"),
    ],
)
def test_brief_ids(source: str, brief_id: str) -> None:
    assert parse_plan("# T\n- [ ] x\n", source).brief.id == brief_id


def test_a_document_with_requirements_has_no_brief() -> None:
    assert parse_plan("### R-X1 A\n", "50_PHASE7_x.md").brief is None


# -- requirement ids in free text --------------------------------------------------------


def test_requirement_ids_in_are_whole_tokens_distinct_and_in_order() -> None:
    text = "R-C4 needs R-C2, not R-C23 or xR-C1 or R-C5-; see R-C2 again and R-N1..R-N3 (`R-H4`)."
    found = requirement_ids_in(text)
    assert found == ("R-C4", "R-C2", "R-C23", "R-N1", "R-N3", "R-H4")
    assert "R-C1" not in found and "R-C5" not in found
    assert all(requirement_in_body(requirement_id, text) for requirement_id in found)


def test_requirement_ids_in_agrees_with_requirement_in_body() -> None:
    text = MEMORY_SPRINT.read_text(encoding="utf-8")
    for requirement_id, _, _ in MEMORY_SPRINT_REQUIREMENTS:
        assert requirement_id in requirement_ids_in(text)
    assert not requirement_in_body("R-C2", "R-C23") and requirement_ids_in("R-C23") == ("R-C23",)
    assert requirement_ids_in("") == ()


# -- loading plan sources ----------------------------------------------------------------


def _profile(vault: Path, sources: list[str]):
    collection = vault / "projects" / "coll"
    collection.mkdir(parents=True, exist_ok=True)
    listed = "".join(f"  - '{source}'\n" for source in sources)
    (collection / "coll.md").write_text(f"---\ntype: index\nplan_sources:\n{listed}---\n", encoding="utf-8")
    return build_profile(
        vault=vault, realm="projects", realm_folder="projects", collection="coll",
        collection_dir=collection, hints=(), runner=lambda args, cwd=None: "",
    )


def test_load_plan_sources_reads_files_and_expands_directories_sorted(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    planning = tmp_path / "repo" / "docs" / "planning"
    planning.mkdir(parents=True)
    (planning / "50_PHASE7_polish.md").write_bytes(b"# Seven\r\n- [x] done\r\n")
    (planning / "10_PHASE2_setup.md").write_text("# Two\n- [ ] todo\n", encoding="utf-8")
    (planning / "notes.txt").write_text("not a plan", encoding="utf-8")
    (planning / "nested").mkdir()
    (planning / "nested" / "deep.md").write_text("# Deep\n", encoding="utf-8")
    requirements = tmp_path / "repo" / "docs" / "requirements.md"
    requirements.write_text("# Reqs\n\n### R-X1 One\n", encoding="utf-8")

    profile = _profile(vault, [requirements.as_posix(), planning.as_posix(), (tmp_path / "gone.md").as_posix()])
    loaded = load_plan_sources(profile)

    assert [type(item).__name__ for item in loaded] == ["PlanDocument"] * 3 + ["PlanSourceProblem"]
    assert [item.source for item in loaded[:3]] == [
        requirements.as_posix(), (planning / "10_PHASE2_setup.md").as_posix(), (planning / "50_PHASE7_polish.md").as_posix(),
    ]
    assert [r.id for r in loaded[0].requirements] == ["R-X1"]
    assert (loaded[1].brief.id, loaded[2].brief.id) == ("PHASE2", "PHASE7")
    assert loaded[2].checkboxes == (PlanCheckbox("done", True, 2, "PHASE7"),)
    assert loaded[3] == PlanSourceProblem((tmp_path / "gone.md").as_posix(), "not found")


def test_a_vault_note_plan_source_is_read(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    (vault / "projects" / "coll").mkdir(parents=True)
    (vault / "projects" / "coll" / "plan.md").write_text("# Plan\n### R-X1 One\n", encoding="utf-8")
    (document,) = load_plan_sources(_profile(vault, ["projects/coll/plan"]))
    assert isinstance(document, PlanDocument) and [r.id for r in document.requirements] == ["R-X1"]


def test_an_unreadable_or_non_utf8_source_is_a_problem_not_a_crash(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    latin = tmp_path / "latin.md"
    latin.write_bytes("# Caf\u00e9\n".encode("latin-1"))
    profile = _profile(vault, [latin.as_posix()])
    (problem,) = load_plan_sources(profile)
    assert problem == PlanSourceProblem(latin.as_posix(), "not UTF-8")
    latin.unlink()  # gone between profile and load
    (problem,) = load_plan_sources(profile)
    assert problem.given == latin.as_posix() and problem.reason.startswith("unreadable")


def test_an_empty_directory_is_a_problem(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    (problem,) = load_plan_sources(_profile(tmp_path / "vault", [empty.as_posix()]))
    assert problem == PlanSourceProblem(empty.as_posix(), "no .md files in the directory")


def test_a_directory_entry_that_leads_outside_it_is_refused(tmp_path: Path) -> None:
    planning = tmp_path / "planning"
    planning.mkdir()
    secret = tmp_path / "elsewhere.md"
    secret.write_text("# Elsewhere\n### R-X9 Leak\n", encoding="utf-8")
    (planning / "10_PHASE1_a.md").write_text("# One\n", encoding="utf-8")
    try:
        os.symlink(secret, planning / "20_PHASE2_link.md")
    except (OSError, NotImplementedError):
        pytest.skip("symlinks are not available here")
    loaded = load_plan_sources(_profile(tmp_path / "vault", [planning.as_posix()]))
    assert isinstance(loaded[0], PlanDocument)
    assert loaded[1] == PlanSourceProblem(planning.as_posix(), "20_PHASE2_link.md: leads outside the directory")


def test_a_profile_without_plan_sources_loads_nothing(tmp_path: Path) -> None:
    assert load_plan_sources(_profile(tmp_path / "vault", [])) == ()
