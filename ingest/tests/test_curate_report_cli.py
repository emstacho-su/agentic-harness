"""Tests for ``uv run ingest curate report`` (curate/report_cli.py, report_run.py; R-C6/R-C7),
end to end on tmp vaults.

The judge is a :class:`FakeJudge`, the store an :class:`InMemoryCurateStore`, the
embedder a :class:`FakeEmbedder`, retrieval counts a :class:`DictRetrievalCounts`
and git a fake collector: nothing reaches a model, a database, git or the real vault.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

import pytest

from conftest import FakeEmbedder
from ingest import envfile
from ingest.curate import report_cli
from ingest.curate.cli import STAGES, build_curate_parser, run_curate
from ingest.curate.extract import extractor_version
from ingest.curate.gitfacts import GitFacts
from ingest.curate.inventory import build_inventory
from ingest.curate.judge import FakeJudge, JudgeError
from ingest.curate.retrieval_counts import DictRetrievalCounts
from ingest.curate.scores import scorer_version
from ingest.curate.store_models import Extraction, InMemoryCurateStore
from ingest.errors import StoreError
from ingest.loaders.obsidian import split_frontmatter

SECRET_TEXT = "private-body-text-7f3a"
LONG = f"{SECRET_TEXT} " + "A long body. " * 60

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
SHORT = "note-short"
KEEPER = "note-keeper"


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


def note(note_id: str, when: str, body: str, extra: str = "") -> str:
    return (f"---\nid: '{note_id}'\ntitle: 'Title of {note_id}'\ntype: session\ncollection: 'demo'\n"
            f"started_at: '{when}'\n{extra}---\n{body}\n")


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    root = tmp_path / "vault"
    demo = root / "projects" / "demo"
    (demo / "sessions").mkdir(parents=True)
    (demo / "notes").mkdir()
    (root / "projects" / ".realm").write_text("projects", encoding="utf-8")
    (demo / "demo.md").write_text(HUB, encoding="utf-8")
    files = {
        "sessions/aaaa1111.md": note(PARENT, "2026-09-20T10:00:00Z", LONG),
        "sessions/aaaa1111--agent1.md": note(CHILD, "2026-09-20T11:00:00Z", LONG, "parent_session: 'aaaa1111'\n"),
        "notes/short.md": note(SHORT, "2026-09-23T00:00:00Z", f"{SECRET_TEXT} tiny."),
        "notes/keeper.md": note(KEEPER, "2026-09-24T00:00:00Z", LONG),
    }
    for relative, text in files.items():
        (demo / relative).write_text(text, encoding="utf-8")
    return root


def seeded(root: Path, items: dict[str, list[dict]] | None = None, store=None) -> InMemoryCurateStore:
    """A store holding every note's extraction at the current extractor version."""
    store = store if store is not None else InMemoryCurateStore()
    inv = build_inventory(root, git_collector=None).collections[0]
    records = [r for g in inv.sessions for r in (g.session, *g.subagents)] + list(inv.notes)
    for record in records:
        store.put_extraction(Extraction(
            note_id=record.note_id, content_hash=record.content_hash, extractor_version=extractor_version(),
            collection="demo", note_path=record.path, result=tuple((items or {}).get(record.note_id, ()))))
    return store


class Collector:
    def __call__(self, repo_path, repo_slug):
        return GitFacts((), (), ())


class RefusingStore(InMemoryCurateStore):
    """Once ``refusing`` is set, a score, proposal or decision write is a test failure."""

    refusing = False

    def _refuse(self, what: str) -> None:
        if self.refusing:
            raise AssertionError(f"a dry run must not write {what} to the store")

    def put_proposal(self, proposal) -> bool:
        self._refuse("proposals")
        return super().put_proposal(proposal)

    def record_decision(self, decision) -> bool:
        self._refuse("decisions")
        return super().record_decision(decision)

    def put_note_score(self, score) -> bool:
        self._refuse("scores")
        return super().put_note_score(score)


def clock(day: int = 27):
    return lambda: datetime(2026, 9, day, 4, 30, tzinfo=timezone.utc)


