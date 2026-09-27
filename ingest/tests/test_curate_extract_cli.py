"""Tests for ``uv run ingest curate extract`` (curate/cli.py), end to end on the fixture vault.

The judge is always a :class:`FakeJudge` and the store an
:class:`InMemoryCurateStore` or a double; nothing reaches a model or a database.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Iterator

import pytest

from ingest import envfile
from ingest.curate import cli as curate_cli
from ingest.curate.cli import run_curate
from ingest.curate.extract import EXIT_BUDGET, EXIT_DONE, EXIT_FAILED, EXIT_UNAVAILABLE
from ingest.curate.judge import FakeJudge, JudgeError
from ingest.curate.store import InMemoryCurateStore
from ingest.errors import StoreError

FIXTURE = Path(__file__).parent / "fixtures" / "curate_vault"
SECRET = "s3cret-extract-value"
BLOCK = re.compile(r"<<<NOTE (N\d+) ([0-9a-f]+)>>>\n(.*?)\n<<<END NOTE \1 \2>>>", re.DOTALL)
DEMO_NOTES = 9  # 7 session notes, 1 note, 1 decision


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


def empty_answers(prompt: str, schema: dict) -> dict:
    """A well-formed answer with no items for every note in the prompt."""
    refs = [ref for ref, _, _ in BLOCK.findall(prompt)]
    return {"notes": [{"ref": ref, "issues": [], "decisions": [], "requirement_ids": [],
                       "status_claims": [], "open_questions": []} for ref in refs]}


class NoWriteStore(InMemoryCurateStore):
    """A store that may be read but refuses every write."""

    def put_extraction(self, extraction) -> None:
        raise AssertionError("a dry run must not write")


class NoCallJudge:
    model = "never"

    def judge(self, prompt: str, schema: dict):
        raise AssertionError("a dry run must not call the judge")


def run(argv: list[str], capsys, **kwargs) -> tuple[int, str, str]:
    code = run_curate(["extract", "--path", FIXTURE.as_posix(), *argv], **kwargs)
    out, err = capsys.readouterr()
    return code, out, err


def test_a_run_extracts_every_note_of_the_collection(capsys) -> None:
    judge, store = FakeJudge(empty_answers), InMemoryCurateStore()
    code, out, _ = run(["--collection", "demo"], capsys, judge=judge, store=store)
    assert code == EXIT_DONE
    assert sum(len(BLOCK.findall(call.prompt)) for call in judge.calls) == DEMO_NOTES
    assert f"projects/demo (project): notes {DEMO_NOTES}, cache hits 0, pending {DEMO_NOTES}" in out
    assert f"extracted {DEMO_NOTES}" in out and "calls 2," in out
    assert "cost_usd n/a" in out
    code, out, _ = run(["--collection", "demo"], capsys, judge=FakeJudge([]), store=store)
    assert code == EXIT_DONE and f"cache hits {DEMO_NOTES}, pending 0" in out


def test_all_covers_every_collection_and_the_class_rubric(capsys) -> None:
    judge = FakeJudge(empty_answers)
    code, out, _ = run(["--all"], capsys, judge=judge, store=InMemoryCurateStore())
    assert code == EXIT_DONE
    assert "classes/ist999 (class)" in out and "projects/nokind (project)" in out
    class_calls = [c for c in judge.calls if "misconception" in json.dumps(c.schema)]
    assert len(class_calls) == 1


def test_collection_or_all_is_required(capsys) -> None:
    with pytest.raises(SystemExit) as info:
        run([], capsys)
    assert info.value.code == 2
    with pytest.raises(SystemExit):
        run(["--collection", "demo", "--all"], capsys)


@pytest.mark.parametrize("flag", ["--max-calls", "--max-tokens"])
def test_a_non_positive_budget_is_refused(flag: str, capsys) -> None:
    with pytest.raises(SystemExit) as info:
        run(["--collection", "demo", flag, "0"], capsys)
    assert info.value.code == 2


def test_a_bad_collection_exits_two(capsys) -> None:
    code, _, err = run(["--collection", "missing"], capsys, judge=FakeJudge([]), store=InMemoryCurateStore())
    assert code == EXIT_UNAVAILABLE and "no collection 'missing'" in err


def test_the_dry_run_plans_without_calling_or_writing(capsys) -> None:
    code, out, _ = run(["--collection", "demo", "--dry-run"], capsys, judge=NoCallJudge(), store=NoWriteStore())
    assert code == EXIT_DONE
    assert f"notes {DEMO_NOTES}, cache hits 0, pending {DEMO_NOTES}, skipped too large 0" in out
    assert re.search(r"  batch 1: 8 notes, ~\d+ input tokens", out)
    assert re.search(r"  batch 2: 1 notes, ~\d+ input tokens", out)
    assert re.search(r"dry run: 2 calls, ~\d+ estimated tokens .*: fits", out)


def test_the_dry_run_counts_cache_hits(capsys) -> None:
    store = InMemoryCurateStore()
    run(["--collection", "demo"], capsys, judge=FakeJudge(empty_answers), store=store)
    code, out, _ = run(["--collection", "demo", "--dry-run"], capsys, judge=NoCallJudge(), store=store)
    assert code == EXIT_DONE and "dry run: 0 calls" in out and f"cache hits {DEMO_NOTES}, pending 0" in out


def test_the_dry_run_says_when_the_budget_would_not_fit(capsys) -> None:
    code, out, _ = run(["--collection", "demo", "--dry-run", "--max-calls", "1"], capsys, store=NoWriteStore())
    assert code == EXIT_DONE and "does not fit" in out


def test_the_dry_run_without_database_settings_plans_everything_as_a_miss(capsys) -> None:
    code, out, err = run(["--collection", "demo", "--dry-run"], capsys)
    assert code == EXIT_DONE
    assert "DATABASE_URL" in err and "every note is planned as a miss" in err
    assert f"cache hits 0, pending {DEMO_NOTES}" in out


def test_the_dry_run_with_an_unreachable_store_still_plans(capsys) -> None:
    def unreachable():
        raise StoreError("Could not connect to the database: timeout")

    code, out, err = run(["--collection", "demo", "--dry-run"], capsys, store_factory=unreachable)
    assert code == EXIT_DONE and "Could not connect" in err and "dry run: 2 calls" in out


def test_the_dry_run_survives_a_failing_cache_lookup(capsys) -> None:
    class BrokenLookup(NoWriteStore):
        def get_extractions(self, keys):
            raise StoreError('relation "curate.extractions" does not exist')

    code, out, err = run(["--collection", "demo", "--dry-run"], capsys, store=BrokenLookup())
    assert code == EXIT_DONE and "curate.extractions" in err and f"pending {DEMO_NOTES}" in out


def test_a_live_run_without_a_store_exits_two(capsys) -> None:
    code, _, err = run(["--collection", "demo"], capsys, judge=FakeJudge([]))
    assert code == EXIT_UNAVAILABLE and "DATABASE_URL" in err


def test_the_budget_stop_exits_three(capsys) -> None:
    code, out, _ = run(["--collection", "demo", "--max-calls", "1"], capsys,
                       judge=FakeJudge(empty_answers), store=InMemoryCurateStore())
    assert code == EXIT_BUDGET
    assert "stopped by budget: extracted 8 of 9 pending notes in 1 calls" in out


def test_failed_batches_exit_one(capsys) -> None:
    code, out, _ = run(["--collection", "demo"], capsys,
                       judge=FakeJudge([JudgeError("boom"), JudgeError("boom")]), store=InMemoryCurateStore())
    assert code == EXIT_FAILED
    assert "stopped after 2 consecutive failed batches" in out
    assert "failed: projects/demo/sessions/bbbb2222.md: batch failed: boom" in out


def test_json_output_carries_the_report(capsys) -> None:
    code, out, _ = run(["--collection", "demo", "--json"], capsys,
                       judge=FakeJudge(empty_answers), store=InMemoryCurateStore())
    report = json.loads(out)
    assert code == EXIT_DONE and report["extracted"] == DEMO_NOTES and report["exit_code"] == EXIT_DONE
    assert report["collections"][0]["collection"] == "demo" and report["calls"] == 2
    assert report["version"].startswith("c2-v1+")


def test_the_real_judge_is_built_lazily_with_the_model(monkeypatch, capsys) -> None:
    built: list[str] = []

    def fake_real_judge(model: str):
        built.append(model)
        return FakeJudge(empty_answers)

    monkeypatch.setattr(curate_cli, "real_judge", fake_real_judge)
    store = InMemoryCurateStore()
    assert run(["--collection", "demo", "--model", "claude-test"], capsys, store=store)[0] == EXIT_DONE
    assert built == ["claude-test"]
    assert run(["--collection", "demo"], capsys, store=store)[0] == EXIT_DONE
    assert built == ["claude-test"]  # nothing pending: no judge built


def test_nothing_from_an_env_file_is_printed(tmp_path: Path, capsys) -> None:
    env_file = tmp_path / "test.env"
    env_file.write_text(f"SOME_TOKEN={SECRET}\n", encoding="utf-8")
    code, out, err = run(["--collection", "demo", "--dry-run", "--env-file", env_file.as_posix()], capsys)
    assert code == EXIT_DONE and SECRET not in out and SECRET not in err


def test_real_judge_builds_the_claude_backend_without_running_it() -> None:
    from ingest.curate.claude_cli import ClaudeCliJudge

    judge = curate_cli.real_judge("claude-test")
    assert isinstance(judge, ClaudeCliJudge) and judge.model == "claude-test"
