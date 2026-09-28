"""Tests for curate/profile.py and curate/inventory.py (R-C1), on the fixture vault.

``tests/fixtures/curate_vault`` holds two realms: ``projects`` with ``demo``
(a hub with kind, two main sessions with subagents, an orphan subagent, an
``sdk-py`` note, a curator note, notes/, decisions/, materials/, templates/ and a
file without frontmatter) and ``nokind`` (a hub without kind), and ``classes``
with ``ist999`` plus an ``attachments`` folder that is not a collection. Tests
that change the vault copy it to ``tmp_path`` first.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Sequence

import pytest

from ingest.curate.inventory import (
    ROLE_DECISION,
    ROLE_NOTE,
    ROLE_SESSION,
    ROLE_SUBAGENT,
    build_inventory,
)
from ingest.curate.profile import (
    KIND_CLASS,
    KIND_PROJECT,
    SessionHint,
    build_profile,
    check_collection_name,
)
from ingest.errors import ConfigError, SourceError
from ingest.hashing import content_hash

FIXTURE = Path(__file__).parent / "fixtures" / "curate_vault"


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    """A private copy, so a test may add or break files."""
    target = tmp_path / "vault"
    shutil.copytree(FIXTURE, target)
    return target


def by_name(result, collection: str):
    return next(inv for inv in result.collections if inv.profile.collection == collection)


def paths(records) -> list[str]:
    return [record.path for record in records]


class FakeCollector:
    """Stands in for gitfacts.collect_git_facts; records every call."""

    def __init__(self, result: object = "facts", error: Exception | None = None) -> None:
        self.calls: list[tuple[Path | None, str | None]] = []
        self._result = result
        self._error = error

    def __call__(self, repo_path: Path | None, repo_slug: str | None) -> object:
        self.calls.append((repo_path, repo_slug))
        if self._error is not None:
            raise self._error
        return self._result


class FakeRunner:
    """Answers ``git -C <dir> rev-parse --show-toplevel`` from a map of dir -> toplevel."""

    def __init__(self, toplevels: dict[str, str]) -> None:
        self.toplevels = toplevels
        self.calls: list[list[str]] = []

    def __call__(self, args: Sequence[str], cwd: Path | None = None) -> str:
        self.calls.append(list(args))
        directory = args[2]
        if directory not in self.toplevels:
            raise SourceError(f"not a git repository: {directory}")
        return self.toplevels[directory] + "\n"


# -- timeline ----------------------------------------------------------------------------


def test_sessions_are_in_date_order_with_subagents_nested_in_date_order() -> None:
    demo = by_name(build_inventory(FIXTURE), "demo")
    timeline = [(group.session.path, paths(group.subagents)) for group in demo.sessions]
    assert timeline == [
        (
            "projects/demo/sessions/bbbb2222.md",
            ["projects/demo/sessions/bbbb2222--agent9.md", "projects/demo/sessions/bbbb2222--agent2.md"],
        ),
        ("projects/demo/sessions/aaaa1111.md", ["projects/demo/sessions/aaaa1111--agent1.md"]),
        ("projects/demo/sessions/dddd4444.md", []),
    ]


def test_a_subagent_whose_parent_is_missing_is_an_orphan_group_not_dropped() -> None:
    demo = by_name(build_inventory(FIXTURE), "demo")
    assert [(g.parent_session_id, paths(g.subagents)) for g in demo.orphans] == [
        ("cccc3333", ["projects/demo/sessions/cccc3333--agent3.md"])
    ]


def test_sdk_review_worker_notes_are_included() -> None:
    demo = by_name(build_inventory(FIXTURE), "demo")
    sdk = [group.session for group in demo.sessions if group.session.origin == "sdk-py"]
    assert paths(sdk) == ["projects/demo/sessions/dddd4444.md"]
    assert demo.counts.sdk_notes == 1


def test_roles_are_set_by_folder_and_filename() -> None:
    demo = by_name(build_inventory(FIXTURE), "demo")
    assert {group.session.role for group in demo.sessions} == {ROLE_SESSION}
    subagents = [s for g in demo.sessions for s in g.subagents] + [s for g in demo.orphans for s in g.subagents]
    assert {s.role for s in subagents} == {ROLE_SUBAGENT}
    assert [(n.path, n.role) for n in demo.notes] == [("projects/demo/notes/plan.md", ROLE_NOTE)]
    assert [(d.path, d.role) for d in demo.decisions] == [("projects/demo/decisions/use-postgres.md", ROLE_DECISION)]


def test_hub_curator_materials_and_templates_are_excluded_with_reasons() -> None:
    demo = by_name(build_inventory(FIXTURE), "demo")
    every = [g.session.path for g in demo.sessions] + paths(demo.notes) + paths(demo.decisions)
    assert "projects/demo/demo.md" not in every
    assert "projects/demo/status.md" not in every
    assert {(s.path, s.reason) for s in demo.excluded} == {
        ("projects/demo/status.md", "curator-written note (captured_by: curator)"),
        ("projects/demo/materials/brief.md", "under materials/"),
        ("projects/demo/templates/tpl.md", "under templates/"),
    }
    assert demo.counts.excluded == 3


def test_a_file_without_frontmatter_is_skipped_with_a_reason() -> None:
    demo = by_name(build_inventory(FIXTURE), "demo")
    assert [(s.path, s.reason) for s in demo.skipped] == [("projects/demo/notes/scratch.md", "no frontmatter")]
    assert demo.counts.skipped == 1


def test_malformed_frontmatter_is_skipped_not_fatal(vault: Path) -> None:
    (vault / "projects/demo/notes/bad.md").write_text("---\nkey: [unclosed\n---\nbody\n", encoding="utf-8")
    demo = by_name(build_inventory(vault), "demo")
    reasons = {s.path: s.reason for s in demo.skipped}
    assert reasons["projects/demo/notes/bad.md"].startswith("malformed YAML frontmatter")


# -- records -----------------------------------------------------------------------------


def test_record_fields_come_from_frontmatter_with_fallbacks() -> None:
    demo = by_name(build_inventory(FIXTURE), "demo")
    first, second = demo.sessions[0].session, demo.sessions[1].session
    # No id, no started_at, no title: path, date and H1 stand in.
    assert first.note_id == "projects/demo/sessions/bbbb2222.md"
    assert first.date == "2026-09-01"
    assert first.title == "First day main"
    assert (first.realm, first.collection) == ("projects", "demo")
    assert (first.session_id, first.parent_session_id) == ("bbbb2222", None)
    assert second.note_id == "session-aaaa1111"
    assert second.date == "2026-09-02T10:00:00Z"
    assert second.title == "Second day main"
    assert (second.origin, second.captured_by) == ("cli", "hook")


def test_a_subagent_parent_comes_from_the_filename_when_frontmatter_lacks_it() -> None:
    demo = by_name(build_inventory(FIXTURE), "demo")
    later = demo.sessions[0].subagents[1]
    assert later.path.endswith("bbbb2222--agent2.md")
    assert (later.session_id, later.parent_session_id) == ("bbbb2222", "bbbb2222")


def test_body_is_below_the_frontmatter_with_lf_line_ends_and_hashed(vault: Path) -> None:
    note = vault / "projects/demo/sessions/aaaa1111.md"
    note.write_bytes(note.read_bytes().replace(b"\n", b"\r\n"))
    record = by_name(build_inventory(vault), "demo").sessions[1].session
    assert "\r" not in record.body
    assert "---" not in record.body
    assert "Body of session-aaaa1111." in record.body
    assert record.content_hash == content_hash(record.body)


# -- counts ------------------------------------------------------------------------------


def test_counts_match_the_raw_session_files_for_every_collection() -> None:
    result = build_inventory(FIXTURE)
    counts = {inv.profile.collection: inv.counts for inv in result.collections}
    demo = counts["demo"]
    assert (demo.main_sessions, demo.subagents, demo.raw_session_files) == (3, 4, 7)
    assert (demo.notes, demo.decisions) == (1, 1)
    assert (counts["nokind"].main_sessions, counts["nokind"].raw_session_files) == (1, 1)
    assert (counts["ist999"].main_sessions, counts["ist999"].notes) == (1, 1)
    assert all(inv.counts.matches for inv in result.collections)
    assert result.mismatched == ()


def test_a_session_file_the_inventory_cannot_read_is_a_mismatch(vault: Path) -> None:
    (vault / "projects/demo/sessions/zzzz9999.md").write_text("no frontmatter here\n", encoding="utf-8")
    result = build_inventory(vault)
    demo = by_name(result, "demo")
    assert (demo.counts.main_sessions + demo.counts.subagents, demo.counts.raw_session_files) == (7, 8)
    assert not demo.counts.matches
    assert [inv.profile.collection for inv in result.mismatched] == ["demo"]


# -- discovery and filters ---------------------------------------------------------------


def test_collections_are_found_per_realm_and_a_folder_without_hub_or_sessions_is_ignored() -> None:
    result = build_inventory(FIXTURE)
    assert [(i.profile.realm, i.profile.collection) for i in result.collections] == [
        ("classes", "ist999"),
        ("projects", "demo"),
        ("projects", "nokind"),
    ]
    assert [(s.path, s.reason) for s in result.ignored] == [
        ("classes/attachments", "not a collection (no hub note and no sessions/)")
    ]


def test_realm_and_collection_filters() -> None:
    assert [i.profile.collection for i in build_inventory(FIXTURE, realm="classes").collections] == ["ist999"]
    assert [i.profile.collection for i in build_inventory(FIXTURE, collection="nokind").collections] == ["nokind"]


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"realm": "nope"}, "no realm 'nope'"),
        ({"collection": "missing"}, "no collection 'missing'"),
        ({"collection": "../escape"}, "not an allowed collection name"),
        ({"collection": "Demo"}, "not an allowed collection name"),
    ],
)
def test_bad_filters_raise_config_errors(kwargs: dict, message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        build_inventory(FIXTURE, **kwargs)


def test_a_folder_with_a_disallowed_name_is_refused_not_walked(vault: Path) -> None:
    bad = vault / "projects" / "Bad.Name" / "sessions"
    bad.mkdir(parents=True)
    (bad / "x.md").write_text("---\ntype: session\n---\nx\n", encoding="utf-8")
    result = build_inventory(vault)
    assert "Bad.Name" not in [i.profile.collection for i in result.collections]
    assert ("projects/Bad.Name", "collection name not allowed") in [(s.path, s.reason) for s in result.ignored]


def test_a_missing_vault_raises() -> None:
    with pytest.raises(SourceError):
        build_inventory(FIXTURE / "nope")


def test_a_hub_with_an_invalid_kind_is_a_collection_error_and_others_still_run(vault: Path) -> None:
    hub = vault / "projects/nokind/nokind.md"
    hub.write_text(hub.read_text(encoding="utf-8").replace("type: index", "type: index\nkind: widget"), encoding="utf-8")
    result = build_inventory(vault)
    assert [(e.path, e.reason) for e in result.errors] == [
        ("projects/nokind", "projects/nokind/nokind.md: kind must be 'project' or 'class', got 'widget'")
    ]
    assert "demo" in [i.profile.collection for i in result.collections]


# -- git facts ---------------------------------------------------------------------------


def test_the_git_collector_gets_each_repo_and_a_class_without_one_gets_none() -> None:
    collector = FakeCollector()
    result = build_inventory(FIXTURE, git_collector=collector)
    assert sorted(collector.calls, key=str) == [
        (None, "owner/nokind"),
        (Path("C:/definitely/not/here"), "owner/demo"),
    ]
    assert by_name(result, "demo").git == "facts"
    assert by_name(result, "ist999").git is None


def test_without_a_collector_there_are_no_git_facts() -> None:
    assert all(inv.git is None for inv in build_inventory(FIXTURE).collections)


def test_a_failing_collector_becomes_a_warning_not_a_crash() -> None:
    result = build_inventory(FIXTURE, git_collector=FakeCollector(error=SourceError("gh is not logged in")))
    demo = by_name(result, "demo")
    assert demo.git is None
    assert any("git facts unavailable: gh is not logged in" in w for w in demo.warnings)


def test_a_hub_repo_path_that_does_not_exist_is_a_warning() -> None:
    demo = by_name(build_inventory(FIXTURE), "demo")
    assert any("repo_path does not exist" in w for w in demo.warnings)


# -- profile -----------------------------------------------------------------------------


def test_profile_reads_kind_plan_sources_and_repo_from_the_hub() -> None:
    profile = by_name(build_inventory(FIXTURE), "demo").profile
    assert profile.kind == KIND_PROJECT
    assert profile.hub_path == "projects/demo/demo.md"
    assert (profile.repo, profile.repo_path) == ("owner/demo", "C:/definitely/not/here")
    assert [(p.given, p.exists) for p in profile.plan_sources] == [
        ("projects/demo/notes/plan.md", True),
        ("C:/definitely/not/here/requirements.md", False),
    ]
    assert profile.plan_sources[0].resolved == (FIXTURE / "projects/demo/notes/plan.md").as_posix()


def test_profile_falls_back_to_the_realm_folder_for_kind_and_sessions_for_repo() -> None:
    result = build_inventory(FIXTURE)
    nokind = by_name(result, "nokind").profile
    assert (nokind.kind, nokind.repo, nokind.repo_path, nokind.plan_sources) == (KIND_PROJECT, "owner/nokind", None, ())
    ist = by_name(result, "ist999").profile
    assert ist.kind == KIND_CLASS
    assert [(p.given, p.exists) for p in ist.plan_sources] == [("classes/ist999/materials/syllabus.md", True)]
    assert ist.repo is None


def _collection(tmp_path: Path, realm_folder: str, hub: str | None) -> Path:
    directory = tmp_path / realm_folder / "coll"
    directory.mkdir(parents=True)
    if hub is not None:
        (directory / "coll.md").write_text(hub, encoding="utf-8")
    return directory


def _profile(tmp_path: Path, directory: Path, realm_folder: str, hints=(), runner=None):
    return build_profile(
        vault=tmp_path, realm=realm_folder, realm_folder=realm_folder, collection="coll",
        collection_dir=directory, hints=hints, runner=runner or FakeRunner({}),
    )


def test_a_kind_cannot_be_derived_from_any_other_realm_folder(tmp_path: Path) -> None:
    directory = _collection(tmp_path, "harness", "---\ntype: index\n---\n")
    with pytest.raises(SourceError, match="no kind"):
        _profile(tmp_path, directory, "harness")


def test_an_explicit_kind_works_in_any_realm(tmp_path: Path) -> None:
    directory = _collection(tmp_path, "harness", "---\ntype: index\nkind: project\n---\n")
    assert _profile(tmp_path, directory, "harness").kind == KIND_PROJECT


@pytest.mark.parametrize(
    ("hub", "message"),
    [
        ("---\ntype: note\n---\n", "is not a hub"),
        ("---\ntype: index\nplan_sources: {a: 1}\n---\n", "plan_sources must be"),
        ("---\ntype: index\nplan_sources: [1]\n---\n", "plan_sources must be"),
        ("---\ntype: index\nrepo: 'not a slug'\n---\n", "repo must be"),
        ("---\ntype: index\nrepo_path: [x]\n---\n", "repo_path must be"),
        ("---\ntype: index\nkind: [x]\n---\n", "kind must be"),
    ],
)
def test_bad_hub_fields_raise(tmp_path: Path, hub: str, message: str) -> None:
    directory = _collection(tmp_path, "projects", hub)
    with pytest.raises(SourceError, match=message):
        _profile(tmp_path, directory, "projects")


def test_a_collection_without_a_hub_gets_a_fallback_profile(tmp_path: Path) -> None:
    directory = _collection(tmp_path, "classes", None)
    profile = _profile(tmp_path, directory, "classes")
    assert (profile.kind, profile.hub_path, profile.plan_sources) == (KIND_CLASS, None, ())


def test_plan_source_wikilinks_are_resolved_as_vault_notes(tmp_path: Path) -> None:
    directory = _collection(tmp_path, "projects", "---\ntype: index\nplan_sources: ['[[projects/coll/plan|Plan]]']\n---\n")
    (directory / "plan.md").write_text("x", encoding="utf-8")
    source = _profile(tmp_path, directory, "projects").plan_sources[0]
    assert (source.given, source.exists) == ("[[projects/coll/plan|Plan]]", True)


def test_repo_path_is_derived_from_the_most_frequent_session_cwd_inside_a_git_repo(tmp_path: Path) -> None:
    directory = _collection(tmp_path, "projects", "---\ntype: index\n---\n")
    gone = (tmp_path / "gone").as_posix()  # most frequent, but not on disk
    plain = tmp_path / "plain"  # next, on disk, but not a git repo
    sub = tmp_path / "repo" / "sub"  # next, inside a repo: its toplevel wins
    rare = tmp_path / "rare"
    for folder in (plain, sub, rare):
        folder.mkdir(parents=True)
    hints = [SessionHint(cwd=gone, repo=None)] * 4 + [SessionHint(cwd=plain.as_posix(), repo=None)] * 3
    hints += [SessionHint(cwd=sub.as_posix(), repo=None)] * 2 + [SessionHint(cwd=rare.as_posix(), repo=None)]
    runner = FakeRunner({sub.as_posix(): (tmp_path / "repo").as_posix(), rare.as_posix(): rare.as_posix()})
    profile = _profile(tmp_path, directory, "projects", hints=hints, runner=runner)
    assert profile.repo_path == (tmp_path / "repo").as_posix()
    assert [call[2] for call in runner.calls] == [plain.as_posix(), sub.as_posix()]
    assert runner.calls[0][:2] == ["git", "-C"] and runner.calls[0][3:] == ["rev-parse", "--show-toplevel"]


def test_a_hub_repo_path_is_used_without_asking_git(tmp_path: Path) -> None:
    directory = _collection(tmp_path, "projects", "---\ntype: index\nrepo_path: 'C:/work/repo'\n---\n")
    runner = FakeRunner({})
    hints = [SessionHint(cwd=tmp_path.as_posix(), repo="a/b")]
    profile = _profile(tmp_path, directory, "projects", hints=hints, runner=runner)
    assert profile.repo_path == "C:/work/repo"
    assert runner.calls == []


def test_the_repo_fallback_is_the_most_frequent_valid_session_repo(tmp_path: Path) -> None:
    directory = _collection(tmp_path, "projects", "---\ntype: index\n---\n")
    hints = [SessionHint(cwd=None, repo="a/one")] + [SessionHint(cwd=None, repo="b/two")] * 2
    hints += [SessionHint(cwd=None, repo="bad slug")] * 5 + [SessionHint(cwd=None, repo="")] * 5
    assert _profile(tmp_path, directory, "projects", hints=hints).repo == "b/two"


@pytest.mark.parametrize("name", ["agentic-harness", "wa2 final", "ist335", "unit_3"])
def test_allowed_collection_names(name: str) -> None:
    assert check_collection_name(name) == name


@pytest.mark.parametrize("name", ["", "..", "../x", "a/b", "a\\b", "Upper", "-lead", " lead", "dot.ted"])
def test_refused_collection_names(name: str) -> None:
    with pytest.raises(ConfigError):
        check_collection_name(name)


def test_the_default_runner_returns_stdout_and_raises_a_source_error_on_failure() -> None:
    import sys

    from ingest.curate.profile import default_runner

    assert default_runner([sys.executable, "-c", "print('top')"]).strip() == "top"
    with pytest.raises(SourceError, match="exited 3"):
        default_runner([sys.executable, "-c", "import sys; sys.exit(3)"])
    with pytest.raises(SourceError, match="could not run"):
        default_runner(["definitely-not-a-binary-xyz"])
