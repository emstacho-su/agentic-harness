"""Tests for curate/gitfacts.py: commits from a real fixture repo, PRs from canned gh JSON."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

import pytest

from ingest.curate.gitfacts import (
    CommandError,
    Commit,
    GitFacts,
    PullRequest,
    collect_git_facts,
    parse_conventional,
    run_command,
)
from ingest.errors import SourceError

SLUG = "owner/repo"
GIT_IDENTITY = ("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
                "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false")

requires_git = pytest.mark.skipif(shutil.which("git") is None, reason="git is not on PATH")


# --- conventional-commit parsing ---------------------------------------------------------


@pytest.mark.parametrize(
    ("subject", "body", "expected"),
    [
        ("feat: add alpha", "", ("feat", None, False)),
        ("fix(parser): handle empty", "", ("fix", "parser", False)),
        ("feat!: drop legacy api", "", ("feat", None, True)),
        ("refactor(core)!: rename", "", ("refactor", "core", True)),
        ("Chore: capitalised type", "", ("chore", None, False)),
        ("refactor(core): rename", "BREAKING CHANGE: renamed x", ("refactor", "core", True)),
        ("docs: note", "BREAKING-CHANGE: footer form", ("docs", None, True)),
        ("wip: not a known type", "", (None, None, False)),
        ("Update readme", "", (None, None, False)),
        ("feat:missing space", "", (None, None, False)),
        ("Merge pull request #3 from x", "", (None, None, False)),
        ("revert: undo feat", "", ("revert", None, False)),
        ("feat(): empty scope", "", ("feat", None, False)),
    ],
)
def test_parse_conventional(subject: str, body: str, expected: tuple) -> None:
    assert parse_conventional(subject, body) == expected


def test_breaking_footer_only_counts_for_conventional_or_any_subject() -> None:
    # The footer is a breaking marker wherever it appears; a non-conventional subject
    # still has no type or scope.
    assert parse_conventional("Update readme", "BREAKING CHANGE: yes") == (None, None, True)


# --- default runner ------------------------------------------------------------------------


def test_run_command_returns_stdout() -> None:
    # git and gh print UTF-8; write bytes so the child's console code page does not matter.
    script = "import sys; sys.stdout.buffer.write('hi \\u00e9'.encode('utf-8'))"
    out = run_command([sys.executable, "-c", script], None)
    assert out.strip() == "hi \u00e9"


def test_run_command_raises_on_nonzero_exit() -> None:
    with pytest.raises(CommandError) as info:
        run_command([sys.executable, "-c", "import sys; sys.stderr.write('boom'); sys.exit(3)"], None)
    assert info.value.returncode == 3
    assert "boom" in str(info.value)


def test_run_command_raises_when_binary_missing() -> None:
    with pytest.raises(CommandError):
        run_command(["definitely-not-a-real-binary-xyz"], None)


# --- real fixture repository ----------------------------------------------------------------


def _git(repo: Path, *args: str, date: str | None = None) -> str:
    env = dict(os.environ)
    if date is not None:
        env["GIT_COMMITTER_DATE"] = date
        env["GIT_AUTHOR_DATE"] = date
    result = subprocess.run(
        ["git", *GIT_IDENTITY, "-C", repo.as_posix(), *args],
        capture_output=True, text=True, encoding="utf-8", env=env, check=True,
    )
    return result.stdout


def _commit(repo: Path, message: str, files: dict[str, str], date: str) -> None:
    for name, text in files.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    _git(repo, "add", "-A")
    extra = () if files else ("--allow-empty",)
    _git(repo, "commit", "-q", *extra, "-m", message, date=date)


TRICKY_SUBJECT = 'docs: say "hi"\tand \'bye\' \\ done; $(x) `y`'


@pytest.fixture
def fixture_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main", repo.as_posix()], check=True)
    _commit(repo, "feat: add alpha", {"alpha.py": "a\n", "docs/a.md": "x\n"},
            "2026-09-01T10:00:00-04:00")
    _commit(repo, "fix(parser): handle empty", {"parser.py": "p\n"}, "2026-09-02T10:00:00+00:00")
    _commit(repo, "feat!: drop legacy api", {"legacy.py": "l\n"}, "2026-09-03T10:00:00+00:00")
    _commit(repo, "Update readme", {"README.md": "r\n"}, "2026-09-04T10:00:00+00:00")
    _commit(repo, TRICKY_SUBJECT + "\n\nbody text\nBREAKING CHANGE: docs moved",
            {"docs/with space.md": "s\n"}, "2026-09-05T10:00:00+00:00")
    _commit(repo, "chore: empty marker", {}, "2026-09-06T10:00:00+00:00")
    _git(repo, "checkout", "-q", "-b", "feature/unmerged")
    _commit(repo, "feat(branch): unmerged work", {"branch.py": "b\n"}, "2026-09-07T10:00:00+00:00")
    _git(repo, "checkout", "-q", "main")
    return repo


@requires_git
def test_real_repo_commits_oldest_first_with_types(fixture_repo: Path) -> None:
    facts = collect_git_facts(fixture_repo, None)
    subjects = [c.subject for c in facts.commits]
    assert subjects == [
        "feat: add alpha",
        "fix(parser): handle empty",
        "feat!: drop legacy api",
        "Update readme",
        TRICKY_SUBJECT,
        "chore: empty marker",
        "feat(branch): unmerged work",
    ]
    assert [c.type for c in facts.commits] == ["feat", "fix", "feat", None, "docs", "chore", "feat"]
    assert [c.scope for c in facts.commits] == [None, "parser", None, None, None, None, "branch"]
    assert [c.breaking for c in facts.commits] == [False, False, True, False, True, False, False]
    assert facts.prs == ()


@requires_git
def test_real_repo_files_dates_and_shas(fixture_repo: Path) -> None:
    facts = collect_git_facts(fixture_repo, None)
    by_subject = {c.subject: c for c in facts.commits}
    first = by_subject["feat: add alpha"]
    assert first.files == ("alpha.py", "docs/a.md")
    assert first.date == "2026-09-01T14:00:00Z"
    assert len(first.sha) == 40
    assert by_subject[TRICKY_SUBJECT].files == ("docs/with space.md",)
    assert by_subject["chore: empty marker"].files == ()
    assert len({c.sha for c in facts.commits}) == len(facts.commits)


@requires_git
def test_real_repo_on_main_falls_back_to_local_main(fixture_repo: Path) -> None:
    facts = collect_git_facts(fixture_repo, None)
    on_main = {c.subject: c.on_main for c in facts.commits}
    assert on_main["feat(branch): unmerged work"] is False
    assert all(v for k, v in on_main.items() if k != "feat(branch): unmerged work")
    assert facts.warnings == ()


@requires_git
def test_real_repo_since_filters_commits(fixture_repo: Path) -> None:
    facts = collect_git_facts(fixture_repo, None, since="2026-09-05T00:00:00+00:00")
    assert [c.subject for c in facts.commits] == [
        TRICKY_SUBJECT, "chore: empty marker", "feat(branch): unmerged work",
    ]


@requires_git
def test_real_directory_that_is_not_a_repo_warns(tmp_path: Path) -> None:
    facts = collect_git_facts(tmp_path, None)
    assert facts.commits == ()
    assert len(facts.warnings) == 1
    assert "not a git repository" in facts.warnings[0]


# --- fake runner ------------------------------------------------------------------------------


class FakeRunner:
    """Answers by the first recognised subcommand in argv; records every call."""

    def __init__(self, answers: dict[str, str | Exception]) -> None:
        self._answers = answers
        self.calls: list[list[str]] = []

    def __call__(self, argv: Sequence[str], cwd: Path | None) -> str:
        self.calls.append(list(argv))
        key = _command_key(argv)
        answer = self._answers.get(key)
        if answer is None:
            raise CommandError(argv, 128, f"no canned answer for {key}")
        if isinstance(answer, Exception):
            raise answer
        return answer


def _command_key(argv: Sequence[str]) -> str:
    if argv[0] == "gh":
        return "gh"
    for word in ("rev-parse", "log"):
        if word in argv:
            return word
    if "rev-list" in argv:
        return f"rev-list {argv[-1]}"
    return " ".join(argv)


SHA_A = "a" * 40
SHA_B = "b" * 40


def _log_record(sha: str, date: str, subject: str, body: str, files: Sequence[str]) -> str:
    blob = "\0\n" + "".join(f"{name}\0" for name in files) if files else "\0"
    return f"\x1e{sha}\x1f{date}\x1f{subject}\x1f{body}\x1f{blob}"


FAKE_LOG = (
    _log_record(SHA_A, "2026-09-01T10:00:00-04:00", "feat(api): one", "", ["src/a.py", "b.md"])
    + _log_record(SHA_B, "2026-09-02T00:00:00Z", "odd subject", "", [])
    + _log_record(SHA_A, "2026-09-01T10:00:00-04:00", "feat(api): one", "", ["src/a.py"])
)


def test_fake_runner_origin_main_used_when_present() -> None:
    runner = FakeRunner({
        "rev-parse": "true\n",
        "log": FAKE_LOG,
        "rev-list origin/main": f"{SHA_A}\n",
    })
    facts = collect_git_facts(Path("C:/fake/repo"), None, runner, since="2026-09-01")
    assert [c.sha for c in facts.commits] == [SHA_A, SHA_B]  # deduplicated by sha
    first, second = facts.commits
    assert first == Commit(
        sha=SHA_A, date="2026-09-01T14:00:00Z", subject="feat(api): one", type="feat",
        scope="api", breaking=False, files=("src/a.py", "b.md"), on_main=True,
    )
    assert second.on_main is False
    assert second.files == ()
    log_call = next(call for call in runner.calls if "log" in call)
    assert "--since=2026-09-01" in log_call
    assert log_call[:3] == ["git", "-C", "C:/fake/repo"]
    assert not any("rev-list main" == _command_key(call) for call in runner.calls)


def test_fake_runner_no_default_branch_warns() -> None:
    runner = FakeRunner({"rev-parse": "true\n", "log": FAKE_LOG})
    facts = collect_git_facts(Path("C:/fake/repo"), None, runner)
    assert all(c.on_main is False for c in facts.commits)
    assert any("default branch" in w for w in facts.warnings)


def test_repo_path_none_warns_and_skips_git() -> None:
    runner = FakeRunner({})
    facts = collect_git_facts(None, None, runner)
    assert facts == GitFacts(commits=(), prs=(), warnings=("no repository path given",))
    assert runner.calls == []


def test_malformed_log_record_raises() -> None:
    runner = FakeRunner({"rev-parse": "true\n", "log": "\x1enot-a-record", "rev-list main": ""})
    with pytest.raises(SourceError):
        collect_git_facts(Path("C:/fake/repo"), None, runner)


# --- pull requests (fake gh only) ---------------------------------------------------------------

GH_PRS = [
    {
        "number": 7, "title": "feat: open work", "state": "OPEN", "headRefName": "feat/open",
        "createdAt": "2026-09-20T10:00:00Z", "mergedAt": None, "mergeCommit": None,
        "commits": [{"oid": SHA_B}],
    },
    {
        "number": 2, "title": "fix: merged thing", "state": "MERGED", "headRefName": "fix/merged",
        "createdAt": "2026-09-10T10:00:00Z", "mergedAt": "2026-09-11T10:00:00Z",
        "mergeCommit": {"oid": SHA_A}, "commits": [{"oid": SHA_A}, {"oid": SHA_B}],
    },
    {
        "number": 5, "title": "chore: abandoned", "state": "CLOSED", "headRefName": "chore/x",
        "createdAt": "2026-09-12T10:00:00Z", "mergedAt": None,
    },
]


def _gh_only(answer: str | Exception) -> FakeRunner:
    return FakeRunner({"gh": answer})


def test_prs_parsed_and_sorted_by_number() -> None:
    runner = _gh_only(json.dumps(GH_PRS))
    facts = collect_git_facts(None, SLUG, runner)
    assert [pr.number for pr in facts.prs] == [2, 5, 7]
    merged, closed, opened = facts.prs
    assert merged == PullRequest(
        number=2, title="fix: merged thing", state="MERGED", head="fix/merged",
        created_at="2026-09-10T10:00:00Z", merged_at="2026-09-11T10:00:00Z",
        merge_commit=SHA_A, commits=(SHA_A, SHA_B),
    )
    assert closed.merge_commit is None and closed.commits == () and closed.state == "CLOSED"
    assert opened.merged_at is None and opened.commits == (SHA_B,)
    gh_call = runner.calls[0]
    assert gh_call[:4] == ["gh", "pr", "list", "-R"] and gh_call[4] == SLUG
    assert "--state" in gh_call and "all" in gh_call


def test_gh_list_does_not_request_commits() -> None:
    # gh's GraphQL node limit rejects `commits` on a list of more than ~50 PRs.
    runner = _gh_only("[]")
    collect_git_facts(None, SLUG, runner)
    fields = runner.calls[0][runner.calls[0].index("--json") + 1].split(",")
    assert "commits" not in fields
    assert {"number", "state", "mergeCommit", "headRefName"} <= set(fields)


def test_gh_failure_is_a_warning_not_an_error() -> None:
    runner = _gh_only(CommandError(["gh"], 4, "gh auth login required"))
    facts = collect_git_facts(None, SLUG, runner)
    assert facts.prs == ()
    assert any(w.startswith("gh unavailable:") for w in facts.warnings)


def test_gh_missing_binary_is_a_warning() -> None:
    facts = collect_git_facts(None, SLUG, _gh_only(FileNotFoundError("gh")))
    assert facts.prs == ()
    assert any(w.startswith("gh unavailable:") for w in facts.warnings)


def test_gh_bad_json_is_a_warning() -> None:
    facts = collect_git_facts(None, SLUG, _gh_only("not json"))
    assert facts.prs == ()
    assert any(w.startswith("gh unavailable:") for w in facts.warnings)


def test_gh_malformed_entry_is_skipped_with_warning() -> None:
    entries = [GH_PRS[1], {"number": "x", "title": 3}]
    facts = collect_git_facts(None, SLUG, _gh_only(json.dumps(entries)))
    assert [pr.number for pr in facts.prs] == [2]
    assert any("skipped" in w for w in facts.warnings)


def test_no_slug_means_no_gh_call() -> None:
    runner = FakeRunner({})
    collect_git_facts(None, None, runner)
    assert not any(call[0] == "gh" for call in runner.calls)


def test_slug_must_look_like_owner_repo() -> None:
    runner = FakeRunner({})
    facts = collect_git_facts(None, "--help", runner)
    assert facts.prs == ()
    assert any("slug" in w for w in facts.warnings)
    assert runner.calls == []
