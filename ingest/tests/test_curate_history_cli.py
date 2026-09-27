"""Tests for ``uv run ingest curate history`` (curate/history_cli.py, R-C5), end to end on tmp vaults.

The judge is a :class:`FakeJudge`, the store an :class:`InMemoryCurateStore`
(or a double); nothing reaches a model, a database, git or the real vault.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

import pytest

from ingest import envfile
from ingest.curate.cli import STAGES, build_curate_parser, run_curate
from ingest.curate.gitfacts import GitFacts
from ingest.curate.history import history_version
from ingest.curate.judge import FakeJudge, JudgeError
from ingest.curate.store_models import InMemoryCurateStore
from ingest.errors import StoreError
from ingest.loaders.obsidian import split_frontmatter

from test_curate_history import add_session, add_subagent, labels_in, make_vault

SECRET_TEXT = "private-body-text-7f3a"


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[None]:
    """No repo .env, no machine file, no database settings; whatever a run loads is undone."""
    saved = dict(os.environ)
    monkeypatch.setattr(envfile, "find_env_file", lambda start=None: None)
    monkeypatch.setenv("HARNESS_MACHINE_ENV", str(tmp_path / "no-machine.env"))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    yield
    for key in set(os.environ) - set(saved):
        del os.environ[key]
    os.environ.update(saved)


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    root = make_vault(tmp_path)
    add_session(root, "s1", "2026-09-15", body=f"## Outcome\n{SECRET_TEXT}\n")
    add_subagent(root, "s1", "a1", "2026-09-15")
    add_session(root, "s2", "2026-09-22")
    return root


class Collector:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, repo_path, repo_slug):
        self.calls += 1
        return GitFacts((), (), ())


class RefusingStore(InMemoryCurateStore):
    """Readable, but a write is a test failure."""

    def put_history_week(self, week) -> None:
        raise AssertionError("a dry run must not write to the store")


def answer(prompt: str, schema: dict) -> dict:
    labels = labels_in(prompt)
    return {"paragraphs": [{"text": f"{SECRET_TEXT} paragraph.", "cites": labels}],
            "titles": [{"ref": labels[0], "title": f"{SECRET_TEXT} title"}]}


def clock(day: int = 27):
    return lambda: datetime(2026, 9, day, 4, 30, tzinfo=timezone.utc)


def run(vault: Path, argv: list[str], capsys, **kwargs) -> tuple[int, str, str]:
    kwargs.setdefault("git_collector", Collector())
    kwargs.setdefault("clock", clock())
    code = run_curate(["history", "--path", vault.as_posix(), *argv], **kwargs)
    out, err = capsys.readouterr()
    return code, out, err


def history_path(vault: Path) -> Path:
    return vault / "projects" / "demo" / "history.md"


def test_the_stage_is_registered_with_its_flags() -> None:
    assert "history" in STAGES
    args = build_curate_parser().parse_args(
        ["history", "--path", "v", "--all", "--model", "m", "--max-calls", "3", "--max-tokens", "9",
         "--no-git", "--dry-run", "--json", "--realm", "projects", "--env-file", "e", "-v"])
    assert (args.stage, args.all, args.model, args.max_calls, args.max_tokens) == ("history", True, "m", 3, 9)
    assert args.no_git and args.dry_run and args.json and args.verbose


def test_collection_or_all_is_required(vault: Path) -> None:
    with pytest.raises(SystemExit):
        build_curate_parser().parse_args(["history", "--path", vault.as_posix()])


def test_a_dry_run_writes_nothing_and_calls_nothing(vault: Path, capsys) -> None:
    store = RefusingStore()
    judge = FakeJudge([])
    code, out, err = run(vault, ["--collection", "demo", "--dry-run"], capsys, store=store, judge=judge)
    assert code == 0, err
    assert judge.calls == () and not history_path(vault).exists()
    assert "history dry run" in out
    assert "projects/demo: weeks 2, cached 0, would ask 2" in out
    assert "history: projects/demo/history.md not written (dry run)" in out


def test_a_dry_run_still_needs_the_store(vault: Path, capsys) -> None:
    def unreachable():
        raise StoreError("database unreachable")

    code, _, err = run(vault, ["--collection", "demo", "--dry-run"], capsys, store_factory=unreachable)
    assert code == 2 and "database unreachable" in err


def test_a_live_run_writes_history_md(vault: Path, capsys) -> None:
    store = InMemoryCurateStore()
    judge = FakeJudge(answer)
    code, out, err = run(vault, ["--collection", "demo"], capsys, store=store, judge=judge)
    assert code == 0, err
    assert len(judge.calls) == 2
    fields, body = split_frontmatter(history_path(vault).read_text(encoding="utf-8"))
    assert fields["captured_by"] == "curator" and fields["type"] == "history"
    assert fields["id"] == "curator-history-projects-demo"
    assert fields["history_version"] == history_version()
    assert fields["generated_at"] == "2026-09-27T04:30:00+00:00"
    assert "## Week of 2026-09-14" in body and "## Week of 2026-09-21" in body
    assert "projects/demo: weeks 2, cached 0, judge calls 2" in out
    assert "history: projects/demo/history.md written" in out
    assert SECRET_TEXT not in out and SECRET_TEXT not in err


def test_a_rerun_with_the_cache_warm_asks_nothing_and_leaves_the_file(vault: Path, capsys) -> None:
    store = InMemoryCurateStore()
    run(vault, ["--collection", "demo"], capsys, store=store, judge=FakeJudge(answer))
    target = history_path(vault)
    before = target.read_bytes()
    os.utime(target, (1_000_000, 1_000_000))
    judge = FakeJudge([])
    code, out, _ = run(vault, ["--collection", "demo"], capsys, store=store, judge=judge, clock=clock(28))
    assert code == 0 and judge.calls == ()
    assert "cached 2, judge calls 0" in out
    assert "history: projects/demo/history.md unchanged" in out
    assert target.read_bytes() == before and target.stat().st_mtime == 1_000_000


def test_the_json_report_has_counts_only(vault: Path, capsys) -> None:
    code, out, _ = run(vault, ["--collection", "demo", "--json"], capsys, store=InMemoryCurateStore(),
                       judge=FakeJudge(answer))
    report = json.loads(out)
    assert code == 0 and report["exit_code"] == 0
    assert set(report) == {"version", "dry_run", "collections", "judge_calls", "tokens", "stopped", "exit_code"}
    assert report["version"] == history_version() and report["dry_run"] is False
    (one,) = report["collections"]
    assert one == {
        "folder": "projects/demo", "collection": "demo", "weeks": 2, "cached": 0, "judge_calls": 2,
        "would_ask": 0, "estimated_tokens": 0, "pending": 0, "undated": [], "dropped_citations": 0,
        "dropped_paragraphs": 0, "dropped_titles": 0, "failed": [], "left": 0,
        "history": {"path": "projects/demo/history.md", "written": True, "outcome": "written"},
    }
    assert SECRET_TEXT not in out


def test_a_budget_stop_exits_3_and_still_writes(vault: Path, capsys) -> None:
    code, out, _ = run(vault, ["--collection", "demo", "--max-calls", "1"], capsys, store=InMemoryCurateStore(),
                       judge=FakeJudge(answer))
    assert code == 3
    assert "stopped by budget" in out.splitlines()[-1]
    assert "narrative pending" in history_path(vault).read_text(encoding="utf-8")


def test_failing_judge_calls_exit_1(vault: Path, capsys) -> None:
    code, out, _ = run(vault, ["--collection", "demo"], capsys, store=InMemoryCurateStore(),
                       judge=FakeJudge([JudgeError("down"), JudgeError("down")]))
    assert code == 1
    assert "failed: week 2026-09-14 (judge failed: down)" in out
    assert "consecutive judge failures" in out.splitlines()[-1]


def test_no_git_skips_the_collector(vault: Path, capsys) -> None:
    collector = Collector()
    code, _, _ = run(vault, ["--collection", "demo", "--no-git", "--dry-run"], capsys, store=InMemoryCurateStore(),
                     git_collector=collector)
    assert code == 0 and collector.calls == 0


def test_an_unknown_collection_cannot_run(vault: Path, capsys) -> None:
    code, _, err = run(vault, ["--collection", "nope"], capsys, store=InMemoryCurateStore())
    assert code == 2 and "error" in err


def test_a_history_md_not_written_by_the_curator_is_refused(vault: Path, capsys) -> None:
    history_path(vault).write_text("---\ntitle: mine\n---\nmy own notes\n", encoding="utf-8")
    code, out, err = run(vault, ["--collection", "demo"], capsys, store=InMemoryCurateStore(),
                         judge=FakeJudge(answer))
    assert code == 2 and "not written by the curator" in err
    assert "history: projects/demo/history.md refused" in out
    assert history_path(vault).read_text(encoding="utf-8").endswith("my own notes\n")
