"""Tests for the curator's only file writer (curate/writer.py, SC-4 and Phase C *Curator safety*)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from ingest.curate import writer
from ingest.curate.writer import WriteRefused, WriteResult, write_curation_report, write_curator_note
from ingest.loaders.obsidian import split_frontmatter


def frontmatter(name: str = "ledger", generated_at: str = "2026-09-27T04:30:00+00:00", **extra) -> dict:
    return {"id": f"curator-{name}-projects-demo", "title": "demo issue ledger", "type": name,
            "captured_by": "curator", "collection": "demo", "generated_at": generated_at, **extra}


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    root = tmp_path / "vault"
    for realm in ("projects", "classes"):
        (root / realm).mkdir(parents=True)
        (root / realm / ".realm").write_text(realm, encoding="utf-8")
    (root / "projects" / "demo").mkdir()
    (root / "projects" / "wa2 final").mkdir()
    return root


def test_a_first_write_creates_the_note_with_frontmatter_and_body(vault: Path) -> None:
    result = write_curator_note(vault, "projects", "demo", "ledger", frontmatter(), "# Ledger\n\nBody.\n")
    target = vault / "projects" / "demo" / "ledger.md"
    assert result == WriteResult(path=target, written=True)
    raw = target.read_bytes()
    assert b"\r\n" not in raw
    fields, body = split_frontmatter(raw.decode("utf-8"))
    assert fields == frontmatter()
    assert body.strip() == "# Ledger\n\nBody.".strip()
    assert raw.decode("utf-8").startswith("---\nid: 'curator-ledger-projects-demo'\n")


def test_a_rerun_with_only_a_new_generated_at_does_not_write(vault: Path) -> None:
    write_curator_note(vault, "projects", "demo", "ledger", frontmatter(), "Body.\n")
    target = vault / "projects" / "demo" / "ledger.md"
    before = target.read_bytes()
    os.utime(target, (1_000_000, 1_000_000))
    result = write_curator_note(vault, "projects", "demo", "ledger",
                                frontmatter(generated_at="2026-10-04T04:30:00+00:00"), "Body.\n")
    assert result.written is False
    assert target.read_bytes() == before
    assert target.stat().st_mtime == 1_000_000


def test_a_changed_body_is_rewritten(vault: Path) -> None:
    write_curator_note(vault, "projects", "demo", "ledger", frontmatter(), "Body.\n")
    result = write_curator_note(vault, "projects", "demo", "ledger",
                                frontmatter(generated_at="2026-10-04T04:30:00+00:00"), "New body.\n")
    assert result.written is True
    text = (vault / "projects" / "demo" / "ledger.md").read_text(encoding="utf-8")
    assert "New body." in text and "2026-10-04" in text


def test_a_changed_frontmatter_field_is_rewritten(vault: Path) -> None:
    write_curator_note(vault, "projects", "demo", "ledger", frontmatter(extractor_version="a"), "Body.\n")
    result = write_curator_note(vault, "projects", "demo", "ledger", frontmatter(extractor_version="b"), "Body.\n")
    assert result.written is True


def test_a_quote_in_a_value_round_trips(vault: Path) -> None:
    fields = frontmatter(title="it's the 'demo' ledger: #1 | --- [[x]]")
    write_curator_note(vault, "projects", "demo", "ledger", fields, "Body.\n")
    parsed, _ = split_frontmatter((vault / "projects" / "demo" / "ledger.md").read_text(encoding="utf-8"))
    assert parsed["title"] == "it's the 'demo' ledger: #1 | --- [[x]]"


@pytest.mark.parametrize("name", ["ledger", "status", "history"])
def test_every_allowed_name_writes(vault: Path, name: str) -> None:
    result = write_curator_note(vault, "projects", "demo", name, frontmatter(name), "Body.\n")
    assert result.path.name == f"{name}.md" and result.written


@pytest.mark.parametrize("name", ["notes", "ledger.md", "../ledger", "LEDGER", "", "demo"])
def test_a_name_outside_the_three_is_refused(vault: Path, name: str) -> None:
    with pytest.raises(WriteRefused, match="name"):
        write_curator_note(vault, "projects", "demo", name, frontmatter(), "Body.\n")


@pytest.mark.parametrize("collection", ["..", "../projects", "Demo", "a/b", "a\\b", ".hidden", ""])
def test_a_bad_collection_is_refused(vault: Path, collection: str) -> None:
    with pytest.raises(WriteRefused, match="collection"):
        write_curator_note(vault, "projects", collection, "ledger", frontmatter(), "Body.\n")


def test_a_collection_with_a_space_is_allowed(vault: Path) -> None:
    result = write_curator_note(vault, "projects", "wa2 final", "ledger", frontmatter(), "Body.\n")
    assert result.written and result.path.parent.name == "wa2 final"


def test_a_missing_collection_folder_is_refused_not_created(vault: Path) -> None:
    with pytest.raises(WriteRefused, match="collection folder"):
        write_curator_note(vault, "projects", "ghost", "ledger", frontmatter(), "Body.\n")
    assert not (vault / "projects" / "ghost").exists()


@pytest.mark.parametrize("realm", ["attachments", "..", "projects/demo", "", "nowhere"])
def test_a_folder_that_is_not_a_realm_is_refused(vault: Path, realm: str) -> None:
    (vault / "attachments" / "demo").mkdir(parents=True)
    with pytest.raises(WriteRefused, match="realm"):
        write_curator_note(vault, realm, "demo", "ledger", frontmatter(), "Body.\n")


def test_a_legacy_vault_without_markers_accepts_projects_and_classes(tmp_path: Path) -> None:
    root = tmp_path / "legacy"
    (root / "projects" / "demo").mkdir(parents=True)
    assert write_curator_note(root, "projects", "demo", "ledger", frontmatter(), "Body.\n").written


def _link_directory(link: Path, target: Path) -> None:
    """A symlink, or on Windows without that privilege a junction, which needs none."""
    try:
        link.symlink_to(target, target_is_directory=True)
        return
    except OSError:
        pass
    try:
        import _winapi
    except ImportError:
        pytest.skip("symlinks are not available to this user")
    _winapi.CreateJunction(str(target), str(link))


def test_a_symlinked_collection_that_leaves_the_vault_is_refused(vault: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    link = vault / "projects" / "escape"
    _link_directory(link, outside)
    with pytest.raises(WriteRefused, match="outside the vault"):
        write_curator_note(vault, "projects", "escape", "ledger", frontmatter(), "Body.\n")
    assert list(outside.iterdir()) == []


def test_a_symlinked_ledger_that_leaves_the_vault_is_refused(vault: Path, tmp_path: Path) -> None:
    outside = tmp_path / "elsewhere.md"
    outside.write_text("---\ncaptured_by: curator\n---\nnot the vault\n", encoding="utf-8")
    link = vault / "projects" / "demo" / "ledger.md"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks are not available to this user")
    with pytest.raises(WriteRefused, match="outside the vault"):
        write_curator_note(vault, "projects", "demo", "ledger", frontmatter(), "Body.\n")
    assert outside.read_text(encoding="utf-8").endswith("not the vault\n")


@pytest.mark.parametrize("existing", [
    "---\ntitle: my own ledger\n---\nHand-written.\n",
    "---\ncaptured_by: hook\n---\nA session.\n",
    "No frontmatter at all.\n",
    "---\ncaptured_by: [curator\n---\nMalformed.\n",
])
def test_an_existing_note_not_written_by_the_curator_is_never_overwritten(vault: Path, existing: str) -> None:
    target = vault / "projects" / "demo" / "ledger.md"
    target.write_text(existing, encoding="utf-8")
    with pytest.raises(WriteRefused, match="not written by the curator"):
        write_curator_note(vault, "projects", "demo", "ledger", frontmatter(), "Body.\n")
    assert target.read_text(encoding="utf-8") == existing


def test_a_body_line_like_generated_at_is_not_ignored(vault: Path) -> None:
    write_curator_note(vault, "projects", "demo", "ledger", frontmatter(), "generated_at: one\n")
    again = write_curator_note(vault, "projects", "demo", "ledger", frontmatter(), "generated_at: two\n")
    assert again.written is True


def test_a_directory_in_the_way_is_refused(vault: Path) -> None:
    (vault / "projects" / "demo" / "ledger.md").mkdir()
    with pytest.raises(WriteRefused, match="not a file"):
        write_curator_note(vault, "projects", "demo", "ledger", frontmatter(), "Body.\n")


@pytest.mark.parametrize("fields, match", [
    ({"type": "ledger", "generated_at": "x"}, "captured_by"),
    ({"type": "status", "captured_by": "curator", "generated_at": "x"}, "type"),
    ({"type": "ledger", "captured_by": "curator"}, "generated_at"),
    ({"type": "ledger", "captured_by": "curator", "generated_at": "x", "Bad Key": "v"}, "key"),
    ({"type": "ledger", "captured_by": "curator", "generated_at": "x", "nested": {"a": 1}}, "value"),
])
def test_frontmatter_must_mark_the_note_as_the_curators(vault: Path, fields: dict, match: str) -> None:
    with pytest.raises(WriteRefused, match=match):
        write_curator_note(vault, "projects", "demo", "ledger", fields, "Body.\n")


def test_the_write_is_atomic_and_leaves_no_temp_file_on_failure(vault: Path, monkeypatch) -> None:
    target = vault / "projects" / "demo" / "ledger.md"
    write_curator_note(vault, "projects", "demo", "ledger", frontmatter(), "Old body.\n")
    before = target.read_bytes()

    def failing_replace(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(writer.os, "replace", failing_replace)
    with pytest.raises(OSError, match="disk full"):
        write_curator_note(vault, "projects", "demo", "ledger", frontmatter(), "New body.\n")
    assert target.read_bytes() == before
    assert sorted(p.name for p in target.parent.iterdir()) == ["ledger.md"]


def test_a_body_with_crlf_is_written_with_lf(vault: Path) -> None:
    write_curator_note(vault, "projects", "demo", "ledger", frontmatter(), "a\r\nb\r\n")
    assert b"\r" not in (vault / "projects" / "demo" / "ledger.md").read_bytes()


# -- the curation report (used by C-b) ----------------------------------------------------------


def report_frontmatter(**extra) -> dict:
    return {"id": "curator-report-projects-2026-09-27", "type": "curation-report", "captured_by": "curator",
            "generated_at": "2026-09-27T04:30:00+00:00", **extra}


def test_a_curation_report_goes_under_the_realms_curation_folder(vault: Path) -> None:
    result = write_curation_report(vault, "projects", "2026-09-27", report_frontmatter(), "Report.\n")
    assert result.path == vault / "projects" / "curation" / "2026-09-27.md"
    assert result.written


@pytest.mark.parametrize("day", ["2026-9-27", "2026-02-30", "../x", "2026-09-27.md", "today"])
def test_a_report_date_must_be_a_real_iso_date(vault: Path, day: str) -> None:
    with pytest.raises(WriteRefused, match="date"):
        write_curation_report(vault, "projects", day, report_frontmatter(), "Report.\n")


def test_a_report_must_be_typed_curation_report(vault: Path) -> None:
    with pytest.raises(WriteRefused, match="type"):
        write_curation_report(vault, "projects", "2026-09-27", {**report_frontmatter(), "type": "ledger"}, "R\n")


def test_a_report_rerun_is_idempotent(vault: Path) -> None:
    write_curation_report(vault, "projects", "2026-09-27", report_frontmatter(), "Report.\n")
    again = write_curation_report(vault, "projects", "2026-09-27",
                                  report_frontmatter(generated_at="2026-09-27T05:00:00+00:00"), "Report.\n")
    assert again.written is False