def run(vault: Path, argv: list[str], capsys, *, store, day: int = 27, judge=None, counts=None,
        **kwargs) -> tuple[int, str, str]:
    """The stage's run() itself, so the retrieval counts can be injected."""
    args = build_curate_parser().parse_args(["report", "--path", vault.as_posix(), *argv])
    code = report_cli.run(
        args, git_collector=kwargs.pop("git_collector", Collector()), runner=kwargs.pop("runner", None),
        judge=judge or FakeJudge([]), store=store, store_factory=kwargs.pop("store_factory", None),
        embedder=FakeEmbedder(), clock=clock(day),
        retrieval_counts=counts if counts is not None else DictRetrievalCounts({KEEPER: (3, 1)}), **kwargs)
    out, err = capsys.readouterr()
    return code, out, err


def report_path(vault: Path, day: str = "2026-09-27") -> Path:
    return vault / "projects" / "curation" / f"{day}.md"


def tick(path: Path, action: str, note_id: str) -> None:
    text = path.read_text(encoding="utf-8")
    line = f"- [ ] {action} `{note_id}` "
    assert line in text
    path.write_text(text.replace(line, f"- [x] {action} `{note_id}` "), encoding="utf-8")


# -- the stage ----------------------------------------------------------------------------------


def test_the_stage_is_registered_with_its_flags() -> None:
    assert "report" in STAGES
    args = build_curate_parser().parse_args(
        ["report", "--path", "v", "--all", "--collection", "demo", "--model", "m", "--max-calls", "3",
         "--max-tokens", "9", "--no-git", "--dry-run", "--json", "--env-file", "e", "-v"])
    assert (args.stage, args.all, args.collection, args.model, args.max_calls, args.max_tokens) == (
        "report", True, "demo", "m", 3, 9)
    assert args.no_git and args.dry_run and args.json and args.verbose
    assert build_curate_parser().parse_args(["report", "--path", "v", "--realm", "projects"]).realm == "projects"


@pytest.mark.parametrize("argv", [[], ["--realm", "projects", "--all"]])
def test_realm_or_all_is_required(argv: list[str]) -> None:
    with pytest.raises(SystemExit):
        build_curate_parser().parse_args(["report", "--path", "v", *argv])


def test_a_dry_run_writes_nothing_and_records_nothing(vault: Path, capsys) -> None:
    store = seeded(vault, store=RefusingStore())
    run(vault, ["--all"], capsys, store=store)  # a live run first, so there is a report to tick
    tick(report_path(vault), "prune", SHORT)
    before = report_path(vault).read_bytes()
    store.refusing = True
    code, out, err = run(vault, ["--all", "--dry-run"], capsys, store=store, day=27)
    assert code == 0, err
    assert store.decisions("projects") == ()
    assert report_path(vault).read_bytes() == before
    assert "report dry run" in out
    assert "projects: report files read 1, ignored 0; decisions recorded 1, ticks ignored 0" in out
    assert "report: projects/curation/2026-09-27.md not written (dry run)" in out


def test_a_dry_run_on_a_fresh_store_creates_no_folder(vault: Path, capsys) -> None:
    code, out, err = run(vault, ["--all", "--dry-run"], capsys, store=seeded(vault))
    assert code == 0, err
    assert not (vault / "projects" / "curation").exists()
    assert "projects/demo: notes scored 4, would ask 0; candidates condense 1, prune 1" in out


def test_a_live_run_writes_the_report(vault: Path, capsys) -> None:
    store = seeded(vault)
    code, out, err = run(vault, ["--all"], capsys, store=store)
    assert code == 0, err
    fields, body = split_frontmatter(report_path(vault).read_text(encoding="utf-8"))
    assert fields["captured_by"] == "curator" and fields["type"] == "curation-report"
    assert fields["id"] == "curator-curation-projects-2026-09-27" and fields["realm"] == "projects"
    assert fields["scorer_version"] == scorer_version()
    assert fields["generated_at"] == "2026-09-27T04:30:00+00:00"
    assert f"- [ ] condense `{CHILD}` [[projects/demo/sessions/aaaa1111--agent1|2026-09-20]] — " in body
    assert f"- [ ] prune `{SHORT}` [[projects/demo/notes/short|2026-09-23]] — " in body
    assert KEEPER not in body.split("## Scores")[0]  # retrieved three times: kept
    assert [(p.note_id, p.action) for p in store.proposals("projects")] == [(CHILD, "condense"), (SHORT, "prune")]
    assert "report: projects/curation/2026-09-27.md written" in out
    assert SECRET_TEXT not in out and SECRET_TEXT not in err and SECRET_TEXT not in body


