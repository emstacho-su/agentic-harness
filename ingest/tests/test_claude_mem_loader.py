"""claude-mem export loading: skips, JSON-text columns, prefixes, enrichment."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from conftest import (
    CONTENT_SESSION_ID,
    empty_observation_row,
    observation_row,
    prompt_row,
    session_row,
    summary_row,
)
from ingest.config import DEFAULT_AGENT, SOURCE_CLAUDE_MEM
from ingest.errors import SourceError
from ingest.jsonutil import parse_json_text_column
from ingest.loaders.claude_mem import (
    EMPTY_OBSERVATION,
    PROMPT_PREFIX,
    SUMMARY_PREFIX,
    load_claude_mem,
)
from ingest.loaders.claude_mem_sessions import build_session_index

OBSERVATIONS_ONLY = {"include_summaries": False, "include_prompts": False}


def write_export(directory: Path, observations, summaries=None, prompts=None, sessions=None):
    directory.mkdir(exist_ok=True, parents=True)
    files = {
        "observations.json": observations,
        "session_summaries.json": summaries or [],
        "user_prompts.json": prompts or [],
        "sdk_sessions.json": sessions or [],
    }
    for name, rows in files.items():
        (directory / name).write_text(json.dumps(rows), encoding="utf-8")
    return directory


def by_id(loaded):
    return {doc.external_id: doc for doc in loaded.documents}


# --------------------------------------------------------------------------
# the empty-row skip
# --------------------------------------------------------------------------


def test_rows_with_no_narrative_text_or_title_are_skipped(tmp_path: Path):
    rows = [observation_row(i) for i in range(1, 4)]
    rows += [empty_observation_row(i) for i in (68, 69, 70)]
    loaded = load_claude_mem(write_export(tmp_path / "e", rows), **OBSERVATIONS_ONLY)

    assert len(loaded.documents) == 3
    assert loaded.skip_reasons() == {EMPTY_OBSERVATION: 3}
    assert set(by_id(loaded)) == {"1", "2", "3"}


def test_the_461_to_443_arithmetic(tmp_path: Path):
    """461 exported rows, 18 empty, 443 ingested — the CONTEXT.md contract."""
    empty_ids = [68, 69, 70, 71, 73, 75, 76, 77, 78, 79, 80, 81, 82, 160, 161, 162, 163, 164]
    rows = [
        empty_observation_row(i) if i in empty_ids else observation_row(i)
        for i in range(1, 462)
    ]
    loaded = load_claude_mem(write_export(tmp_path / "e", rows), **OBSERVATIONS_ONLY)

    assert len(rows) == 461
    assert len(loaded.skipped) == 18
    assert len(loaded.documents) == 443


def test_a_row_with_only_legacy_text_is_still_ingested(tmp_path: Path):
    rows = [observation_row(9, narrative=None, text="Legacy prose body from an old row.")]
    loaded = load_claude_mem(write_export(tmp_path / "e", rows), **OBSERVATIONS_ONLY)
    assert loaded.documents[0].body == "Legacy prose body from an old row."


def test_narrative_is_the_embed_source_not_the_title(tmp_path: Path):
    rows = [observation_row(1, title="A title", narrative="The narrative body.")]
    loaded = load_claude_mem(write_export(tmp_path / "e", rows), **OBSERVATIONS_ONLY)
    doc = loaded.documents[0]
    assert doc.body == "The narrative body."
    assert doc.title == "A title"


# --------------------------------------------------------------------------
# JSON-encoded TEXT columns
# --------------------------------------------------------------------------


def test_json_text_columns_become_real_lists(tmp_path: Path):
    rows = [
        observation_row(
            1,
            facts=json.dumps(["fact one", "fact two"]),
            concepts=json.dumps(["pattern"]),
            files_read=json.dumps(["a.py", "b.py"]),
            files_modified=json.dumps([]),
        )
    ]
    doc = load_claude_mem(write_export(tmp_path / "e", rows), **OBSERVATIONS_ONLY).documents[0]

    assert doc.metadata["facts"] == ["fact one", "fact two"]
    assert doc.metadata["concepts"] == ["pattern"]
    assert doc.metadata["files_read"] == ["a.py", "b.py"]
    assert doc.metadata["files_modified"] == []
    assert not isinstance(doc.metadata["facts"], str)


def test_null_and_blank_json_text_columns_default_to_empty_list(tmp_path: Path):
    rows = [observation_row(1, facts=None, concepts="", files_read="  ")]
    doc = load_claude_mem(write_export(tmp_path / "e", rows), **OBSERVATIONS_ONLY).documents[0]
    assert doc.metadata["facts"] == []
    assert doc.metadata["concepts"] == []
    assert doc.metadata["files_read"] == []


def test_malformed_json_text_column_skips_only_that_row(tmp_path: Path):
    rows = [observation_row(1), observation_row(2, facts="[not json")]
    loaded = load_claude_mem(write_export(tmp_path / "e", rows), **OBSERVATIONS_ONLY)
    assert set(by_id(loaded)) == {"1"}
    assert loaded.skipped[0].external_id == "2"


def test_parse_json_text_column_passes_through_decoded_values():
    assert parse_json_text_column(["a"], field="facts", external_id="1") == ["a"]


def test_parse_json_text_column_rejects_unexpected_types():
    with pytest.raises(SourceError):
        parse_json_text_column(42, field="facts", external_id="1")


# --------------------------------------------------------------------------
# mapping
# --------------------------------------------------------------------------


def test_observation_mapping_matches_the_context_contract(export_dir: Path):
    doc = by_id(load_claude_mem(export_dir))["3"]
    assert doc.source == SOURCE_CLAUDE_MEM
    assert doc.external_id == "3"
    assert doc.agent == DEFAULT_AGENT
    assert doc.metadata["record_type"] == "observation"
    assert doc.metadata["type"] == "discovery"


def test_exporter_hash_is_kept_as_provenance_not_as_content_hash(export_dir: Path):
    doc = by_id(load_claude_mem(export_dir))["1"]
    assert doc.metadata["source_content_hash"] == "3c0b360f730969e4"
    assert "content_hash" not in doc.metadata


def test_the_three_id_spaces_never_collide(export_dir: Path):
    ids = set(by_id(load_claude_mem(export_dir)))
    assert {"1", f"{SUMMARY_PREFIX}1", f"{PROMPT_PREFIX}1"} <= ids
    assert len(ids) == len(load_claude_mem(export_dir).documents)


# --------------------------------------------------------------------------
# session summaries
# --------------------------------------------------------------------------


def test_summaries_use_the_summary_prefix(export_dir: Path):
    ids = set(by_id(load_claude_mem(export_dir)))
    assert f"{SUMMARY_PREFIX}1" in ids
    assert SUMMARY_PREFIX == "summary:"


def test_summary_body_renders_every_populated_section(export_dir: Path):
    doc = by_id(load_claude_mem(export_dir))[f"{SUMMARY_PREFIX}1"]
    for heading in ("Request", "Investigated", "Learned", "Completed", "Next steps", "Notes"):
        assert f"## {heading}" in doc.body
    assert doc.metadata["record_type"] == "session_summary"


def test_summary_title_comes_from_the_request(export_dir: Path):
    doc = by_id(load_claude_mem(export_dir))[f"{SUMMARY_PREFIX}1"]
    assert "Request text for summary 1" in doc.title


def test_summary_with_no_prose_is_skipped(tmp_path: Path):
    blank = summary_row(
        7, request="", investigated="", learned="", completed="", next_steps="", notes=None
    )
    loaded = load_claude_mem(
        write_export(tmp_path / "e", [observation_row(1)], [summary_row(1), blank]),
        include_prompts=False,
    )
    ids = set(by_id(loaded))
    assert f"{SUMMARY_PREFIX}7" not in ids
    assert any(r.external_id == f"{SUMMARY_PREFIX}7" for r in loaded.skipped)


def test_summaries_can_be_excluded(export_dir: Path):
    loaded = load_claude_mem(export_dir, include_summaries=False)
    assert not any(i.startswith(SUMMARY_PREFIX) for i in by_id(loaded))


def test_null_file_columns_on_summaries_become_empty_lists(export_dir: Path):
    doc = by_id(load_claude_mem(export_dir))[f"{SUMMARY_PREFIX}1"]
    assert doc.metadata["files_read"] == []
    assert doc.metadata["files_edited"] == []


# --------------------------------------------------------------------------
# user prompts
# --------------------------------------------------------------------------


def test_prompts_are_ingested_with_the_prompt_prefix_and_no_title(export_dir: Path):
    doc = by_id(load_claude_mem(export_dir))[f"{PROMPT_PREFIX}2"]
    assert doc.source == SOURCE_CLAUDE_MEM
    assert doc.title is None
    assert doc.body == "Prompt text number 2, asking for something."
    assert doc.metadata["record_type"] == "user_prompt"
    assert PROMPT_PREFIX == "prompt:"


def test_prompts_join_sessions_on_content_session_id(export_dir: Path):
    doc = by_id(load_claude_mem(export_dir))[f"{PROMPT_PREFIX}1"]
    assert doc.metadata["content_session_id"] == CONTENT_SESSION_ID
    assert doc.metadata["_session"]["status"] == "failed"
    # Prompts have no project column; the session supplies it.
    assert doc.metadata["project"] == "ai-news-agent"


def test_blank_prompt_text_is_skipped(tmp_path: Path):
    rows = [prompt_row(1), prompt_row(2, prompt_text="   "), prompt_row(3, prompt_text=None)]
    loaded = load_claude_mem(
        write_export(tmp_path / "e", [observation_row(1)], prompts=rows),
        include_summaries=False,
    )
    ids = set(by_id(loaded))
    assert f"{PROMPT_PREFIX}1" in ids
    assert f"{PROMPT_PREFIX}2" not in ids
    assert f"{PROMPT_PREFIX}3" not in ids


def test_prompts_can_be_excluded(export_dir: Path):
    loaded = load_claude_mem(export_dir, include_prompts=False)
    assert not any(i.startswith(PROMPT_PREFIX) for i in by_id(loaded))


# --------------------------------------------------------------------------
# sdk_sessions enrichment — read, never ingested
# --------------------------------------------------------------------------


def test_sdk_sessions_produce_no_documents_of_their_own(export_dir: Path):
    for doc in load_claude_mem(export_dir).documents:
        assert doc.metadata["record_type"] in {
            "observation",
            "session_summary",
            "user_prompt",
        }


def test_observations_are_enriched_via_memory_session_id(export_dir: Path):
    doc = by_id(load_claude_mem(export_dir))["1"]
    assert doc.metadata["_session"]["project"] == "ai-news-agent"
    assert doc.metadata["_session"]["status"] == "failed"


def test_worker_port_is_not_carried_into_metadata(export_dir: Path):
    doc = by_id(load_claude_mem(export_dir))["1"]
    assert "worker_port" not in doc.metadata["_session"]


def test_records_without_a_matching_session_are_still_ingested(tmp_path: Path):
    rows = [observation_row(1, memory_session_id="unknown-session")]
    doc = load_claude_mem(write_export(tmp_path / "e", rows), **OBSERVATIONS_ONLY).documents[0]
    assert "_session" not in doc.metadata


def test_absent_sdk_sessions_file_degrades_without_failing(tmp_path: Path):
    directory = write_export(tmp_path / "e", [observation_row(1)])
    (directory / "sdk_sessions.json").unlink()
    loaded = load_claude_mem(directory, **OBSERVATIONS_ONLY)
    assert len(loaded.documents) == 1
    assert "_session" not in loaded.documents[0].metadata


def test_session_index_covers_both_join_keys():
    index = build_session_index([session_row(1)])
    assert index.for_content_session(CONTENT_SESSION_ID) is not None
    assert index.for_memory_session("62448f65-f47d-485c-a1d8-5661e45229bb") is not None
    assert index.for_memory_session(None) is None
    assert index.for_content_session("nope") is None


def test_session_rows_without_a_memory_id_still_index_by_content_id():
    """Only 18 of the 103 real rows carry a memory_session_id."""
    index = build_session_index([session_row(1, memory_session_id=None)])
    assert len(index) == 1
    assert index.by_memory_id == {}


def test_duplicate_session_ids_keep_the_first_row():
    index = build_session_index(
        [session_row(1, project="first"), session_row(2, project="second")]
    )
    assert index.for_content_session(CONTENT_SESSION_ID)["project"] == "first"


# --------------------------------------------------------------------------
# input validation
# --------------------------------------------------------------------------


def test_missing_export_directory_raises(tmp_path: Path):
    with pytest.raises(SourceError):
        load_claude_mem(tmp_path / "nope")


def test_missing_observations_file_raises(tmp_path: Path):
    (tmp_path / "empty-export").mkdir()
    with pytest.raises(SourceError):
        load_claude_mem(tmp_path / "empty-export")


def test_non_array_json_raises(tmp_path: Path):
    directory = write_export(tmp_path / "e", [observation_row(1)])
    (directory / "observations.json").write_text('{"rows": []}', encoding="utf-8")
    with pytest.raises(SourceError):
        load_claude_mem(directory, **OBSERVATIONS_ONLY)


def test_invalid_json_raises(tmp_path: Path):
    directory = write_export(tmp_path / "e", [observation_row(1)])
    (directory / "observations.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(SourceError):
        load_claude_mem(directory, **OBSERVATIONS_ONLY)


def test_non_object_row_raises(tmp_path: Path):
    directory = write_export(tmp_path / "e", [observation_row(1)])
    (directory / "observations.json").write_text('["not an object"]', encoding="utf-8")
    with pytest.raises(SourceError):
        load_claude_mem(directory, **OBSERVATIONS_ONLY)


def test_row_without_an_id_raises(tmp_path: Path):
    row = observation_row(1)
    del row["id"]
    with pytest.raises(SourceError):
        load_claude_mem(write_export(tmp_path / "e", [row]), **OBSERVATIONS_ONLY)
