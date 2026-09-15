"""Last-success bookkeeping and ``ingest --health``.

A scheduled task that never fires reports nothing at all, so health is measured
as staleness: how long ago did a full reconcile last finish?
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from ingest import runstate
from ingest.cli import main
from ingest.errors import IngestError

NOW = datetime(2026, 9, 15, 9, 0, 0, tzinfo=timezone.utc)

CLEAN_VARS = ("DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE", "SUPABASE_SERVICE_KEY")


@pytest.fixture
def state_path(monkeypatch, tmp_path):
    target = tmp_path / "state" / "ingest-state.json"
    monkeypatch.setenv(runstate.ENV_STATE_FILE, str(target))
    return target


@pytest.fixture
def clean_env(monkeypatch, tmp_path):
    for name in CLEAN_VARS:
        monkeypatch.delenv(name, raising=False)
    empty = tmp_path / "empty.env"
    empty.write_text("# nothing\n", encoding="utf-8")
    return empty


# --------------------------------------------------------------------------


def test_state_file_defaults_under_the_home_hooks_directory(monkeypatch):
    monkeypatch.delenv(runstate.ENV_STATE_FILE, raising=False)
    assert runstate.state_file().name == "ingest-state.json"
    assert "hooks" in runstate.state_file().parts


def test_the_env_var_overrides_the_default(state_path):
    assert runstate.state_file() == state_path


def test_recording_creates_the_directory_and_the_file(state_path):
    runstate.record_success(
        source="obsidian", path="C:/vault", documents=1320, chunks_written=12, now=NOW
    )

    payload = json.loads(state_path.read_text(encoding="utf-8"))
    assert payload["last_success"] == NOW.isoformat()
    assert payload["source"] == "obsidian"
    assert payload["documents"] == 1320
    assert payload["schema_version"] == runstate.SCHEMA_VERSION


def test_recording_twice_keeps_only_the_latest(state_path):
    runstate.record_success(source="obsidian", path="p", documents=1, chunks_written=1, now=NOW)
    later = NOW + timedelta(hours=24)
    runstate.record_success(source="obsidian", path="p", documents=2, chunks_written=2, now=later)

    record = runstate.read_last_success()
    assert record.completed_at == later
    assert record.documents == 2


def test_recording_leaves_no_temporary_file_behind(state_path):
    runstate.record_success(source="obsidian", path="p", documents=1, chunks_written=1, now=NOW)
    assert list(state_path.parent.glob("*.tmp")) == []


def test_reading_an_absent_file_is_none_not_an_error(state_path):
    assert runstate.read_last_success() is None


def test_a_corrupt_state_file_is_reported(state_path):
    state_path.parent.mkdir(parents=True)
    state_path.write_text("not json at all", encoding="utf-8")

    with pytest.raises(IngestError, match="unreadable"):
        runstate.read_last_success()


def test_a_state_file_without_a_timestamp_is_reported(state_path):
    state_path.parent.mkdir(parents=True)
    state_path.write_text(json.dumps({"source": "obsidian"}), encoding="utf-8")

    with pytest.raises(IngestError, match="last_success"):
        runstate.read_last_success()


def test_a_naive_timestamp_is_read_as_utc(state_path):
    state_path.parent.mkdir(parents=True)
    state_path.write_text(
        json.dumps({"last_success": "2026-09-15T09:00:00"}), encoding="utf-8"
    )
    assert runstate.read_last_success().completed_at == NOW


def test_a_z_suffixed_timestamp_is_accepted(state_path):
    state_path.parent.mkdir(parents=True)
    state_path.write_text(
        json.dumps({"last_success": "2026-09-15T09:00:00Z"}), encoding="utf-8"
    )
    assert runstate.read_last_success().completed_at == NOW


# --------------------------------------------------------------------------
# health
# --------------------------------------------------------------------------


def test_health_is_ok_inside_the_window(state_path):
    runstate.record_success(source="obsidian", path="p", documents=1, chunks_written=1, now=NOW)
    report = runstate.health(now=NOW + timedelta(hours=25))

    assert report.ok is True
    assert report.age_hours == pytest.approx(25.0)
    assert "within the 36 h threshold" in report.reason


def test_health_is_stale_past_the_window(state_path):
    runstate.record_success(source="obsidian", path="p", documents=1, chunks_written=1, now=NOW)
    report = runstate.health(now=NOW + timedelta(hours=37))

    assert report.ok is False
    assert "not running" in report.reason


def test_health_is_stale_when_nothing_was_ever_recorded(state_path):
    report = runstate.health(now=NOW)

    assert report.ok is False
    assert "has ever been recorded" in report.reason


def test_health_survives_a_corrupt_file_without_raising(state_path):
    state_path.parent.mkdir(parents=True)
    state_path.write_text("{", encoding="utf-8")

    report = runstate.health(now=NOW)
    assert report.ok is False
    assert report.record is None


def test_health_threshold_is_configurable(state_path):
    runstate.record_success(source="obsidian", path="p", documents=1, chunks_written=1, now=NOW)
    assert runstate.health(now=NOW + timedelta(hours=10), max_age_hours=6).ok is False


def test_a_zero_threshold_is_rejected(state_path):
    with pytest.raises(ValueError):
        runstate.health(now=NOW, max_age_hours=0)


# --------------------------------------------------------------------------
# the CLI flag
# --------------------------------------------------------------------------


def test_health_flag_exits_nonzero_when_nothing_ran(state_path, clean_env, capsys):
    code = main(["--health", "--env-file", str(clean_env)])
    out = capsys.readouterr().out

    assert code == 1
    assert "STALE" in out
    assert str(state_path) in out


def test_health_flag_exits_zero_when_recent(state_path, clean_env, capsys):
    runstate.record_success(
        source="obsidian", path="C:/vault", documents=1320, chunks_written=0
    )
    code = main(["--health", "--env-file", str(clean_env)])
    out = capsys.readouterr().out

    assert code == 0
    assert "OK" in out
    assert "C:/vault" in out


def test_health_flag_needs_no_source_or_path(state_path, clean_env, capsys):
    main(["--health", "--env-file", str(clean_env)])
    assert "--source and --path are both required" not in capsys.readouterr().err


def test_a_dry_run_never_records_success(state_path, clean_env, vault_path):
    main(["--source", "obsidian", "--path", str(vault_path), "--dry-run",
          "--env-file", str(clean_env)])
    assert not state_path.exists()


def test_a_limited_run_never_records_success(state_path, clean_env, vault_path):
    main(["--source", "obsidian", "--path", str(vault_path), "--dry-run", "--limit", "1",
          "--env-file", str(clean_env)])
    assert not state_path.exists()