def test_a_rerun_with_the_same_inputs_is_unchanged(vault: Path, capsys) -> None:
    store = seeded(vault)
    run(vault, ["--all"], capsys, store=store)
    target = report_path(vault)
    before = target.read_bytes()
    os.utime(target, (1_000_000, 1_000_000))
    code, out, _ = run(vault, ["--all"], capsys, store=store)
    assert code == 0
    assert "decisions recorded 0" in out
    assert "report: projects/curation/2026-09-27.md unchanged" in out
    assert target.read_bytes() == before and target.stat().st_mtime == 1_000_000
    assert store.decisions("projects") == ()


def test_a_ticked_box_is_recorded_on_the_next_run(vault: Path, capsys) -> None:
    store = seeded(vault)
    run(vault, ["--all"], capsys, store=store)
    tick(report_path(vault), "prune", SHORT)
    code, out, _ = run(vault, ["--all"], capsys, store=store)
    assert code == 0
    assert "decisions recorded 1" in out
    (only,) = store.decisions("projects")
    assert (only.report_day, only.note_id, only.action, only.accepted) == ("2026-09-27", SHORT, "prune", True)
    text = report_path(vault).read_text(encoding="utf-8")
    assert f"- [x] prune `{SHORT}` " in text  # the rewrite keeps the tick
    assert "| 2026-09-27 (open) | 1 | 1 | 0 | 0 | 100% | yes |" not in text  # decided: no longer open
    assert "| 2026-09-27 | 1 | 1 | 0 | 0 | 100% | yes |" in text
    code, out, _ = run(vault, ["--all"], capsys, store=store)
    assert "decisions recorded 0" in out and len(store.decisions("projects")) == 1


def test_an_unticked_box_on_an_older_report_is_a_rejection(vault: Path, capsys) -> None:
    store = seeded(vault)
    run(vault, ["--all"], capsys, store=store, day=20)
    tick(report_path(vault, "2026-09-20"), "prune", SHORT)
    code, out, _ = run(vault, ["--all"], capsys, store=store, day=27)
    assert code == 0 and "decisions recorded 2" in out
    assert store.latest_decisions("projects", "2026-09-20") == {(SHORT, "prune"): True, (CHILD, "condense"): False}
    text = report_path(vault).read_text(encoding="utf-8")
    assert "| 2026-09-20 | 1 | 0 | 1 | 0 | 0% | yes |" in text
    assert "| 2026-09-27 (open) | 1 | 0 | 0 | 1 | 0% | yes |" in text
    assert report_path(vault, "2026-09-20").read_text(encoding="utf-8").count("- [x]") == 1  # never rewritten


def test_a_tick_for_an_unknown_note_is_ignored(vault: Path, capsys) -> None:
    store = seeded(vault)
    run(vault, ["--all"], capsys, store=store)
    target = report_path(vault)
    target.write_text(target.read_text(encoding="utf-8") + "- [x] prune `made-up-id` — forged\n"
                      f"- [x] condense `{SHORT}` — the wrong action\n", encoding="utf-8")
    code, out, _ = run(vault, ["--all"], capsys, store=store)
    assert code == 0
    assert "decisions recorded 0, ticks ignored 2" in out
    assert store.decisions("projects") == ()


def test_a_hand_written_file_in_curation_is_ignored_and_left_alone(vault: Path, capsys) -> None:
    store = seeded(vault)
    run(vault, ["--all"], capsys, store=store, day=20)
    mine = report_path(vault, "2026-09-21")
    mine.write_text(f"---\ntitle: my notes\n---\n- [x] prune `{SHORT}` — mine\n", encoding="utf-8")
    loose = vault / "projects" / "curation" / "ideas.md"
    loose.write_text("---\ncaptured_by: curator\ntype: curation-report\n---\n- [x] prune `x` y\n", encoding="utf-8")
    before = mine.read_bytes()
    code, out, _ = run(vault, ["--all"], capsys, store=store, day=27)
    assert code == 0
    assert "report files read 1, ignored 2" in out
    assert mine.read_bytes() == before
    assert all(d.report_day == "2026-09-20" for d in store.decisions("projects"))


