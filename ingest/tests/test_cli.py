"""CLI wiring, env handling and an end-to-end dry run over both loaders."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from ingest.cli import build_parser, main
from ingest.config import load_db_settings
from ingest.envfile import find_env_file, load_env_file, parse_env_file
from ingest.errors import ConfigError

CONNECTION_VARS = (
    "DATABASE_URL",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE",
    "SUPABASE_SERVICE_KEY",
)


@pytest.fixture
def clean_env(monkeypatch, tmp_path):
    """No inherited credentials, and no repo .env picked up by the walk-up."""
    for name in CONNECTION_VARS:
        monkeypatch.delenv(name, raising=False)
    # Point the CLI at an empty env file so find_env_file cannot reach the repo root.
    empty = tmp_path / "empty.env"
    empty.write_text("# nothing\n", encoding="utf-8")
    return empty


# --------------------------------------------------------------------------
# argument handling
# --------------------------------------------------------------------------


def test_source_choices_are_the_two_loaders():
    action = next(a for a in build_parser()._actions if a.dest == "source")
    assert set(action.choices) == {"obsidian", "claude-mem"}


def test_missing_arguments_exit_with_usage_error(clean_env, capsys):
    assert main(["--env-file", str(clean_env)]) == 2
    assert "required" in capsys.readouterr().err


def test_unknown_source_is_rejected_by_argparse():
    with pytest.raises(SystemExit):
        main(["--source", "notion", "--path", "."])


def test_bad_limit_is_rejected(clean_env, vault_path, capsys):
    code = main(
        [
            "--source", "obsidian", "--path", str(vault_path),
            "--dry-run", "--limit", "0", "--env-file", str(clean_env),
        ]
    )
    assert code == 2
    assert "--limit" in capsys.readouterr().err


def test_missing_path_is_reported_not_traced(clean_env, tmp_path, capsys):
    code = main(
        [
            "--source", "obsidian", "--path", str(tmp_path / "nope"),
            "--dry-run", "--env-file", str(clean_env),
        ]
    )
    assert code == 1
    assert "does not exist" in capsys.readouterr().err


# --------------------------------------------------------------------------
# dry runs, no database and no model
# --------------------------------------------------------------------------


def test_obsidian_dry_run_reports_plan_and_writes_nothing(clean_env, vault_path, capsys):
    code = main(
        ["--source", "obsidian", "--path", str(vault_path), "--dry-run",
         "--env-file", str(clean_env)]
    )
    out = capsys.readouterr().out
    assert code == 0
    assert "dry run, nothing written" in out
    assert "would-insert" in out
    assert "chunks that would be written" in out


def test_dry_run_reports_the_skipped_notes(clean_env, vault_path, capsys):
    main(["--source", "obsidian", "--path", str(vault_path), "--dry-run",
          "--env-file", str(clean_env)])
    out = capsys.readouterr().out
    # empty.md (no body) and notes/opted-out.md (ingest: false)
    assert "Skipped 2 records" in out
    assert "empty body" in out
    assert "frontmatter ingest: false" in out


def test_claude_mem_dry_run_reports_the_empty_row_skip(clean_env, export_dir, capsys):
    code = main(
        ["--source", "claude-mem", "--path", str(export_dir), "--dry-run",
         "--env-file", str(clean_env)]
    )
    out = capsys.readouterr().out
    assert code == 0
    # 5 observations + 2 summaries + 3 prompts, 2 empty observations skipped
    assert "Loaded 10 documents." in out
    assert "migration failure" in out


def test_limit_caps_the_number_of_documents(clean_env, export_dir, capsys):
    main(["--source", "claude-mem", "--path", str(export_dir), "--dry-run",
          "--limit", "2", "--env-file", str(clean_env)])
    out = capsys.readouterr().out
    assert "2  would-insert" in out.replace("     ", "  ")


def test_no_summaries_flag(clean_env, export_dir, capsys):
    main(["--source", "claude-mem", "--path", str(export_dir), "--dry-run",
          "--no-summaries", "--env-file", str(clean_env)])
    assert "Loaded 8 documents." in capsys.readouterr().out


def test_no_prompts_flag(clean_env, export_dir, capsys):
    main(["--source", "claude-mem", "--path", str(export_dir), "--dry-run",
          "--no-prompts", "--env-file", str(clean_env)])
    assert "Loaded 7 documents." in capsys.readouterr().out


def test_prune_is_off_by_default(clean_env, vault_path, capsys):
    main(["--source", "obsidian", "--path", str(vault_path), "--dry-run",
          "--env-file", str(clean_env)])
    assert "Orphan sweep" not in capsys.readouterr().out


def test_prune_dry_run_reports_the_sweep(clean_env, vault_path, capsys):
    main(["--source", "obsidian", "--path", str(vault_path), "--dry-run",
          "--prune", "--env-file", str(clean_env)])
    out = capsys.readouterr().out
    # NullStore knows of no existing rows, so there is nothing stale to report.
    assert "Orphan sweep: nothing stale" in out


def test_prune_declines_after_a_limited_run(clean_env, vault_path, capsys):
    main(["--source", "obsidian", "--path", str(vault_path), "--dry-run",
          "--prune", "--limit", "1", "--env-file", str(clean_env)])
    out = capsys.readouterr().out
    assert "Orphan sweep skipped" in out
    assert "--limit" in out


def test_empty_vault_exits_cleanly(clean_env, tmp_path, capsys):
    (tmp_path / "vault").mkdir()
    code = main(["--source", "obsidian", "--path", str(tmp_path / "vault"),
                 "--dry-run", "--env-file", str(clean_env)])
    assert code == 0
    assert "Nothing to ingest." in capsys.readouterr().out


# --------------------------------------------------------------------------
# --check-env
# --------------------------------------------------------------------------


def test_check_env_reports_presence_and_never_a_value(monkeypatch, clean_env, capsys):
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:hunter2@host/db")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE", "sb_secret_topsecret")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")

    assert main(["--check-env", "--env-file", str(clean_env)]) == 0
    out = capsys.readouterr().out
    assert "DATABASE_URL" in out and "set" in out
    assert "hunter2" not in out
    assert "sb_secret_topsecret" not in out
    assert "https://example.supabase.co" in out


def test_check_env_reports_missing_variables(clean_env, capsys):
    assert main(["--check-env", "--env-file", str(clean_env)]) == 0
    assert "missing" in capsys.readouterr().out


# --------------------------------------------------------------------------
# settings + .env parsing
# --------------------------------------------------------------------------


def test_service_role_uses_the_new_name():
    settings = load_db_settings({"SUPABASE_SERVICE_ROLE": "sb_secret_x"})
    assert settings.supabase_service_role == "sb_secret_x"


def test_legacy_service_key_name_still_works():
    settings = load_db_settings({"SUPABASE_SERVICE_KEY": "legacy"})
    assert settings.supabase_service_role == "legacy"


def test_new_name_wins_over_the_legacy_one():
    settings = load_db_settings(
        {"SUPABASE_SERVICE_ROLE": "new", "SUPABASE_SERVICE_KEY": "old"}
    )
    assert settings.supabase_service_role == "new"


def test_blank_values_are_treated_as_missing():
    settings = load_db_settings({"DATABASE_URL": "   "})
    assert settings.database_url is None
    assert settings.can_connect is False


def test_env_file_parsing_handles_comments_export_and_quotes():
    parsed = parse_env_file(
        "# a comment\n"
        "\n"
        "export DATABASE_URL=postgresql://a/b\n"
        'SUPABASE_URL="https://x.supabase.co"\n'
        "SUPABASE_SERVICE_ROLE='sb_secret_y'\n"
    )
    assert parsed == {
        "DATABASE_URL": "postgresql://a/b",
        "SUPABASE_URL": "https://x.supabase.co",
        "SUPABASE_SERVICE_ROLE": "sb_secret_y",
    }


def test_malformed_env_line_is_reported_with_its_line_number():
    with pytest.raises(ConfigError) as excinfo:
        parse_env_file("GOOD=1\nthis line has no equals\n")
    assert ":2" in str(excinfo.value)


def test_env_file_never_overrides_an_exported_variable(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", "from-shell")
    env_file = tmp_path / ".env"
    env_file.write_text("DATABASE_URL=from-file\n", encoding="utf-8")
    load_env_file(env_file)
    assert os.environ["DATABASE_URL"] == "from-shell"


def test_env_file_fills_in_what_the_shell_lacks(monkeypatch, tmp_path):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    env_file = tmp_path / ".env"
    env_file.write_text("SUPABASE_URL=https://from-file\n", encoding="utf-8")
    applied = load_env_file(env_file)
    assert "SUPABASE_URL" in applied
    assert os.environ["SUPABASE_URL"] == "https://from-file"
    monkeypatch.delenv("SUPABASE_URL", raising=False)


def test_missing_explicit_env_file_raises(tmp_path):
    with pytest.raises(ConfigError):
        load_env_file(tmp_path / "absent.env")


def test_find_env_file_returns_none_when_there_is_none(tmp_path: Path):
    assert find_env_file(tmp_path) is None


# --------------------------------------------------------------------------
# TLS settings
# --------------------------------------------------------------------------


def test_ca_cert_is_read_from_database_ca_cert(tmp_path):
    settings = load_db_settings({"DATABASE_CA_CERT": str(tmp_path / "ca.crt")})
    assert settings.ssl_root_cert == str((tmp_path / "ca.crt").resolve())


def test_ca_cert_falls_back_to_pgsslrootcert(tmp_path):
    settings = load_db_settings({"PGSSLROOTCERT": str(tmp_path / "ca.crt")})
    assert settings.ssl_root_cert == str((tmp_path / "ca.crt").resolve())


def test_database_ca_cert_wins_over_pgsslrootcert(tmp_path):
    settings = load_db_settings(
        {"DATABASE_CA_CERT": str(tmp_path / "a.crt"), "PGSSLROOTCERT": str(tmp_path / "b.crt")}
    )
    assert settings.ssl_root_cert.endswith("a.crt")


def test_relative_ca_path_is_resolved_against_the_cwd(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    settings = load_db_settings({"DATABASE_CA_CERT": "certs/prod-ca.crt"})
    assert settings.ssl_root_cert == str((tmp_path / "certs" / "prod-ca.crt").resolve())


def test_database_ssl_disable_is_the_only_way_to_turn_tls_off():
    assert load_db_settings({"DATABASE_SSL": "disable"}).ssl_disabled is True
    assert load_db_settings({"DATABASE_SSL": "off"}).ssl_disabled is True
    assert load_db_settings({"DATABASE_SSL": "prefer"}).ssl_disabled is False
    assert load_db_settings({}).ssl_disabled is False


def test_check_env_reports_the_ca_cert_path_state(monkeypatch, clean_env, capsys, tmp_path):
    ca = tmp_path / "ca.crt"
    ca.write_text("x")
    monkeypatch.setenv("DATABASE_CA_CERT", str(ca))

    assert main(["--check-env", "--env-file", str(clean_env)]) == 0
    out = capsys.readouterr().out
    assert "DATABASE_CA_CERT" in out
    assert "verify-full" in out


# --------------------------------------------------------------------------
# reporting
# --------------------------------------------------------------------------


def test_the_summary_explains_what_a_metadata_update_did(capsys):
    from ingest.cli import _report_stats
    from ingest.pipeline import Action, DocumentOutcome, IngestStats

    stats = IngestStats()
    stats.record(DocumentOutcome("notes/a.md", Action.METADATA_UPDATED))
    stats.record(DocumentOutcome("notes/b.md", Action.METADATA_UPDATED))
    stats.record(DocumentOutcome("notes/c.md", Action.UNCHANGED))

    _report_stats(stats, dry_run=False)
    out = capsys.readouterr().out

    assert "2  metadata-updated" in out
    assert "no re-chunking, no embedding" in out
    assert "chunks written: 0" in out


def test_a_dry_run_says_it_would_refresh_metadata(capsys):
    from ingest.cli import _report_stats
    from ingest.pipeline import Action, DocumentOutcome, IngestStats

    stats = IngestStats()
    stats.record(DocumentOutcome("notes/a.md", Action.PLANNED_METADATA))

    _report_stats(stats, dry_run=True)
    out = capsys.readouterr().out

    assert "would-update-metadata" in out
    assert "would refresh" in out


# --------------------------------------------------------------------------
# realms at the command line
# --------------------------------------------------------------------------


def realm_vault(tmp_path):
    vault = tmp_path / "vault"
    for name in ("projects", "classes"):
        (vault / name).mkdir(parents=True)
        (vault / name / ".realm").write_text(f"{name}\n", encoding="utf-8")
        (vault / name / "a.md").write_text(f"---\nid: {name}-a\n---\n\nA note in {name}.\n", encoding="utf-8")
    return vault


def test_prune_sweeps_each_realm_the_run_walked(clean_env, tmp_path, capsys):
    main(["--source", "obsidian", "--path", str(realm_vault(tmp_path)), "--dry-run",
          "--prune", "--env-file", str(clean_env)])
    out = capsys.readouterr().out
    assert "realm 'projects'" in out and "realm 'classes'" in out
    assert "legacy" not in out, "a realm run must not sweep the pre-realm rows without --prune-legacy"


def test_prune_legacy_sweeps_the_pre_realm_rows_too(clean_env, tmp_path, capsys):
    main(["--source", "obsidian", "--path", str(realm_vault(tmp_path)), "--dry-run",
          "--prune", "--prune-legacy", "--env-file", str(clean_env)])
    out = capsys.readouterr().out
    assert "legacy" in out


def test_prune_legacy_needs_a_full_pass(clean_env, tmp_path, capsys):
    vault = realm_vault(tmp_path)
    code = main(["--source", "obsidian", "--path", str(vault), "--only", "projects/a.md",
                 "--prune-legacy", "--dry-run", "--env-file", str(clean_env)])
    assert code == 2
    assert "--prune-legacy" in capsys.readouterr().err


def test_a_realm_missing_from_harness_realms_stops_the_run(monkeypatch, clean_env, tmp_path, capsys):
    monkeypatch.setenv("HARNESS_REALMS", "projects:push")
    code = main(["--source", "obsidian", "--path", str(realm_vault(tmp_path)), "--dry-run",
                 "--env-file", str(clean_env)])
    assert code == 1
    assert "classes" in capsys.readouterr().err


def test_harness_realms_that_covers_the_vault_lets_the_run_through(monkeypatch, clean_env, tmp_path, capsys):
    monkeypatch.setenv("HARNESS_REALMS", "projects:push,classes:local,work-vm:push")
    code = main(["--source", "obsidian", "--path", str(realm_vault(tmp_path)), "--dry-run",
                 "--env-file", str(clean_env)])
    assert code == 0


# --------------------------------------------------------------------------
# the machine file
# --------------------------------------------------------------------------


def test_machine_env_fills_what_the_repo_env_and_the_shell_lack(monkeypatch, tmp_path, capsys):
    for name in ("HARNESS_MACHINE", "HARNESS_REALMS", "DATABASE_URL"):
        monkeypatch.delenv(name, raising=False)
    repo_env = tmp_path / "repo.env"
    repo_env.write_text("DATABASE_URL=postgresql://repo\n", encoding="utf-8")
    machine = tmp_path / "machine.env"
    machine.write_text("DATABASE_URL=postgresql://machine\nHARNESS_MACHINE=home-pc\n", encoding="utf-8")
    monkeypatch.setenv("HARNESS_MACHINE_ENV", str(machine))

    load_env_file(repo_env)

    import os
    assert os.environ["DATABASE_URL"] == "postgresql://repo", "the repo .env wins over the machine file"
    assert os.environ["HARNESS_MACHINE"] == "home-pc", "the machine file fills the gap"


def test_a_missing_machine_env_is_not_an_error(monkeypatch, tmp_path):
    monkeypatch.setenv("HARNESS_MACHINE_ENV", str(tmp_path / "absent.env"))
    repo_env = tmp_path / "repo.env"
    repo_env.write_text("# nothing\n", encoding="utf-8")
    assert load_env_file(repo_env) == []
