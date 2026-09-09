"""Frontmatter parsing and vault walking."""

from __future__ import annotations

from pathlib import Path

import pytest

from ingest.config import DEFAULT_AGENT, SOURCE_OBSIDIAN
from ingest.errors import SourceError
from ingest.loaders.obsidian import load_vault, split_frontmatter


def by_id(loaded):
    return {doc.external_id: doc for doc in loaded.documents}


# --------------------------------------------------------------------------
# split_frontmatter
# --------------------------------------------------------------------------


def test_frontmatter_is_parsed_into_a_dict():
    raw = "---\ntitle: A Note\ntags:\n  - one\n  - two\n---\n\nBody text.\n"
    meta, body = split_frontmatter(raw)
    assert meta == {"title": "A Note", "tags": ["one", "two"]}
    assert body.strip() == "Body text."


def test_document_without_frontmatter_returns_empty_metadata():
    meta, body = split_frontmatter("# Heading\n\nBody.\n")
    assert meta == {}
    assert body.startswith("# Heading")


def test_horizontal_rule_is_not_mistaken_for_frontmatter():
    raw = "Intro paragraph.\n\n---\n\nMore text.\n"
    meta, body = split_frontmatter(raw)
    assert meta == {}
    assert "More text." in body


def test_crlf_frontmatter_is_parsed():
    raw = "---\r\ntitle: Windows Note\r\n---\r\n\r\nBody.\r\n"
    meta, body = split_frontmatter(raw)
    assert meta["title"] == "Windows Note"
    assert body.strip() == "Body."


def test_malformed_yaml_raises_a_typed_error():
    raw = "---\ntitle: [unclosed\n---\n\nBody.\n"
    with pytest.raises(SourceError):
        split_frontmatter(raw)


def test_non_string_input_rejected():
    with pytest.raises(TypeError):
        split_frontmatter(b"---\n")  # type: ignore[arg-type]


# --------------------------------------------------------------------------
# load_vault
# --------------------------------------------------------------------------


def test_vault_walk_finds_notes_and_skips_obsidian_state(vault_path: Path):
    loaded = load_vault(vault_path)
    ids = set(by_id(loaded))
    assert "notes/rag-design.md" in ids
    assert "notes/no-frontmatter.md" in ids
    assert not any(i.startswith(".obsidian") for i in ids)


def test_external_id_is_a_posix_vault_relative_path(vault_path: Path):
    loaded = load_vault(vault_path)
    for external_id in by_id(loaded):
        assert "\\" not in external_id
        assert not Path(external_id).is_absolute()


def test_frontmatter_lands_in_metadata_with_json_safe_values(vault_path: Path):
    doc = by_id(load_vault(vault_path))["notes/rag-design.md"]
    assert doc.metadata["tags"] == ["rag", "pgvector"]
    assert doc.metadata["status"] == "active"
    # A YAML date becomes an ISO string, not a datetime.date object.
    assert doc.metadata["created"] == "2026-09-01"
    assert doc.metadata["priority"] == 2


def test_ingest_metadata_is_namespaced_to_avoid_frontmatter_collisions(vault_path: Path):
    doc = by_id(load_vault(vault_path))["notes/rag-design.md"]
    assert doc.metadata["_ingest"]["path"] == "notes/rag-design.md"
    assert doc.metadata["_ingest"]["loader"] == "obsidian"
    assert doc.metadata["_ingest"]["folder"] == "notes"


def test_source_and_agent_are_set(vault_path: Path):
    for doc in load_vault(vault_path).documents:
        assert doc.source == SOURCE_OBSIDIAN
        assert doc.agent == DEFAULT_AGENT


def test_title_comes_from_frontmatter_then_h1(vault_path: Path):
    docs = by_id(load_vault(vault_path))
    assert docs["notes/rag-design.md"].title == "RAG Store Design"
    assert docs["notes/no-frontmatter.md"].title == "Windows Path Gotcha"


def test_note_with_only_frontmatter_is_skipped_not_failed(vault_path: Path):
    loaded = load_vault(vault_path)
    assert "empty.md" not in by_id(loaded)
    assert any(record.external_id == "empty.md" for record in loaded.skipped)


def test_frontmatter_is_stripped_from_the_body(vault_path: Path):
    doc = by_id(load_vault(vault_path))["notes/rag-design.md"]
    assert "pgvector" in doc.metadata["tags"]
    assert not doc.body.lstrip().startswith("---")


def test_title_falls_back_to_the_filename(tmp_path: Path):
    (tmp_path / "orphan-note.md").write_text("just prose, no heading", encoding="utf-8")
    doc = load_vault(tmp_path).documents[0]
    assert doc.title == "orphan-note"


