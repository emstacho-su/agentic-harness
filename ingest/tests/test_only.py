"""``ingest --only <note>`` — the single-note run the session-capture hook fires.

The hook writes one note and then wants exactly that note embedded, without a
walk of the whole vault. Every validation here exists because the caller is a
detached background process: a bad path must fail loudly in the log rather than
quietly ingesting nothing.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from ingest.cli import main
from ingest.errors import SourceError
from ingest.loaders import load_vault_note
from ingest.pipeline import Action, IngestPipeline

CLEAN_VARS = ("DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE", "SUPABASE_SERVICE_KEY")


@pytest.fixture
def clean_env(monkeypatch, tmp_path):
    for name in CLEAN_VARS:
        monkeypatch.delenv(name, raising=False)
    empty = tmp_path / "empty.env"
    empty.write_text("# nothing\n", encoding="utf-8")
    return empty


# --------------------------------------------------------------------------
# loader: which note, and where it is allowed to be
# --------------------------------------------------------------------------


def test_only_loads_exactly_one_note_from_a_vault_relative_path(vault_path):
    loaded = load_vault_note(vault_path, "notes/rag-design.md")

    assert len(loaded.documents) == 1
    assert loaded.documents[0].external_id == "notes/rag-design.md"
    assert loaded.documents[0].title == "RAG Store Design"


def test_only_accepts_an_absolute_path_inside_the_vault(vault_path):
    loaded = load_vault_note(vault_path, vault_path / "notes" / "stable-id.md")

    assert len(loaded.documents) == 1
    # The frontmatter id still wins over the path, exactly as in a full walk.
    assert loaded.documents[0].external_id == "018f3c2a-6b41-7d90-9c11-2f5a7e8d4b03"


def test_only_accepts_a_windows_backslash_path(vault_path):
    loaded = load_vault_note(vault_path, "notes\\rag-design.md")
    assert loaded.documents[0].external_id == "notes/rag-design.md"


def test_only_produces_the_same_document_a_full_walk_would(vault_path):
    from ingest.loaders import load_vault

    full = {doc.external_id: doc for doc in load_vault(vault_path).documents}
    single = load_vault_note(vault_path, "notes/rag-design.md").documents[0]

    assert single == full[single.external_id]


def test_only_rejects_a_path_outside_the_vault(vault_path, tmp_path):
    outside = tmp_path / "elsewhere.md"
    outside.write_text("# elsewhere\n\nbody text here.\n", encoding="utf-8")

    with pytest.raises(SourceError) as excinfo:
        load_vault_note(vault_path, outside)
    assert "outside the vault" in str(excinfo.value)


def test_only_rejects_a_traversal_out_of_the_vault(vault_path):
    with pytest.raises(SourceError) as excinfo:
        load_vault_note(vault_path, "../../etc/passwd.md")
    assert "outside the vault" in str(excinfo.value)


def test_only_rejects_a_missing_file_rather_than_doing_nothing(vault_path):
    with pytest.raises(SourceError) as excinfo:
        load_vault_note(vault_path, "notes/never-written.md")
    assert "does not exist" in str(excinfo.value)


def test_only_rejects_a_directory(vault_path):
    with pytest.raises(SourceError) as excinfo:
        load_vault_note(vault_path, "notes")
    assert "not a file" in str(excinfo.value)


def test_only_rejects_a_non_markdown_file(vault_path, tmp_path):
    note = vault_path / "notes" / "rag-design.md"
    other = tmp_path / "vault-copy"
    (other / "notes").mkdir(parents=True)
    (other / "notes" / "data.json").write_text("{}", encoding="utf-8")
    (other / "notes" / "rag-design.md").write_text(
        note.read_text(encoding="utf-8"), encoding="utf-8"
    )

    with pytest.raises(SourceError) as excinfo:
        load_vault_note(other, "notes/data.json")
    assert "markdown" in str(excinfo.value)


def test_only_refuses_a_note_the_full_walk_would_skip(vault_path):
    # templates/ is excluded from the walk. Ingesting it through --only would
    # create a row that the next --prune sweep immediately deletes.
    with pytest.raises(SourceError) as excinfo:
        load_vault_note(vault_path, "templates/daily.md")
    assert "excluded from the vault walk" in str(excinfo.value)


def test_only_missing_vault_is_reported(tmp_path):
    with pytest.raises(SourceError) as excinfo:
        load_vault_note(tmp_path / "no-vault", "notes/a.md")
    assert "does not exist" in str(excinfo.value)


def test_only_reports_an_opt_out_as_a_skip_not_a_failure(vault_path):
    loaded = load_vault_note(vault_path, "notes/opted-out.md")

    assert loaded.documents == ()
    assert len(loaded.skipped) == 1
    assert loaded.skipped[0].reason == "frontmatter ingest: false"


def test_only_reports_an_empty_note_as_a_skip(vault_path):
    loaded = load_vault_note(vault_path, "empty.md")

    assert loaded.documents == ()
    assert loaded.skipped[0].reason == "empty body"


# --------------------------------------------------------------------------
# the pipeline guarantee the hook depends on
# --------------------------------------------------------------------------


def test_only_second_run_over_an_unchanged_note_performs_zero_embeddings(
    vault_path, fake_store, fake_embedder
):
    """The DoD line: re-running --only on an unchanged note costs no model work."""
    pipeline = IngestPipeline(fake_store, fake_embedder)
    documents = load_vault_note(vault_path, "notes/rag-design.md").documents

    first = pipeline.run(documents)
    assert first.count(Action.INSERTED) == 1
    embed_calls_after_first = len(fake_embedder.calls)
    assert embed_calls_after_first == 1

    second = pipeline.run(load_vault_note(vault_path, "notes/rag-design.md").documents)

    assert second.count(Action.UNCHANGED) == 1
    assert second.chunks_written == 0
    assert len(fake_embedder.calls) == embed_calls_after_first  # zero new embeddings
    assert fake_store.write_calls == 1


def test_only_re_embeds_when_the_note_actually_changed(
    vault_path, tmp_path, fake_store, fake_embedder
):
    vault = tmp_path / "vault"
    (vault / "notes").mkdir(parents=True)
    target = vault / "notes" / "note.md"
    target.write_text("---\ntitle: N\n---\n\nFirst body, long enough to chunk.\n", encoding="utf-8")

    pipeline = IngestPipeline(fake_store, fake_embedder)
    pipeline.run(load_vault_note(vault, "notes/note.md").documents)

    target.write_text("---\ntitle: N\n---\n\nSecond body, clearly different.\n", encoding="utf-8")
    stats = pipeline.run(load_vault_note(vault, "notes/note.md").documents)

    assert stats.count(Action.UPDATED) == 1
    assert len(fake_embedder.calls) == 2


# --------------------------------------------------------------------------
# CLI wiring
# --------------------------------------------------------------------------


def test_only_dry_run_reports_exactly_one_document(clean_env, vault_path, capsys):
    code = main(
        ["--source", "obsidian", "--path", str(vault_path), "--only", "notes/rag-design.md",
         "--dry-run", "--env-file", str(clean_env)]
    )
    out = capsys.readouterr().out
    assert code == 0
    assert "Loaded 1 documents." in out
    assert "would-insert" in out


def test_only_requires_the_obsidian_source(clean_env, export_dir, capsys):
    code = main(
        ["--source", "claude-mem", "--path", str(export_dir), "--only", "x.md",
         "--dry-run", "--env-file", str(clean_env)]
    )
    assert code == 2
    assert "--only" in capsys.readouterr().err


def test_only_and_prune_together_are_refused(clean_env, vault_path, capsys):
    code = main(
        ["--source", "obsidian", "--path", str(vault_path), "--only", "notes/rag-design.md",
         "--prune", "--dry-run", "--env-file", str(clean_env)]
    )
    err = capsys.readouterr().err
    assert code == 2
    assert "--only" in err and "--prune" in err


def test_only_missing_file_exits_nonzero_with_the_reason(clean_env, vault_path, capsys):
    code = main(
        ["--source", "obsidian", "--path", str(vault_path), "--only", "notes/gone.md",
         "--dry-run", "--env-file", str(clean_env)]
    )
    assert code == 1
    assert "does not exist" in capsys.readouterr().err


def test_only_outside_the_vault_exits_nonzero(clean_env, vault_path, tmp_path, capsys):
    stray = tmp_path / "stray.md"
    stray.write_text("# stray\n\nbody\n", encoding="utf-8")

    code = main(
        ["--source", "obsidian", "--path", str(vault_path), "--only", str(stray),
         "--dry-run", "--env-file", str(clean_env)]
    )
    assert code == 1
    assert "outside the vault" in capsys.readouterr().err


def test_only_opted_out_note_is_a_clean_no_op(clean_env, vault_path, capsys):
    code = main(
        ["--source", "obsidian", "--path", str(vault_path), "--only", "notes/opted-out.md",
         "--dry-run", "--env-file", str(clean_env)]
    )
    out = capsys.readouterr().out
    assert code == 0
    assert "Nothing to ingest." in out


def test_only_does_not_record_a_full_run_success(clean_env, vault_path, tmp_path, monkeypatch):
    """A one-note run is not the nightly reconcile; it must not refresh health."""
    from ingest import runstate

    state = tmp_path / "state.json"
    monkeypatch.setenv(runstate.ENV_STATE_FILE, str(state))

    main(["--source", "obsidian", "--path", str(vault_path), "--only", "notes/rag-design.md",
          "--dry-run", "--env-file", str(clean_env)])

    assert not state.exists()


def test_only_path_is_reported_in_the_load_notes(clean_env, vault_path, capsys):
    main(["--source", "obsidian", "--path", str(vault_path), "--only", "notes/rag-design.md",
          "--dry-run", "--env-file", str(clean_env)])
    assert "single note: notes/rag-design.md" in capsys.readouterr().out


def test_only_is_absent_from_a_normal_run(clean_env, vault_path, capsys):
    main(["--source", "obsidian", "--path", str(vault_path), "--dry-run",
          "--env-file", str(clean_env)])
    assert "single note:" not in capsys.readouterr().out


def test_vault_relative_path_wins_over_a_same_named_cwd_file(vault_path, tmp_path, monkeypatch):
    """A relative --only is resolved against the VAULT, never the process cwd."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "notes").mkdir()
    (tmp_path / "notes" / "rag-design.md").write_text("# decoy\n\ndecoy body\n", encoding="utf-8")

    loaded = load_vault_note(vault_path, "notes/rag-design.md")
    assert loaded.documents[0].title == "RAG Store Design"


