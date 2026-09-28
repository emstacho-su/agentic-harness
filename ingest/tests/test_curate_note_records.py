"""The inventory's note walk (curate/note_records.py): the frontmatter lists R-C6 scores
read — ``commits``, ``prs``, ``files_modified`` and ``retrieved`` — parsed defensively.

Every note is written into ``tmp_path``; no real vault is read.
"""

from __future__ import annotations

from pathlib import Path

from ingest.curate.note_records import NoteRecord, walk_collection

FULL = """---
id: 'session-1a2b'
title: 'A session with every list'
type: session
collection: 'demo'
session_id: '1a2b'
started_at: '2026-09-20T10:00:00Z'
commits:
  - 'abc1234'
  - 'def5678def5678'
prs: [12, 15]
files_modified: ['ingest/src/ingest/store.py', 'hooks/lib/note.mjs']
retrieved:
  - '[[projects/demo/sessions/9f9f]]'
---
Body.
"""


def write(root: Path, stem: str, text: str) -> None:
    sessions = root / "projects" / "demo" / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    (sessions / f"{stem}.md").write_text(text, encoding="utf-8")


def walk(root: Path) -> dict[str, NoteRecord]:
    result = walk_collection(root, root / "projects" / "demo", "projects", "demo")
    return {Path(record.path).stem: record for record in result.records}


def note(fields: str) -> str:
    return f"---\nid: 'x'\ntype: session\ncollection: 'demo'\n{fields}\n---\nBody.\n"


def test_the_lists_are_read_as_tuples(tmp_path: Path) -> None:
    write(tmp_path, "1a2b", FULL)

    record = walk(tmp_path)["1a2b"]

    assert record.commits == ("abc1234", "def5678def5678")
    assert record.prs == (12, 15)
    assert record.files_modified == ("ingest/src/ingest/store.py", "hooks/lib/note.mjs")
    assert record.retrieved == ("[[projects/demo/sessions/9f9f]]",)


def test_a_note_without_the_lists_has_empty_tuples(tmp_path: Path) -> None:
    write(tmp_path, "bare", note("session_id: 'bare'"))

    record = walk(tmp_path)["bare"]

    assert (record.commits, record.prs, record.files_modified, record.retrieved) == ((), (), (), ())


def test_a_scalar_becomes_a_one_tuple(tmp_path: Path) -> None:
    write(tmp_path, "one", note("commits: 'abc1234'\nprs: 7\nfiles_modified: a.py\nretrieved: '[[n]]'"))

    record = walk(tmp_path)["one"]

    assert (record.commits, record.prs, record.files_modified, record.retrieved) == (
        ("abc1234",), (7,), ("a.py",), ("[[n]]",))


def test_values_that_are_not_text_or_numbers_are_dropped(tmp_path: Path) -> None:
    write(tmp_path, "odd", note(
        "commits: ['abc1234', 1234567, true, null, {a: 1}, [x], '  ']\n"
        "prs: [3, '4', 'four', true, 2.5, null, '²']\n"
        "files_modified: {a: 1}\n"
        "retrieved: [null]"
    ))

    record = walk(tmp_path)["odd"]

    assert record.commits == ("abc1234", "1234567")
    assert record.prs == (3, 4)
    assert record.files_modified == ()
    assert record.retrieved == ()


def test_the_lists_do_not_change_the_content_hash(tmp_path: Path) -> None:
    write(tmp_path, "with", FULL)
    write(tmp_path, "without", FULL.replace("prs: [12, 15]\n", ""))

    records = walk(tmp_path)

    assert records["with"].content_hash == records["without"].content_hash


def test_a_record_built_by_hand_defaults_the_lists() -> None:
    record = NoteRecord(
        note_id="n", path="projects/demo/notes/n.md", realm="projects", collection="demo", role="note",
        origin=None, captured_by=None, date=None, session_id=None, parent_session_id=None,
        title="n", body="", content_hash="h",
    )

    assert (record.commits, record.prs, record.files_modified, record.retrieved) == ((), (), (), ())
