"""The 24 h conclude sweep.

The fixtures under ``fixtures/session-vault`` carry the frozen R-27.2 / R-27.3
frontmatter names. Every test that writes copies them into ``tmp_path`` first,
so the committed fixtures stay pristine and each test starts from the same bytes.
"""

from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path

import pytest

from ingest.cli import main
from ingest.sweep import Action, merge_conclusion, sweep_concluded

FIXTURES = Path(__file__).parent / "fixtures"

# Fixed clock. active-stale ended 2026-09-10T12:00Z (>24 h before) and
# active-fresh ended 2026-09-15T08:00Z (1 h before).
NOW = datetime(2026, 9, 15, 9, 0, 0, tzinfo=timezone.utc)

SESSIONS = "projects/bb2dash/sessions"


@pytest.fixture
def session_vault(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    shutil.copytree(FIXTURES / "session-vault", vault)
    return vault


def read(vault: Path, relative: str) -> str:
    return (vault / relative).read_bytes().decode("utf-8")


# --------------------------------------------------------------------------
# what the sweep decides
# --------------------------------------------------------------------------


def test_stale_active_notes_are_concluded(session_vault):
    result = sweep_concluded(session_vault, now=NOW, apply=True)

    concluded = {o.relative for o in result.of(Action.CONCLUDED)}
    assert concluded == {f"{SESSIONS}/active-stale.md", f"{SESSIONS}/manual-tags.md"}


def test_a_concluded_note_gains_both_keys(session_vault):
    sweep_concluded(session_vault, now=NOW, apply=True)
    text = read(session_vault, f"{SESSIONS}/active-stale.md")

    assert "status: concluded\n" in text
    assert f"concluded_at: {NOW.isoformat()}\n" in text
    assert "status: active" not in text


def test_a_fresh_active_note_is_untouched(session_vault):
    before = read(session_vault, f"{SESSIONS}/active-fresh.md")
    result = sweep_concluded(session_vault, now=NOW, apply=True)

    assert read(session_vault, f"{SESSIONS}/active-fresh.md") == before
    assert [o.relative for o in result.of(Action.STILL_FRESH)] == [f"{SESSIONS}/active-fresh.md"]


def test_an_already_concluded_note_is_untouched(session_vault):
    before = read(session_vault, f"{SESSIONS}/already-concluded.md")
    result = sweep_concluded(session_vault, now=NOW, apply=True)

    assert read(session_vault, f"{SESSIONS}/already-concluded.md") == before
    left = {o.relative for o in result.of(Action.NOT_ACTIVE)}
    assert f"{SESSIONS}/already-concluded.md" in left


def test_a_superseded_note_is_untouched_and_never_regresses(session_vault):
    before = read(session_vault, f"{SESSIONS}/superseded.md")
    sweep_concluded(session_vault, now=NOW, apply=True)

    after = read(session_vault, f"{SESSIONS}/superseded.md")
    assert after == before
    assert "status: superseded" in after


def test_a_note_without_status_is_refused_not_guessed(session_vault):
    before = read(session_vault, f"{SESSIONS}/no-status.md")
    result = sweep_concluded(session_vault, now=NOW, apply=True)

    assert read(session_vault, f"{SESSIONS}/no-status.md") == before
    refused = {o.relative: o.detail for o in result.refused}
    assert f"{SESSIONS}/no-status.md" in refused
    assert "no 'status'" in refused[f"{SESSIONS}/no-status.md"]


def test_non_session_notes_are_ignored_entirely(session_vault):
    before = read(session_vault, "projects/bb2dash/notes/plain.md")
    result = sweep_concluded(session_vault, now=NOW, apply=True)

    assert read(session_vault, "projects/bb2dash/notes/plain.md") == before
    assert all("notes/plain.md" not in o.relative for o in result.outcomes)


def test_scanned_counts_only_session_notes(session_vault):
    result = sweep_concluded(session_vault, now=NOW)
    assert result.scanned == 6


# --------------------------------------------------------------------------
# merge, not rewrite
# --------------------------------------------------------------------------


def test_manual_tags_and_unknown_keys_survive_byte_for_byte(session_vault):
    before = read(session_vault, f"{SESSIONS}/manual-tags.md").splitlines(keepends=True)
    sweep_concluded(session_vault, now=NOW, apply=True)
    after = read(session_vault, f"{SESSIONS}/manual-tags.md").splitlines(keepends=True)

    changed = [line for line in after if line not in before]
    assert len(changed) == 2  # the rewritten status line and the new concluded_at
    assert any(line.startswith("status:") for line in changed)
    assert any(line.startswith("concluded_at:") for line in changed)

    # Everything that is not those two lines is identical, in the same order.
    survivors_before = [line for line in before if not line.startswith("status:")]
    survivors_after = [
        line for line in after
        if not line.startswith("status:") and not line.startswith("concluded_at:")
    ]
    assert survivors_after == survivors_before

    text = "".join(after)
    assert "  - stack-read-this\n" in text
    assert 'stack_note: "keep this note, it has the migration reasoning"\n' in text
    assert "custom_field_the_hook_never_writes: 42\n" in text


def test_the_inline_comment_on_the_status_line_survives(session_vault):
    sweep_concluded(session_vault, now=NOW, apply=True)
    text = read(session_vault, f"{SESSIONS}/manual-tags.md")
    assert "status:    concluded        # set by the hook, concluded by the nightly sweep" in text


def test_the_body_is_never_touched(session_vault):
    before = read(session_vault, f"{SESSIONS}/active-stale.md").split("---\n", 2)[2]
    sweep_concluded(session_vault, now=NOW, apply=True)
    after = read(session_vault, f"{SESSIONS}/active-stale.md").split("---\n", 2)[2]
    assert after == before


def test_crlf_line_endings_are_preserved(tmp_path):
    vault = tmp_path / "vault"
    sessions = vault / "projects" / "x" / "sessions"
    sessions.mkdir(parents=True)
    note = sessions / "crlf.md"
    body = (
        "---\r\n"
        "id: session-crlf\r\n"
        "type: session\r\n"
        "ended_at: 2026-09-01T00:00:00+00:00\r\n"
        "status: active\r\n"
        "---\r\n"
        "\r\n"
        "# CRLF\r\n"
        "\r\n"
        "Body text.\r\n"
    )
    note.write_bytes(body.encode("utf-8"))

    sweep_concluded(vault, now=NOW, apply=True)

    written = note.read_bytes().decode("utf-8")
    assert "\r\n" in written
    assert "\n" not in written.replace("\r\n", "")  # not one bare LF was introduced
    assert "status: concluded\r\n" in written
    assert f"concluded_at: {NOW.isoformat()}\r\n" in written


def test_an_existing_concluded_at_is_replaced_not_duplicated():
    raw = (
        "---\n"
        "type: session\n"
        "status: active\n"
        "concluded_at: 2020-01-01T00:00:00+00:00\n"
        "---\n\nBody.\n"
    )
    merged = merge_conclusion(raw, concluded_at=NOW)

    assert merged.count("concluded_at:") == 1
    assert f"concluded_at: {NOW.isoformat()}\n" in merged
    assert "2020-01-01" not in merged


def test_a_nested_status_key_is_not_mistaken_for_the_top_level_one():
    raw = (
        "---\n"
        "type: session\n"
        "meta:\n"
        "  status: active\n"
        "status: active\n"
        "---\n\nBody.\n"
    )
    merged = merge_conclusion(raw, concluded_at=NOW)

    assert "  status: active\n" in merged  # the nested one is untouched
    assert "\nstatus: concluded\n" in merged


def test_a_note_without_frontmatter_is_refused():
    with pytest.raises(ValueError, match="no YAML frontmatter"):
        merge_conclusion("# Just a heading\n", concluded_at=NOW)


def test_an_unclosed_frontmatter_block_is_refused():
    with pytest.raises(ValueError, match="never closed"):
        merge_conclusion("---\ntype: session\nstatus: active\n", concluded_at=NOW)


# --------------------------------------------------------------------------
# dry run
# --------------------------------------------------------------------------


def test_a_dry_run_writes_nothing(session_vault):
    before = {p: p.read_bytes() for p in session_vault.rglob("*.md")}
    result = sweep_concluded(session_vault, now=NOW, apply=False)

    assert result.applied is False
    assert len(result.of(Action.CONCLUDED)) == 2
    assert {p: p.read_bytes() for p in session_vault.rglob("*.md")} == before


def test_a_second_apply_is_a_no_op(session_vault):
    sweep_concluded(session_vault, now=NOW, apply=True)
    after_first = {p: p.read_bytes() for p in session_vault.rglob("*.md")}

    second = sweep_concluded(session_vault, now=NOW, apply=True)

    assert second.of(Action.CONCLUDED) == ()
    assert {p: p.read_bytes() for p in session_vault.rglob("*.md")} == after_first


def test_the_staleness_window_is_configurable(session_vault):
    # With a 1 h window the "fresh" note (ended 1 h ago) also falls over the edge.
    result = sweep_concluded(session_vault, now=NOW, stale_after_hours=1, apply=False)
    concluded = {o.relative for o in result.of(Action.CONCLUDED)}
    assert f"{SESSIONS}/active-fresh.md" in concluded


def test_a_zero_window_is_rejected(session_vault):
    with pytest.raises(ValueError):
        sweep_concluded(session_vault, now=NOW, stale_after_hours=0)


def test_a_missing_vault_is_an_error(tmp_path):
    from ingest.errors import SourceError

    with pytest.raises(SourceError):
        sweep_concluded(tmp_path / "nope", now=NOW)


# --------------------------------------------------------------------------
# the subcommand
# --------------------------------------------------------------------------


def test_sweep_subcommand_defaults_to_a_dry_run(session_vault, capsys):
    before = {p: p.read_bytes() for p in session_vault.rglob("*.md")}
    code = main(["sweep-concluded", "--path", str(session_vault)])
    out = capsys.readouterr().out

    assert code == 0
    assert "dry run" in out
    assert "2  concluded" in out.replace("     ", "  ")
    assert {p: p.read_bytes() for p in session_vault.rglob("*.md")} == before


def test_sweep_subcommand_applies_only_when_asked(session_vault, capsys):
    code = main(["sweep-concluded", "--path", str(session_vault), "--apply"])
    out = capsys.readouterr().out

    assert code == 0
    assert "status: concluded" in read(session_vault, f"{SESSIONS}/active-stale.md")
    assert "dry run" not in out


def test_sweep_subcommand_reports_refusals_on_stderr(session_vault, capsys):
    main(["sweep-concluded", "--path", str(session_vault)])
    captured = capsys.readouterr()
    assert "no-status.md" in captured.err


def test_sweep_subcommand_refuses_both_flags(session_vault, capsys):
    code = main(["sweep-concluded", "--path", str(session_vault), "--apply", "--dry-run"])
    assert code == 2
    assert "--apply" in capsys.readouterr().err


def test_sweep_subcommand_requires_a_path(capsys):
    with pytest.raises(SystemExit):
        main(["sweep-concluded"])


def test_sweep_subcommand_reports_a_missing_vault(tmp_path, capsys):
    code = main(["sweep-concluded", "--path", str(tmp_path / "nope")])
    assert code == 1
    assert "does not exist" in capsys.readouterr().err


def test_sweep_subcommand_exit_code_is_zero_with_refusals(session_vault):
    # A refusal is information for the operator, not a failed job: exiting
    # non-zero would make the nightly task report failure every single night.
    assert main(["sweep-concluded", "--path", str(session_vault)]) == 0