def test_note_path_may_not_be_empty(vault_path):
    with pytest.raises(SourceError):
        load_vault_note(vault_path, "   ")


def test_a_null_byte_is_a_typed_error_not_a_traceback(vault_path):
    # Path.exists() raises ValueError, not OSError, on an embedded null. Left
    # unhandled it escapes main()'s IngestError handler as a stack trace.
    with pytest.raises(SourceError, match="null byte"):
        load_vault_note(vault_path, "\x00notes/rag-design.md")


def test_a_null_byte_exits_cleanly_through_the_cli(clean_env, vault_path, capsys):
    code = main(
        ["--source", "obsidian", "--path", str(vault_path), "--only", "\x00notes/a.md",
         "--dry-run", "--env-file", str(clean_env)]
    )
    assert code == 1
    assert "null byte" in capsys.readouterr().err


@pytest.mark.skipif(os.name != "nt", reason="path casing is only forgiving on Windows")
def test_a_differently_cased_spelling_resolves_on_windows(vault_path):
    loaded = load_vault_note(vault_path, "NOTES/RAG-DESIGN.MD")
    assert loaded.documents[0].external_id == "notes/rag-design.md"


@pytest.mark.parametrize(
    "case",
    [
        "./notes/rag-design.md",
        "notes/../notes/rag-design.md",  # a '..' that stays inside
        "notes/rag-design.md ",          # trailing whitespace
    ],
)
def test_equivalent_spellings_of_the_same_note_all_resolve(vault_path, case):
    loaded = load_vault_note(vault_path, case)
    assert loaded.documents[0].external_id == "notes/rag-design.md"


@pytest.mark.parametrize(
    "case",
    [
        "../../../../Windows/System32/drivers/etc/hosts.md",
        "C:/Windows/System32/config.md",
        "//?/C:/Windows/evil.md",        # the Win32 extended-length prefix
        "\\\\server\\share\\evil.md",    # a UNC path
    ],
)
def test_every_escape_from_the_vault_is_refused(vault_path, case):
    with pytest.raises(SourceError):
        load_vault_note(vault_path, case)


def test_symlinked_note_pointing_outside_is_refused(vault_path, tmp_path):
    """resolve() follows links, so an escape through one is caught by the same check."""
    outside = tmp_path / "secret.md"
    outside.write_text("# secret\n\nbody\n", encoding="utf-8")
    link = Path(vault_path) / "notes" / "link.md"
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks need developer mode or admin on Windows")
    try:
        with pytest.raises(SourceError):
            load_vault_note(vault_path, "notes/link.md")
    finally:
        link.unlink()
