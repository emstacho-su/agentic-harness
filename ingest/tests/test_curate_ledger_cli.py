"""Tests for ``uv run ingest curate ledger`` (curate/cli.py, R-C3), end to end on tmp vaults.

The judge is a :class:`FakeJudge`, the store an :class:`InMemoryCurateStore`
(or a double), the embedder a map; nothing reaches a model, a database or the
real vault.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

import pytest

from ingest import cli, envfile
from ingest.curate import cli as curate_cli
from ingest.curate.cli import run_curate
from ingest.curate.gitfacts import Commit, GitFacts
from ingest.curate.judge import FakeJudge, JudgeError
from ingest.curate.store_models import Extraction, InMemoryCurateStore
from ingest.errors import StoreError
from ingest.loaders.obsidian import split_frontmatter

from test_curate_ledger import MapEmbedder, angle, issue

SECRET = "s3cret-ledger-value"

HUB = """---
id: 'hub-demo'
title: 'demo'
collection: 'demo'
type: index
kind: project
repo: 'owner/demo'
---
# demo
"""

SESSION = """---
id: 'session-{stem}'
title: 'Title {stem}'
type: session
collection: 'demo'
session_id: '{stem}'
{date_line}
origin: 'cli'
captured_by: 'hook'
---
Body of {stem}.
"""


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


def add_note(root: Path, stem: str, date: str | None, collection: str = "demo") -> None:
    folder = root / "projects" / collection
    (folder / "sessions").mkdir(parents=True, exist_ok=True)
    if not (folder / f"{collection}.md").exists():
        (folder / f"{collection}.md").write_text(HUB.replace("demo", collection), encoding="utf-8")
    date_line = f"date: {date}" if date else "note: undated"
    text = SESSION.format(stem=stem, date_line=date_line).replace("'demo'", f"'{collection}'")
    (folder / "sessions" / f"{stem}.md").write_text(text, encoding="utf-8")


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    root = tmp_path / "vault"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / ".realm").write_text("projects", encoding="utf-8")
    add_note(root, "s1", "2026-09-01")
    add_note(root, "s2", "2026-09-02")
    add_note(root, "s3", "2026-09-03")
    return root


def seed(store, root: Path, items_by_stem: dict[str, list[dict]], collection: str = "demo") -> None:
    from ingest.curate.extract import extractor_version
    from ingest.curate.inventory import build_inventory

    inv = next(i for i in build_inventory(root, git_collector=None).collections
               if i.profile.collection == collection)
    for group in inv.sessions:
        record = group.session
        stem = Path(record.path).stem
        if stem in items_by_stem:
            store.put_extraction(Extraction(
                note_id=record.note_id, content_hash=record.content_hash, extractor_version=extractor_version(),
                collection=collection, note_path=record.path, result=tuple(items_by_stem[stem]),
            ))


class Collector:
    def __init__(self, facts: GitFacts | None = None) -> None:
        self.facts = facts or GitFacts((), (), ())
        self.calls = 0

    def __call__(self, repo_path, repo_slug):
        self.calls += 1
        return self.facts


class NoCallJudge:
    model = "never"

    def judge(self, prompt: str, schema: dict):
        raise AssertionError("must not call the judge")


class RefusingStore(InMemoryCurateStore):
    """Readable, but any write is a test failure."""

    def _refuse(self, *args, **kwargs):
        raise AssertionError("a dry run must not write to the store")

    create_issue = add_member = add_event = put_confirmation = _refuse

    def load(self, other: InMemoryCurateStore) -> "RefusingStore":
        for extraction in other._extractions.values():
            InMemoryCurateStore.put_extraction(self, extraction)
        return self


def clock(day: int = 27):
    return lambda: datetime(2026, 9, day, 4, 30, tzinfo=timezone.utc)


def run(vault: Path, argv: list[str], capsys, **kwargs) -> tuple[int, str, str]:
    kwargs.setdefault("git_collector", Collector())
    kwargs.setdefault("clock", clock())
    code = run_curate(["ledger", "--path", vault.as_posix(), *argv], **kwargs)
    out, err = capsys.readouterr()
    return code, out, err


def ledger_path(vault: Path) -> Path:
    return vault / "projects" / "demo" / "ledger.md"


def three_notes(store, vault: Path) -> MapEmbedder:
    seed(store, vault, {"s1": [issue("A", files=["store.py"])], "s2": [issue("B")],
                        "s3": [issue("A again", claim="fixed")]})
    return MapEmbedder({"A": [1, 0], "B": [0, 1], "A again": angle(0.9)})


# -- a run --------------------------------------------------------------------------------------


def test_a_run_writes_the_ledger_and_reports(vault: Path, capsys) -> None:
    store = InMemoryCurateStore()
    embedder = three_notes(store, vault)
    judge = FakeJudge([{"match": "C1"}])
    code, out, _ = run(vault, ["--collection", "demo"], capsys, store=store, judge=judge, embedder=embedder)
    assert code == 0
    fields, body = split_frontmatter(ledger_path(vault).read_text(encoding="utf-8"))
    assert fields["id"] == "curator-ledger-projects-demo"
    assert fields["type"] == "ledger" and fields["captured_by"] == "curator"
    assert fields["generated_at"] == "2026-09-27T04:30:00+00:00"
    assert "### ISSUE-demo-001 — A" in body and "### ISSUE-demo-002 — B" in body
    assert "[[projects/demo/sessions/s1\\|2026-09-01]]" in body
    assert "projects/demo: notes 3, extracted 3, not extracted yet 0, issue items 3" in out
    assert "new issues 2, new members 3, new events 3" in out
    assert "states: open 1, claimed-fixed 1, verified 0, regressed 0" in out
    assert "ledger: projects/demo/ledger.md written" in out
    assert out.strip().splitlines()[-1].startswith("ledger: 1 collection(s), judge calls 1")


def test_a_rerun_with_no_new_notes_changes_nothing_byte_for_byte(vault: Path, capsys) -> None:
    store = InMemoryCurateStore()
    embedder = three_notes(store, vault)
    run(vault, ["--collection", "demo"], capsys, store=store, judge=FakeJudge([{"match": "C1"}]), embedder=embedder)
    target = ledger_path(vault)
    before = target.read_bytes()
    os.utime(target, (1_000_000, 1_000_000))
    rows = (store.list_issues("demo"), store.members("demo"), store.events("demo"))
    judge = FakeJudge([])
    code, out, _ = run(vault, ["--collection", "demo"], capsys, store=store, judge=judge, embedder=embedder,
                       clock=clock(28))
    assert code == 0 and judge.calls == ()
    assert "new issues 0, new members 0, new events 0" in out
    assert "ledger: projects/demo/ledger.md unchanged" in out
    assert target.read_bytes() == before and target.stat().st_mtime == 1_000_000
    assert (store.list_issues("demo"), store.members("demo"), store.events("demo")) == rows


def test_a_new_note_rewrites_the_ledger_with_only_its_effects(vault: Path, capsys) -> None:
    store = InMemoryCurateStore()
    embedder = three_notes(store, vault)
    run(vault, ["--collection", "demo"], capsys, store=store, judge=FakeJudge([{"match": "C1"}]), embedder=embedder)
    before = ledger_path(vault).read_text(encoding="utf-8")
    add_note(vault, "s4", "2026-09-04")
    seed(store, vault, {"s4": [issue("C")]})
    code, out, _ = run(vault, ["--collection", "demo"], capsys, store=store, judge=FakeJudge([]), embedder=embedder)
    after = ledger_path(vault).read_text(encoding="utf-8")
    assert code == 0 and "new issues 1, new members 1, new events 1" in out
    assert "ISSUE-demo-003 — C" in after
    assert before.split("### ISSUE-demo-001", 1)[1].split("### ISSUE-demo-003")[0] in after


def test_git_facts_come_from_the_collector_unless_no_git(vault: Path, capsys) -> None:
    store = InMemoryCurateStore()
    embedder = three_notes(store, vault)
    facts = GitFacts((Commit("9" * 40, "2026-09-05T00:00:00Z", "fix: store", "fix", None, False,
                             ("ingest/store.py",), True),), (), ())
    collector = Collector(facts)
    code, out, _ = run(vault, ["--collection", "demo"], capsys, store=store, judge=FakeJudge([{"match": "C1"}]),
                       embedder=embedder, git_collector=collector)
    assert code == 0 and collector.calls == 1
    assert "| fix-commit |" in ledger_path(vault).read_text(encoding="utf-8")

    def boom():
        raise AssertionError("no collector under --no-git")

    other = InMemoryCurateStore()
    three_notes(other, vault)
    ledger_path(vault).unlink()
    idle = Collector(facts)
    code, _, _ = run(vault, ["--collection", "demo", "--no-git"], capsys, store=other,
                     judge=FakeJudge([{"match": "C1"}]), embedder=embedder, git_collector=idle)
    assert code == 0 and idle.calls == 0
    assert "| fix-commit |" not in ledger_path(vault).read_text(encoding="utf-8")


def test_not_extracted_notes_are_reported_with_the_way_forward(vault: Path, capsys) -> None:
    store = InMemoryCurateStore()
    seed(store, vault, {"s1": [issue("A")]})
    code, out, _ = run(vault, ["--collection", "demo"], capsys, store=store, judge=NoCallJudge(),
                       embedder=MapEmbedder())
    assert code == 0
    assert "not extracted yet 2" in out and "run curate extract" in out


def test_the_json_report(vault: Path, capsys) -> None:
    store = InMemoryCurateStore()
    embedder = three_notes(store, vault)
    code, out, _ = run(vault, ["--collection", "demo", "--json"], capsys, store=store,
                       judge=FakeJudge([{"match": "C1"}]), embedder=embedder)
    report = json.loads(out)
    assert code == 0 and report["exit_code"] == 0 and report["judge_calls"] == 1
    demo = report["collections"][0]
    assert demo["new_issues"] == ["ISSUE-demo-001", "ISSUE-demo-002"]
    assert demo["states"] == {"open": 1, "claimed-fixed": 1, "verified": 0, "regressed": 0}
    assert demo["ledger"] == {"path": "projects/demo/ledger.md", "written": True, "outcome": "written"}
    assert "A again" not in out  # summaries are note-derived; the report prints ids and counts only


def test_all_covers_every_collection(vault: Path, capsys) -> None:
    add_note(vault, "t1", "2026-09-01", collection="other")
    store = InMemoryCurateStore()
    seed(store, vault, {"s1": [issue("A")]})
    seed(store, vault, {"t1": [issue("A")]}, collection="other")
    code, out, _ = run(vault, ["--all"], capsys, store=store, judge=NoCallJudge(), embedder=MapEmbedder())
    assert code == 0
    assert (vault / "projects" / "other" / "ledger.md").is_file() and ledger_path(vault).is_file()
    assert [i.issue_id for i in store.list_issues("other")] == ["ISSUE-other-001"]


def test_collection_or_all_is_required(vault: Path, capsys) -> None:
    with pytest.raises(SystemExit) as info:
        run(vault, [], capsys)
    assert info.value.code == 2
    with pytest.raises(SystemExit):
        run(vault, ["--collection", "demo", "--all"], capsys)


# -- exit codes ---------------------------------------------------------------------------------


def test_the_budget_stop_exits_three_and_still_writes_what_is_known(vault: Path, capsys) -> None:
    store = InMemoryCurateStore()
    embedder = three_notes(store, vault)
    code, out, _ = run(vault, ["--collection", "demo", "--max-calls", "1", "--max-tokens", "5"], capsys,
                       store=store, judge=FakeJudge([]), embedder=embedder)
    assert code == 3
    assert "stopped by budget" in out and ledger_path(vault).is_file()


def test_items_that_cannot_be_placed_exit_one(vault: Path, capsys) -> None:
    add_note(vault, "undated", None)
    store = InMemoryCurateStore()
    seed(store, vault, {"undated": [issue("A")]})
    code, out, _ = run(vault, ["--collection", "demo"], capsys, store=store, judge=NoCallJudge(),
                       embedder=MapEmbedder())
    assert code == 1 and "unplaced: projects/demo/sessions/undated.md (note has no usable date)" in out


def test_a_judge_failure_exits_one(vault: Path, capsys) -> None:
    store = InMemoryCurateStore()
    embedder = three_notes(store, vault)
    code, out, _ = run(vault, ["--collection", "demo"], capsys, store=store, judge=FakeJudge([JudgeError("x")]),
                       embedder=embedder)
    assert code == 1 and "judge failed" in out


def test_an_unreachable_store_exits_two(vault: Path, capsys) -> None:
    def unreachable():
        raise StoreError("Could not connect to the database: refused")

    code, _, err = run(vault, ["--collection", "demo"], capsys, store_factory=unreachable, judge=NoCallJudge(),
                       embedder=MapEmbedder())
    assert code == 2 and "Could not connect" in err
    assert not ledger_path(vault).exists()


def test_a_hand_written_ledger_is_left_alone_and_exits_two(vault: Path, capsys) -> None:
    ledger_path(vault).write_text("---\ntitle: mine\n---\nMy notes.\n", encoding="utf-8")
    store = InMemoryCurateStore()
    seed(store, vault, {"s1": [issue("A")]})
    code, out, err = run(vault, ["--collection", "demo"], capsys, store=store, judge=NoCallJudge(),
                         embedder=MapEmbedder())
    assert code == 2 and "not written by the curator" in err
    assert ledger_path(vault).read_text(encoding="utf-8") == "---\ntitle: mine\n---\nMy notes.\n"


def test_a_bad_collection_exits_two(vault: Path, capsys) -> None:
    code, _, err = run(vault, ["--collection", "missing"], capsys, store=InMemoryCurateStore())
    assert code == 2 and "no collection 'missing'" in err


# -- the dry run --------------------------------------------------------------------------------


def test_the_dry_run_writes_nothing_and_asks_nothing(vault: Path, capsys) -> None:
    seeded = InMemoryCurateStore()
    embedder = three_notes(seeded, vault)
    store = RefusingStore().load(seeded)
    code, out, _ = run(vault, ["--collection", "demo", "--dry-run"], capsys, store=store, judge=NoCallJudge(),
                       embedder=embedder)
    assert code == 0
    assert not ledger_path(vault).exists()
    assert "would ask 1" in out and "new issues 2" in out
    assert "ledger: projects/demo/ledger.md not written (dry run)" in out
    assert store.list_issues("demo") == ()


def test_the_dry_run_never_builds_a_judge(vault: Path, capsys, monkeypatch) -> None:
    def boom(model):
        raise AssertionError("no judge in a dry run")

    monkeypatch.setattr(curate_cli, "real_judge", boom)
    seeded = InMemoryCurateStore()
    embedder = three_notes(seeded, vault)
    code, _, _ = run(vault, ["--collection", "demo", "--dry-run"], capsys, store=RefusingStore().load(seeded),
                     embedder=embedder)
    assert code == 0


def test_the_dry_run_with_no_store_says_so_and_exits_two(vault: Path, capsys) -> None:
    def unreachable():
        raise StoreError("Could not connect to the database: refused")

    code, _, err = run(vault, ["--collection", "demo", "--dry-run"], capsys, store_factory=unreachable,
                       embedder=MapEmbedder())
    assert code == 2 and "nothing to work from" in err


def test_the_top_level_cli_routes_ledger_and_needs_the_database(vault: Path, capsys) -> None:
    code = cli.main(["curate", "ledger", "--path", vault.as_posix(), "--collection", "demo", "--dry-run", "--no-git"])
    _, err = capsys.readouterr()
    assert code == 2 and "DATABASE_URL" in err


def test_no_env_file_value_is_ever_printed(vault: Path, tmp_path: Path, capsys) -> None:
    env = tmp_path / "test.env"
    env.write_text(f"SOME_TOKEN={SECRET}\n", encoding="utf-8")
    store = InMemoryCurateStore()
    embedder = three_notes(store, vault)
    code, out, err = run(vault, ["--collection", "demo", "--env-file", str(env), "--json"], capsys, store=store,
                         judge=FakeJudge([{"match": "C1"}]), embedder=embedder)
    assert code == 0 and SECRET not in out + err
