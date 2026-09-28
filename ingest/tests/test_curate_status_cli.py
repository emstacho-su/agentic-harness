"""Tests for ``uv run ingest curate status`` (curate/status_cli.py, R-C4), end to end on tmp vaults.

The store is an :class:`InMemoryCurateStore` holding hand-built extractions, git
facts come from a fake collector, and the plan is a file under ``tmp_path``;
nothing reaches a model, a database, git or the real vault.
"""

from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

import pytest

from ingest import cli, envfile
from ingest.curate import cli as curate_cli
from ingest.curate.cli import build_curate_parser, run_curate
from ingest.curate.extract import extractor_version
from ingest.curate.gitfacts import Commit, GitFacts
from ingest.curate.inventory import build_inventory
from ingest.curate.store_models import Extraction, InMemoryCurateStore
from ingest.errors import StoreError
from ingest.loaders.obsidian import split_frontmatter

FIXTURE = Path(__file__).parent / "fixtures" / "curate_vault"
SECRET = "s3cret-status-value"

HUB = """---
id: 'hub-demo'
title: 'demo'
collection: 'demo'
type: index
kind: project
repo: 'owner/demo'
plan_sources:
{sources}
---
# demo
"""

SESSION = """---
id: 'session-{stem}'
title: 'Title {stem}'
type: session
collection: 'demo'
session_id: '{stem}'
date: {date}
origin: 'cli'
captured_by: 'hook'
---
Body of {stem}.
"""

