"""Tests for ``uv run ingest curate inventory`` (curate/cli.py), end to end on the fixture vault."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Iterator

import pytest

from ingest import cli, envfile
from ingest.curate import cli as curate_cli
from ingest.curate.cli import EXIT_CLEAN, EXIT_MISMATCH, EXIT_UNAVAILABLE, run_curate

FIXTURE = Path(__file__).parent / "fixtures" / "curate_vault"

# A value from an env file that must never reach any output.
SECRET = "s3cret-curate-value"


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[None]:
    """No repo .env, no real machine file; whatever a run loads is undone after it."""
    saved = dict(os.environ)
    monkeypatch.setattr(envfile, "find_env_file", lambda start=None: None)
    monkeypatch.setenv("HARNESS_MACHINE_ENV", str(tmp_path / "no-machine.env"))
    yield
    for key in set(os.environ) - set(saved):
        del os.environ[key]
    os.environ.update(saved)


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    target = tmp_path / "vault"
    shutil.copytree(FIXTURE, target)
    return target


class FakeCollector:
    def __init__(self) -> None:
        self.calls: list[tuple[Path | None, str | None]] = []

    def __call__(self, repo_path: Path | None, repo_slug: str | None) -> dict:
        self.calls.append((repo_path, repo_slug))
        return {"commits": [{"sha": "abc", "type": "fix"}], "prs": [], "warnings": ["gh not logged in"]}


def run(argv: list[str], capsys, collector=None) -> tuple[int, str, str]:
    code = run_curate(argv, git_collector=collector or FakeCollector())
    out, err = capsys.readouterr()
    return code, out, err


def test_text_output_has_one_line_per_collection_and_exits_clean(capsys) -> None:
    code, out, _ = run(["inventory", "--path", FIXTURE.as_posix()], capsys)
    assert code == EXIT_CLEAN
    lines = out.strip().splitlines()
    collection_lines = [line for line in lines if line.startswith(("projects/", "classes/"))]
    assert [line.split()[0] for line in collection_lines] == ["classes/ist999", "projects/demo", "projects/nokind"]
    demo = next(line for line in collection_lines if line.startswith("projects/demo"))
    assert "sessions 3" in demo and "subagents 4" in demo and "raw 7" in demo
    assert "sdk 1" in demo and "notes 1" in demo and "decisions 1" in demo and "skipped 1" in demo
    assert "git: 1 commits, 0 PRs" in demo
    assert "    git warning: gh not logged in" in lines
    assert lines[-1] == "inventory: clean (3 collections)"


def test_json_carries_the_timeline_without_bodies(capsys) -> None:
    code, out, _ = run(["inventory", "--path", FIXTURE.as_posix(), "--json"], capsys)
    assert code == EXIT_CLEAN
    report = json.loads(out)
    assert report["clean"] is True
    demo = next(c for c in report["collections"] if c["collection"] == "demo")
    assert demo["counts"]["raw_session_files"] == 7
    assert demo["matches"] is True
    first = demo["timeline"][0]
    assert first["session"]["path"] == "projects/demo/sessions/bbbb2222.md"
    assert [s["path"] for s in first["subagents"]] == [
        "projects/demo/sessions/bbbb2222--agent9.md",
        "projects/demo/sessions/bbbb2222--agent2.md",
    ]
    assert demo["orphans"][0]["parent_session_id"] == "cccc3333"
    assert demo["profile"]["kind"] == "project"
    assert demo["git"]["commits"] == [{"sha": "abc", "type": "fix"}]
    assert "body" not in json.dumps(report)
    assert first["session"]["content_hash"]


def test_a_count_mismatch_is_a_finding_and_exits_one(vault: Path, capsys) -> None:
    (vault / "projects/demo/sessions/zzzz9999.md").write_text("no frontmatter\n", encoding="utf-8")
    code, out, _ = run(["inventory", "--path", vault.as_posix()], capsys)
    assert code == EXIT_MISMATCH
    assert "finding: projects/demo: 7 session notes inventoried, 8 files in sessions/" in out
    assert out.strip().splitlines()[-1] == "inventory: 1 collection(s) mismatch"


def test_no_git_skips_the_collector(capsys) -> None:
    collector = FakeCollector()
    code, out, _ = run(["inventory", "--path", FIXTURE.as_posix(), "--no-git", "--json"], capsys, collector)
    assert code == EXIT_CLEAN
    assert collector.calls == []
    assert all(c["git"] is None for c in json.loads(out)["collections"])


def test_dry_run_is_accepted_and_changes_nothing(capsys) -> None:
    code, _, _ = run(["inventory", "--path", FIXTURE.as_posix(), "--dry-run"], capsys)
    assert code == EXIT_CLEAN


def test_filters_narrow_the_report(capsys) -> None:
    code, out, _ = run(["inventory", "--path", FIXTURE.as_posix(), "--realm", "projects", "--collection", "demo"], capsys)
    assert code == EXIT_CLEAN
    assert [line.split()[0] for line in out.splitlines() if line.startswith("projects/")] == ["projects/demo"]


@pytest.mark.parametrize(
    ("extra", "message"),
    [
        (["--realm", "nope"], "no realm 'nope'"),
        (["--collection", "../x"], "not an allowed collection name"),
        (["--collection", "missing"], "no collection 'missing'"),
    ],
)
def test_bad_arguments_exit_two(extra: list[str], message: str, capsys) -> None:
    code, _, err = run(["inventory", "--path", FIXTURE.as_posix(), *extra], capsys)
    assert code == EXIT_UNAVAILABLE
    assert message in err


def test_a_missing_vault_exits_two(tmp_path: Path, capsys) -> None:
    code, _, err = run(["inventory", "--path", (tmp_path / "nope").as_posix()], capsys)
    assert code == EXIT_UNAVAILABLE
    assert "does not exist" in err


def test_a_hub_with_an_invalid_kind_exits_two_and_still_reports_the_rest(vault: Path, capsys) -> None:
    hub = vault / "projects/demo/demo.md"
    hub.write_text(hub.read_text(encoding="utf-8").replace("kind: project", "kind: widget"), encoding="utf-8")
    code, out, err = run(["inventory", "--path", vault.as_posix()], capsys)
    assert code == EXIT_UNAVAILABLE
    assert "error: projects/demo: projects/demo/demo.md: kind must be 'project' or 'class', got 'widget'" in out
    assert any(line.startswith("projects/nokind") for line in out.splitlines())


def test_a_stage_is_required(capsys) -> None:
    with pytest.raises(SystemExit) as info:
        run_curate([])
    assert info.value.code == 2


def test_extract_and_ledger_are_not_stages_yet(capsys) -> None:
    for stage in ("extract", "ledger"):
        with pytest.raises(SystemExit):
            run_curate([stage])


def test_the_real_collector_is_only_built_when_git_is_wanted(monkeypatch, capsys) -> None:
    def boom():
        raise AssertionError("must not build the real collector under --no-git")

    monkeypatch.setattr(curate_cli, "real_git_collector", boom)
    assert run_curate(["inventory", "--path", FIXTURE.as_posix(), "--no-git"]) == EXIT_CLEAN


def test_the_top_level_cli_routes_curate(capsys) -> None:
    code = cli.main(["curate", "inventory", "--path", FIXTURE.as_posix(), "--no-git"])
    out, _ = capsys.readouterr()
    assert code == EXIT_CLEAN
    assert out.strip().splitlines()[-1] == "inventory: clean (3 collections)"


def test_nothing_from_an_env_file_is_printed(tmp_path: Path, capsys) -> None:
    env_file = tmp_path / "test.env"
    env_file.write_text(f"SOME_TOKEN={SECRET}\n", encoding="utf-8")
    code, out, err = run(["inventory", "--path", FIXTURE.as_posix(), "--env-file", env_file.as_posix(), "--json"], capsys)
    assert code == EXIT_CLEAN
    assert SECRET not in out and SECRET not in err
