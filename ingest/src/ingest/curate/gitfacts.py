"""Git facts for the curator's inventory (R-C1): commits with their conventional type,
and pull requests with their merge state.

Everything here is a read. Commits come from one ``git log`` over every local and
remote branch, printed with ASCII unit (``%x1f``) and record (``%x1e``) separators and
``-z`` file lists, so a subject holding tabs, quotes or shell metacharacters parses
safely. ``on_main`` is membership in one ``git rev-list`` of the default branch
(``origin/main``, else ``main``), computed once rather than per commit.

Pull requests come from ``gh pr list``, without their commit lists (see
``_GH_FIELDS``). gh is optional: when it is missing, not
authenticated or fails, the facts carry a warning and no PRs, and nothing raises.
A path that is not a git repository is also a warning. A ``git log`` that fails or
prints something unparseable inside a real repository is an error.

Every command goes through a ``Runner`` (argv and cwd in, stdout out), so tests swap
in a fake; the default runs a list argv without a shell.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..errors import SourceError

COMMAND_TIMEOUT_SECONDS = 120
STDERR_LIMIT = 500
GH_PR_LIMIT = 1000
DEFAULT_BRANCH_CANDIDATES = ("origin/main", "main")

CONVENTIONAL_TYPES = frozenset(
    {"feat", "fix", "docs", "test", "chore", "refactor", "perf", "ci", "build", "style", "revert"}
)
_CONVENTIONAL = re.compile(r"^(\w+)(\([^)]*\))?(!)?: ")
_BREAKING_FOOTER = re.compile(r"^BREAKING[ -]CHANGE: ", re.MULTILINE)
_SLUG = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")

UNIT_SEP = "\x1f"
RECORD_SEP = "\x1e"
# sha, committer date, subject, body; the trailing separator marks where -z's file list starts.
_LOG_FORMAT = "--format=%x1e%H%x1f%cI%x1f%s%x1f%b%x1f"
# No `commits`: on a list call GitHub's GraphQL node limit (500,000) rejects it past
# ~50 PRs. A PR's commits stay () unless gh returns them; merge_commit links it to git.
_GH_FIELDS = "number,title,state,headRefName,createdAt,mergedAt,mergeCommit"


class CommandError(SourceError):
    """An external command could not start, timed out, or exited non-zero."""

    def __init__(self, argv: Sequence[str], returncode: int | None, stderr: str) -> None:
        detail = stderr.strip()[:STDERR_LIMIT]
        super().__init__(f"{' '.join(argv[:3])} ... exited {returncode}: {detail}")
        self.argv = tuple(argv)
        self.returncode = returncode
        self.stderr = detail


Runner = Callable[[Sequence[str], Path | None], str]


@dataclass(frozen=True)
class Commit:
    sha: str
    date: str
    subject: str
    type: str | None
    scope: str | None
    breaking: bool
    files: tuple[str, ...]
    on_main: bool


@dataclass(frozen=True)
class PullRequest:
    number: int
    title: str
    state: str
    head: str
    created_at: str
    merged_at: str | None
    merge_commit: str | None
    commits: tuple[str, ...]


@dataclass(frozen=True)
class GitFacts:
    commits: tuple[Commit, ...]
    prs: tuple[PullRequest, ...]
    warnings: tuple[str, ...]


def run_command(argv: Sequence[str], cwd: Path | None) -> str:
    """Run ``argv`` without a shell and return its stdout; raise CommandError otherwise."""
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GH_PROMPT_DISABLED": "1"}
    try:
        result = subprocess.run(
            list(argv), cwd=cwd, env=env, stdin=subprocess.DEVNULL, capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CommandError(argv, None, f"{type(exc).__name__}: {exc}") from exc
    if result.returncode != 0:
        raise CommandError(argv, result.returncode, result.stderr)
    return result.stdout


def parse_conventional(subject: str, body: str) -> tuple[str | None, str | None, bool]:
    """``(type, scope, breaking)`` for a commit message.

    Type and scope are set only when the subject's type word is a known conventional
    type. ``breaking`` is the subject's ``!`` on such a type, or a
    ``BREAKING CHANGE:`` footer anywhere in the body.
    """
    footer_breaking = _BREAKING_FOOTER.search(body) is not None
    match = _CONVENTIONAL.match(subject)
    if match is None or match.group(1).lower() not in CONVENTIONAL_TYPES:
        return None, None, footer_breaking
    scope = match.group(2)[1:-1].strip() if match.group(2) else ""
    return match.group(1).lower(), scope or None, footer_breaking or match.group(3) == "!"


def collect_git_facts(
    repo_path: Path | None,
    repo_slug: str | None,
    runner: Runner | None = None,
    *,
    since: str | None = None,
) -> GitFacts:
    """Commits of ``repo_path`` (oldest first) and PRs of ``repo_slug`` (by number)."""
    run = runner or run_command
    commits, commit_warnings = _collect_commits(repo_path, run, since)
    prs, pr_warnings = _collect_prs(repo_slug, run)
    return GitFacts(commits=commits, prs=prs, warnings=commit_warnings + pr_warnings)


# --- commits ----------------------------------------------------------------------------------


def _git(repo: str, *args: str) -> list[str]:
    return ["git", "-C", repo, "-c", "core.quotepath=off", *args]


def _collect_commits(
    repo_path: Path | None, run: Runner, since: str | None
) -> tuple[tuple[Commit, ...], tuple[str, ...]]:
    if repo_path is None:
        return (), ("no repository path given",)
    repo = repo_path.as_posix()
    if not _is_work_tree(repo, run):
        return (), (f"not a git repository: {repo}",)
    main_shas, warnings = _default_branch_shas(repo, run)
    args = ["log", "--no-merges", "--date-order", "--reverse", "--no-renames", "--no-color",
            "-z", "--name-only", _LOG_FORMAT, "--branches", "--remotes"]
    if since is not None:
        args.append(f"--since={since}")
    output = run(_git(repo, *args), None)
    return _parse_log(output, main_shas), warnings


def _is_work_tree(repo: str, run: Runner) -> bool:
    try:
        return run(_git(repo, "rev-parse", "--is-inside-work-tree"), None).strip() == "true"
    except CommandError:
        return False


def _default_branch_shas(repo: str, run: Runner) -> tuple[frozenset[str], tuple[str, ...]]:
    for ref in DEFAULT_BRANCH_CANDIDATES:
        try:
            output = run(_git(repo, "rev-list", ref), None)
        except CommandError:
            continue
        return frozenset(output.split()), ()
    tried = " or ".join(DEFAULT_BRANCH_CANDIDATES)
    return frozenset(), (f"no default branch ({tried}) in {repo}; every commit has on_main=False",)


def _parse_log(output: str, main_shas: frozenset[str]) -> tuple[Commit, ...]:
    commits: list[Commit] = []
    seen: set[str] = set()
    for record in output.split(RECORD_SEP):
        if not record.strip("\0\n"):
            continue
        commit = _parse_record(record, main_shas)
        if commit.sha not in seen:
            seen.add(commit.sha)
            commits.append(commit)
    return tuple(commits)


def _parse_record(record: str, main_shas: frozenset[str]) -> Commit:
    head = record.split(UNIT_SEP, 3)
    if len(head) != 4 or UNIT_SEP not in head[3]:
        raise SourceError(f"unparseable git log record: {record[:80]!r}")
    sha, raw_date, subject, rest = head
    body, file_blob = rest.rsplit(UNIT_SEP, 1)
    commit_type, scope, breaking = parse_conventional(subject, body)
    return Commit(
        sha=sha,
        date=_to_utc(raw_date),
        subject=subject,
        type=commit_type,
        scope=scope,
        breaking=breaking,
        files=_parse_files(file_blob),
        on_main=sha in main_shas,
    )


def _parse_files(blob: str) -> tuple[str, ...]:
    """``-z --name-only`` prints ``\\0\\n`` then each path NUL-terminated."""
    names = blob.removeprefix("\0").removeprefix("\n").split("\0")
    return tuple(name for name in names if name)


def _to_utc(raw: str) -> str:
    try:
        moment = datetime.fromisoformat(raw.strip())
    except ValueError as exc:
        raise SourceError(f"unparseable commit date: {raw!r}") from exc
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# --- pull requests ----------------------------------------------------------------------------


def _collect_prs(
    repo_slug: str | None, run: Runner
) -> tuple[tuple[PullRequest, ...], tuple[str, ...]]:
    if repo_slug is None:
        return (), ()
    if not _SLUG.match(repo_slug):
        return (), (f"gh skipped: repository slug {repo_slug!r} is not owner/repo",)
    argv = ["gh", "pr", "list", "-R", repo_slug, "--state", "all",
            "--limit", str(GH_PR_LIMIT), "--json", _GH_FIELDS]
    try:
        entries = json.loads(run(argv, None))
    except (CommandError, OSError) as exc:
        return (), (f"gh unavailable: {exc}",)
    except json.JSONDecodeError as exc:
        return (), (f"gh unavailable: output was not JSON ({exc.msg})",)
    if not isinstance(entries, list):
        return (), ("gh unavailable: expected a JSON list of pull requests",)
    return _parse_prs(entries)


def _parse_prs(entries: list[Any]) -> tuple[tuple[PullRequest, ...], tuple[str, ...]]:
    prs: list[PullRequest] = []
    warnings: list[str] = []
    for index, entry in enumerate(entries):
        try:
            prs.append(_parse_pr(entry))
        except (TypeError, ValueError, KeyError) as exc:
            warnings.append(f"gh pull request #{index} skipped: {exc}")
    if len(entries) >= GH_PR_LIMIT:
        warnings.append(f"gh returned {GH_PR_LIMIT} pull requests; older ones may be missing")
    return tuple(sorted(prs, key=lambda pr: pr.number)), tuple(warnings)


def _parse_pr(entry: Any) -> PullRequest:
    if not isinstance(entry, dict):
        raise TypeError("entry is not an object")
    number = entry["number"]
    if not isinstance(number, int) or isinstance(number, bool):
        raise ValueError(f"number is not an integer: {number!r}")
    merge_commit = entry.get("mergeCommit")
    commits = entry.get("commits") or []
    return PullRequest(
        number=number,
        title=_text(entry, "title"),
        state=_text(entry, "state"),
        head=_text(entry, "headRefName"),
        created_at=_text(entry, "createdAt"),
        merged_at=_optional_text(entry.get("mergedAt")),
        merge_commit=_optional_text(merge_commit.get("oid")) if isinstance(merge_commit, dict) else None,
        commits=tuple(_text(commit, "oid") for commit in commits),
    )


def _text(entry: Any, key: str) -> str:
    if not isinstance(entry, dict):
        raise TypeError(f"expected an object holding {key!r}")
    value = entry[key]
    if not isinstance(value, str):
        raise ValueError(f"{key} is not a string: {value!r}")
    return value


def _optional_text(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValueError(f"expected a string or null: {value!r}")
    return value