def test_a_hand_written_file_on_the_report_date_is_refused(vault: Path, capsys) -> None:
    target = report_path(vault)
    target.parent.mkdir(parents=True)
    target.write_text("---\ntitle: mine\n---\nhands off\n", encoding="utf-8")
    code, _, err = run(vault, ["--all"], capsys, store=seeded(vault))
    assert code == 2 and "not written by the curator" in err
    assert target.read_text(encoding="utf-8") == "---\ntitle: mine\n---\nhands off\n"


def test_the_json_report_has_counts_and_ids_only(vault: Path, capsys) -> None:
    code, out, _ = run(vault, ["--all", "--json"], capsys, store=seeded(vault))
    report = json.loads(out)
    assert code == 0 and report["exit_code"] == 0
    assert set(report) == {"version", "dry_run", "realms", "retrieval_counts", "judge_calls", "tokens", "stopped",
                           "exit_code"}
    assert report["version"] == scorer_version() and report["retrieval_counts"] == "available"
    (realm,) = report["realms"]
    assert realm == {
        "realm_folder": "projects",
        "reports_read": 0, "reports_ignored": 0, "decisions_recorded": 0, "ticks_ignored": 0,
        "collections": [{
            "folder": "projects/demo", "collection": "demo", "scored": 4, "scores_written": 4, "would_ask": 0,
            "judge_calls": 0, "left": 0, "not_extracted": 0, "problems": [],
            "candidates": {"condense": [CHILD], "prune": [SHORT]}, "new_proposals": 2,
        }],
        "modes": {"condense": {"mode": "proposals", "streak": 0}, "prune": {"mode": "proposals", "streak": 0}},
        "report": {"path": "projects/curation/2026-09-27.md", "written": True, "outcome": "written"},
    }
    assert SECRET_TEXT not in out


def test_an_unreachable_store_cannot_run(vault: Path, capsys) -> None:
    def unreachable():
        raise StoreError("database unreachable")

    code, _, err = run(vault, ["--all", "--dry-run"], capsys, store=None, store_factory=unreachable)
    assert code == 2 and "database unreachable" in err


def test_without_retrieval_counts_the_run_warns_and_goes_on(vault: Path, capsys) -> None:
    code = run_curate(["report", "--path", vault.as_posix(), "--all", "--json"], git_collector=Collector(),
                      judge=FakeJudge([]), store=seeded(vault), embedder=FakeEmbedder(), clock=clock())
    out, err = capsys.readouterr()
    assert code == 0
    assert json.loads(out)["retrieval_counts"] == "unavailable"
    assert "retrieval counts unavailable" in err and "DATABASE_URL" in err


def test_the_collection_filter_and_an_unknown_realm(vault: Path, capsys) -> None:
    code, out, _ = run(vault, ["--realm", "projects", "--collection", "demo", "--dry-run"], capsys, store=seeded(vault))
    assert code == 0 and "projects/demo:" in out
    code, _, err = run(vault, ["--realm", "nowhere"], capsys, store=seeded(vault))
    assert code == 2 and "error" in err


def thinking_items() -> dict[str, list[dict]]:
    """Three decisions and no activity: the features disagree, so the judge is asked."""
    decisions = [{"type": "decision", "summary": f"d{n}", "evidence": "e" * 12} for n in range(3)]
    return {SHORT: decisions, KEEPER: decisions}


def test_a_failing_importance_call_exits_1(vault: Path, capsys) -> None:
    store = seeded(vault, thinking_items())
    code, out, _ = run(vault, ["--all"], capsys, store=store, judge=FakeJudge([JudgeError("down"), JudgeError("down")]))
    assert code == 1
    assert "stopped after 2 consecutive judge failures" in out.splitlines()[-1]


def test_a_budget_stop_exits_3(vault: Path, capsys) -> None:
    store = seeded(vault, thinking_items())
    code, out, _ = run(vault, ["--all", "--max-calls", "1"], capsys, store=store,
                       judge=FakeJudge([{"importance": 6}]))
    assert code == 3
    assert "stopped by budget" in out.splitlines()[-1]
    assert report_path(vault).exists()