PLAN = """# Demo plan

## Phase A — first

### R-A1 Build the parser
- [x] parser written

### R-A2 Write the store
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


def make_vault(tmp_path: Path, sources: list[str], collection: str = "demo") -> Path:
    root = tmp_path / "vault"
    folder = root / "projects" / collection
    (folder / "sessions").mkdir(parents=True, exist_ok=True)
    (root / "projects" / ".realm").write_text("projects", encoding="utf-8")
    listed = "\n".join(f"  - '{source}'" for source in sources)
    (folder / f"{collection}.md").write_text(HUB.format(sources=listed).replace("demo", collection), encoding="utf-8")
    for stem, date in (("s1", "2026-09-01"), ("s2", "2026-09-02")):
        text = SESSION.format(stem=stem, date=date).replace("'demo'", f"'{collection}'")
        (folder / "sessions" / f"{stem}.md").write_text(text, encoding="utf-8")
    return root


@pytest.fixture
def plan_file(tmp_path: Path) -> Path:
    path = tmp_path / "repo" / "docs" / "plan.md"
    path.parent.mkdir(parents=True)
    path.write_text(PLAN, encoding="utf-8")
    return path


@pytest.fixture
def vault(tmp_path: Path, plan_file: Path) -> Path:
    return make_vault(tmp_path, [plan_file.as_posix()])


def seed(store: InMemoryCurateStore, root: Path, items: dict[str, list[dict]], collection: str = "demo") -> None:
    inv = next(i for i in build_inventory(root, git_collector=None).collections
               if i.profile.collection == collection)
    for group in inv.sessions:
        stem = Path(group.session.path).stem
        if stem in items:
            store.put_extraction(Extraction(
                note_id=group.session.note_id, content_hash=group.session.content_hash,
                extractor_version=extractor_version(), collection=collection, note_path=group.session.path,
                result=tuple(items[stem]),
            ))


def claim(rid: str, state: str, text: str) -> dict:
    return {"type": "status_claim", "requirement_id": rid, "state": state, "claim": text,
            "evidence": f"quote about {text}"}


class Collector:
    def __init__(self, facts: GitFacts | None = None) -> None:
        self.facts = facts or GitFacts((), (), ())
        self.calls = 0

    def __call__(self, repo_path, repo_slug):
        self.calls += 1
        return self.facts


def clock(day: int = 27):
    return lambda: datetime(2026, 9, day, 4, 30, tzinfo=timezone.utc)


def run(vault: Path, argv: list[str], capsys, **kwargs) -> tuple[int, str, str]:
    kwargs.setdefault("git_collector", Collector())
    kwargs.setdefault("clock", clock())
    code = run_curate(["status", "--path", vault.as_posix(), *argv], **kwargs)
    out, err = capsys.readouterr()
    return code, out, err


def status_path(vault: Path, collection: str = "demo") -> Path:
    return vault / "projects" / collection / "status.md"


# -- a run --------------------------------------------------------------------------------------


def test_a_run_writes_status_md_and_reports(vault: Path, capsys) -> None:
    store = InMemoryCurateStore()
    seed(store, vault, {"s1": [claim("R-A2", "in-progress", "store half written")]})
    code, out, err = run(vault, ["--collection", "demo"], capsys, store=store)
    assert code == 0, err
    fields, body = split_frontmatter(status_path(vault).read_text(encoding="utf-8"))
    assert fields == {
        "id": "curator-status-projects-demo", "title": "demo status", "type": "status", "captured_by": "curator",
        "collection": "demo", "generated_at": "2026-09-27T04:30:00+00:00", "extractor_version": extractor_version(),
    }
    assert body.lstrip("\n").startswith("# demo status\n")
    assert "| R-A1 Build the parser | claimed done |" in body
    assert "| R-A2 Write the store | in progress | in-progress: store half written" in body
    assert (f"projects/demo: requirements 2 (not started 0, in progress 1, claimed done 1, verified 0, "
            f"contradicted 0); plan sources found 1, missing 0, id collisions 0; notes 2, extracted 1") in out
    assert "    status: projects/demo/status.md written" in out
    assert out.strip().splitlines()[-1] == "status: 1 collection(s), exit 0"
    assert "store half written" not in out  # claim texts are note-derived; the report prints ids and counts


def test_a_rerun_with_nothing_new_leaves_the_file_unchanged(vault: Path, capsys) -> None:
    store = InMemoryCurateStore()
    seed(store, vault, {"s1": [claim("R-A2", "done", "store written")]})
    run(vault, ["--collection", "demo"], capsys, store=store)
    target = status_path(vault)
    before = target.read_bytes()
    os.utime(target, (1_000_000, 1_000_000))
    code, out, _ = run(vault, ["--collection", "demo"], capsys, store=store, clock=clock(28))
    assert code == 0 and "status: projects/demo/status.md unchanged" in out
    assert target.read_bytes() == before and target.stat().st_mtime == 1_000_000


def test_git_facts_come_from_the_collector_unless_no_git(vault: Path, capsys) -> None:
    facts = GitFacts((Commit("9" * 40, "2026-09-05T00:00:00Z", "feat: R-A1 parser", "feat", None, False, (), True),),
                     (), ())
    collector = Collector(facts)
    code, out, _ = run(vault, ["--collection", "demo"], capsys, store=InMemoryCurateStore(), git_collector=collector)
    assert code == 0 and collector.calls == 1
    assert "| R-A1 Build the parser | verified |" in status_path(vault).read_text(encoding="utf-8")

    idle = Collector(facts)
    code, _, _ = run(vault, ["--collection", "demo", "--no-git"], capsys, store=InMemoryCurateStore(),
                     git_collector=idle)
    assert code == 0 and idle.calls == 0
    assert "| R-A1 Build the parser | claimed done |" in status_path(vault).read_text(encoding="utf-8")


def test_the_json_report(vault: Path, capsys) -> None:
    store = InMemoryCurateStore()
    seed(store, vault, {"s1": [claim("R-A1", "broken", "parser broke")]})
    code, out, _ = run(vault, ["--collection", "demo", "--json"], capsys, store=store)
    report = json.loads(out)
    assert code == 1 and report["exit_code"] == 1
    assert report["version"] == extractor_version() and report["dry_run"] is False
    demo = report["collections"][0]
    assert demo == {
        "folder": "projects/demo", "collection": "demo", "notes": 2, "extracted": 1, "requirements": 2,
        "states": {"not started": 1, "in progress": 0, "claimed done": 0, "verified": 0, "contradicted": 1},
        "contradicted": ["R-A1"],
        "plan_sources": {"found": 1, "missing": 0, "problems": [], "id_collisions": []},
        "status": {"path": "projects/demo/status.md", "written": True, "outcome": "written"},
    }
    assert "parser broke" not in out


def test_all_covers_every_collection(tmp_path: Path, plan_file: Path, capsys) -> None:
    vault = make_vault(tmp_path, [plan_file.as_posix()])
    make_vault(tmp_path, [plan_file.as_posix()], collection="other")
    code, out, _ = run(vault, ["--all"], capsys, store=InMemoryCurateStore())
    assert code == 0 and status_path(vault).is_file() and status_path(vault, "other").is_file()
    assert "status: 2 collection(s), exit 0" in out


def test_collection_or_all_is_required_and_there_is_no_judge_flag(vault: Path, capsys) -> None:
    for argv in ([], ["--collection", "demo", "--all"], ["--collection", "demo", "--model", "x"],
                 ["--collection", "demo", "--max-calls", "3"]):
        with pytest.raises(SystemExit) as info:
            run(vault, argv, capsys)
        assert info.value.code == 2


def test_the_stage_is_wired_into_the_curate_parser() -> None:
    assert "status" in curate_cli.STAGES
    args = build_curate_parser().parse_args(["status", "--path", "v", "--all", "--dry-run", "--json", "--no-git"])
    assert (args.stage, args.all, args.dry_run, args.json, args.no_git) == ("status", True, True, True, True)


# -- exit codes ---------------------------------------------------------------------------------


def test_a_contradicted_requirement_exits_one(vault: Path, capsys) -> None:
    store = InMemoryCurateStore()
    seed(store, vault, {"s2": [claim("R-A1", "broken", "parser broke")]})
    code, out, _ = run(vault, ["--collection", "demo"], capsys, store=store)
    assert code == 1
    assert "    contradicted: R-A1" in out and status_path(vault).is_file()


def test_a_missing_plan_source_exits_one(tmp_path: Path, plan_file: Path, capsys) -> None:
    vault = make_vault(tmp_path, [plan_file.as_posix(), (tmp_path / "gone.md").as_posix()])
    code, out, _ = run(vault, ["--collection", "demo"], capsys, store=InMemoryCurateStore())
    assert code == 1
    assert "plan sources found 1, missing 1" in out
    assert f"    plan source problem: {(tmp_path / 'gone.md').as_posix()} (not found)" in out
    assert "gone.md: not found" in status_path(vault).read_text(encoding="utf-8")


def test_an_id_collision_across_plan_sources_exits_one(tmp_path: Path, plan_file: Path, capsys) -> None:
    other = tmp_path / "repo" / "docs" / "other.md"
    other.write_text("# Other\n\n### R-A2 Store again\n- [x] store shipped\n", encoding="utf-8")
    vault = make_vault(tmp_path, [plan_file.as_posix(), other.as_posix()])
    code, out, _ = run(vault, ["--collection", "demo"], capsys, store=InMemoryCurateStore())
    assert code == 1
    assert "id collisions 1" in out
    assert f"    id collision: R-A2 kept from {plan_file.as_posix()} (Write the store); " \
           f"also in {other.as_posix()} (Store again)" in out
    body = status_path(vault).read_text(encoding="utf-8")
    assert "**R-A2** is defined in both" in body and "Write the store" in body and "Store again" in body


def test_the_fixture_vault_demo_has_a_missing_plan_source(tmp_path: Path, capsys) -> None:
    vault = tmp_path / "vault"
    shutil.copytree(FIXTURE, vault)
    code, out, _ = run(vault, ["--collection", "demo"], capsys, store=InMemoryCurateStore())
    assert code == 1
    assert "plan sources found 1, missing 1" in out
    body = status_path(vault).read_text(encoding="utf-8")
    assert "- projects/demo/notes/plan.md: found" in body
    assert "- C:/definitely/not/here/requirements.md: not found" in body


def test_an_unreachable_store_exits_two_even_for_a_dry_run(vault: Path, capsys) -> None:
    def unreachable():
        raise StoreError("Could not connect to the database: refused")

    for extra in ([], ["--dry-run"]):
        code, _, err = run(vault, ["--collection", "demo", *extra], capsys, store_factory=unreachable)
        assert code == 2 and "Could not connect" in err
    assert not status_path(vault).exists()


def test_a_hand_written_status_is_left_alone_and_exits_two(vault: Path, capsys) -> None:
    status_path(vault).write_text("---\ntitle: mine\n---\nMy notes.\n", encoding="utf-8")
    code, out, err = run(vault, ["--collection", "demo"], capsys, store=InMemoryCurateStore())
    assert code == 2 and "not written by the curator" in err
    assert "status: projects/demo/status.md refused" in out
    assert status_path(vault).read_text(encoding="utf-8") == "---\ntitle: mine\n---\nMy notes.\n"


def test_a_bad_collection_exits_two(vault: Path, capsys) -> None:
    code, _, err = run(vault, ["--collection", "missing"], capsys, store=InMemoryCurateStore())
    assert code == 2 and "no collection 'missing'" in err


def test_a_hub_that_cannot_be_read_exits_two(vault: Path, capsys) -> None:
    (vault / "projects" / "demo" / "demo.md").write_text("---\ntype: index\nkind: widget\n---\n", encoding="utf-8")
    code, _, err = run(vault, ["--all"], capsys, store=InMemoryCurateStore())
    assert code == 2 and "kind must be" in err


# -- the dry run --------------------------------------------------------------------------------


def test_the_dry_run_writes_nothing(vault: Path, capsys) -> None:
    store = InMemoryCurateStore()
    seed(store, vault, {"s1": [claim("R-A2", "done", "store written")]})
    code, out, _ = run(vault, ["--collection", "demo", "--dry-run"], capsys, store=store)
    assert code == 0 and not status_path(vault).exists()
    assert out.splitlines()[0].startswith("status dry run")
    assert "claimed done 2" in out and "status: projects/demo/status.md not written (dry run)" in out


def test_the_top_level_cli_routes_status_and_needs_the_database(vault: Path, capsys) -> None:
    code = cli.main(["curate", "status", "--path", vault.as_posix(), "--collection", "demo", "--dry-run", "--no-git"])
    _, err = capsys.readouterr()
    assert code == 2 and "DATABASE_URL" in err


def test_no_env_file_value_is_ever_printed(vault: Path, tmp_path: Path, capsys) -> None:
    env = tmp_path / "test.env"
    env.write_text(f"SOME_TOKEN={SECRET}\n", encoding="utf-8")
    code, out, err = run(vault, ["--collection", "demo", "--env-file", str(env), "--json"], capsys,
                         store=InMemoryCurateStore())
    assert code == 0 and SECRET not in out + err