def test_bad_yaml_note_is_skipped_and_the_rest_of_the_vault_survives(tmp_path: Path):
    (tmp_path / "good.md").write_text("# Good\n\nFine content.\n", encoding="utf-8")
    (tmp_path / "bad.md").write_text("---\ntitle: [oops\n---\n\nBody\n", encoding="utf-8")
    loaded = load_vault(tmp_path)
    assert set(by_id(loaded)) == {"good.md"}
    assert [r.external_id for r in loaded.skipped] == ["bad.md"]


# --------------------------------------------------------------------------
# external_id: frontmatter id wins over the path
# --------------------------------------------------------------------------


def test_frontmatter_id_becomes_the_external_id(vault_path: Path):
    docs = by_id(load_vault(vault_path))
    assert "018f3c2a-6b41-7d90-9c11-2f5a7e8d4b03" in docs
    assert "notes/stable-id.md" not in docs


def test_the_path_is_still_recorded_when_an_id_is_used(vault_path: Path):
    doc = by_id(load_vault(vault_path))["018f3c2a-6b41-7d90-9c11-2f5a7e8d4b03"]
    assert doc.metadata["_ingest"]["path"] == "notes/stable-id.md"
    assert doc.metadata["_ingest"]["id_source"] == "frontmatter"


def test_notes_without_an_id_report_a_path_identity(vault_path: Path):
    doc = by_id(load_vault(vault_path))["notes/rag-design.md"]
    assert doc.metadata["_ingest"]["id_source"] == "path"


def test_a_renamed_note_keeps_its_identity(tmp_path: Path):
    note = "---\nid: note-42\n---\n\nStable content.\n"
    (tmp_path / "before.md").write_text(note, encoding="utf-8")
    first = load_vault(tmp_path).documents[0].external_id

    (tmp_path / "before.md").unlink()
    (tmp_path / "moved" ).mkdir()
    (tmp_path / "moved" / "after.md").write_text(note, encoding="utf-8")
    second = load_vault(tmp_path).documents[0].external_id

    assert first == second == "note-42"


def test_numeric_id_is_coerced_to_text(tmp_path: Path):
    (tmp_path / "n.md").write_text("---\nid: 42\n---\n\nBody.\n", encoding="utf-8")
    assert load_vault(tmp_path).documents[0].external_id == "42"


@pytest.mark.parametrize(
    "frontmatter",
    ["id: []\n", "id: {a: 1}\n", "id: |\n  line one\n  line two\n"],
)
def test_structurally_wrong_id_values_skip_the_note(tmp_path: Path, frontmatter: str):
    (tmp_path / "n.md").write_text(f"---\n{frontmatter}---\n\nBody.\n", encoding="utf-8")
    loaded = load_vault(tmp_path)
    assert loaded.documents == ()
    assert "id" in loaded.skipped[0].reason


@pytest.mark.parametrize("frontmatter", ["id:\n", "id: ''\n", "id: '   '\n"])
def test_blank_id_falls_back_to_the_path_rather_than_losing_the_note(
    tmp_path: Path, frontmatter: str
):
    (tmp_path / "n.md").write_text(f"---\n{frontmatter}---\n\nBody.\n", encoding="utf-8")
    loaded = load_vault(tmp_path)
    assert [doc.external_id for doc in loaded.documents] == ["n.md"]


def test_an_over_long_id_is_refused(tmp_path: Path):
    (tmp_path / "n.md").write_text(
        f"---\nid: {'x' * 600}\n---\n\nBody.\n", encoding="utf-8"
    )
    assert load_vault(tmp_path).documents == ()


def test_two_notes_claiming_one_id_skip_the_second(tmp_path: Path):
    for name in ("a.md", "b.md"):
        (tmp_path / name).write_text(
            f"---\nid: shared\n---\n\nBody of {name}.\n", encoding="utf-8"
        )
    loaded = load_vault(tmp_path)

    assert [doc.external_id for doc in loaded.documents] == ["shared"]
    assert loaded.skipped[0].external_id == "b.md"
    assert "duplicate external_id" in loaded.skipped[0].reason
    assert "a.md" in loaded.skipped[0].reason


def test_missing_vault_path_raises(tmp_path: Path):
    with pytest.raises(SourceError):
        load_vault(tmp_path / "does-not-exist")


def test_file_instead_of_directory_raises(tmp_path: Path):
    target = tmp_path / "a-file.md"
    target.write_text("x", encoding="utf-8")
    with pytest.raises(SourceError):
        load_vault(target)
