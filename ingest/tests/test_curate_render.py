"""Tests for ledger.md rendering and escaping (curate/render.py, R-C3 and SC-4)."""

from __future__ import annotations

import re

import pytest

from ingest.curate.ledger_state import reduce_issue
from ingest.curate.render import LedgerEntry, escape_inline, ledger_body, ledger_frontmatter, note_link
from ingest.curate.store_models import IssueEvent, new_issue

HOSTILE = "evil [[secret]] <script>alert(1)</script> a|b \n---\n# h `code` \\| ![x](http://e) %%hide%%"
NOTES = {"session-a": ("projects/demo/sessions/aaaa1111.md", "2026-09-01T10:00:00+00:00"),
         "session-b": ("projects/demo/sessions/bbbb2222.md", "2026-09-03T00:00:00+00:00")}


def event(kind: str, to_state: str | None, when: str, cause: str, ref: str, evidence: str | None = None,
          issue_id: str = "ISSUE-demo-001") -> IssueEvent:
    return IssueEvent(issue_id=issue_id, to_state=to_state, event_kind=kind, effective_at=when,
                      cause_type=cause, cause_ref=ref, evidence=evidence)


def entry(seq: int = 1, summary: str = "Store writes fail on reconnect", files=("ingest/src/store.py",),
          events=()) -> LedgerEntry:
    issue = new_issue("demo", seq, "bug", summary, files, "2026-09-01")
    return LedgerEntry(issue=issue, state=reduce_issue(issue.issue_id, events), files=tuple(files))


def full_entry() -> LedgerEntry:
    events = (
        event("found", "open", "2026-09-01T10:00:00", "note", "session-a", "the store dropped the write"),
        event("claim-fixed", "claimed-fixed", "2026-09-03", "note", "session-b", "fixed the reconnect"),
        event("fix-commit", "verified", "2026-09-04T12:00:00Z", "commit", "0123456789abcdef0123", "fix: reconnect"),
        event("merged-pr", "verified", "2026-09-05", "pr", "20", "Merge PR #20"),
        event("claim-workaround", None, "2026-09-06", "note", "gone-note", "restart it"),
    )
    return entry(events=events)


# -- escaping -----------------------------------------------------------------------------------


def test_escape_inline_neutralises_every_markup_that_could_escape_the_cell() -> None:
    out = escape_inline(HOSTILE)
    assert "\n" not in out
    assert "[[" not in out and "]]" not in out
    assert "<" not in out and ">" not in out
    assert "`" not in out.replace("\\`", "")
    assert re.search(r"(?<!\\)\|", out) is None  # every pipe escaped
    assert "%%" not in out
    assert "](" not in out.replace("\\](", "")


@pytest.mark.parametrize("text", ["# heading", "---", "- item", "> quote", "  #tag"])
def test_escaped_text_never_starts_with_markup(text: str) -> None:
    out = escape_inline(text)
    assert not out.startswith(("#", "-", ">"))


def test_escape_inline_keeps_plain_text_readable() -> None:
    assert escape_inline("Store writes fail on reconnect (90% of runs)") == \
        "Store writes fail on reconnect (90% of runs)"


def test_a_hostile_summary_evidence_and_file_cannot_break_the_ledger() -> None:
    events = (event("found", "open", "2026-09-01", "note", "session-a", HOSTILE),)
    body = ledger_body("demo", [entry(summary=HOSTILE, files=(HOSTILE,), events=events)], NOTES)
    assert "<script>" not in body and "[[secret]]" not in body
    assert "%%" not in body
    for line in body.splitlines():
        assert not line.startswith("---")
        if line.startswith("#"):
            assert re.match(r"^#{1,3} ", line), line  # only our own headings
    headings = [line for line in body.splitlines() if line.startswith("#")]
    assert headings == ["# demo issue ledger", "## Counts", "## Issues",
                        headings[3]] and headings[3].startswith("### ISSUE-demo-001 — ")
    table_rows = [line for line in body.splitlines() if line.startswith("| 20")]
    for row in table_rows:
        assert len(re.findall(r"(?<!\\)\|", row)) == 6  # five cells, never more


def test_a_path_unfit_for_a_wikilink_is_plain_text() -> None:
    assert note_link("projects/demo/sessions/a]]b.md", "2026-09-01T00:00:00+00:00") == \
        "projects/demo/sessions/a\\]\\]b (2026-09-01)"


# -- content ------------------------------------------------------------------------------------


def test_the_frontmatter_follows_sc4() -> None:
    fields = ledger_frontmatter("projects", "wa2 final", "2026-09-27T04:30:00+00:00", "c2-v1+abcd1234")
    assert fields == {
        "id": "curator-ledger-projects-wa2-final",
        "title": "wa2 final issue ledger",
        "type": "ledger",
        "captured_by": "curator",
        "collection": "wa2 final",
        "generated_at": "2026-09-27T04:30:00+00:00",
        "extractor_version": "c2-v1+abcd1234",
    }


def test_counts_by_state_come_first() -> None:
    open_issue = entry(1, events=(event("found", "open", "2026-09-01", "note", "session-a"),))
    body = ledger_body("demo", [full_entry(), open_issue], NOTES)
    counts = body.split("## Counts", 1)[1].split("## Issues", 1)[0]
    assert "| open | 1 |" in counts and "| verified | 1 |" in counts
    assert "| claimed-fixed | 0 |" in counts and "| regressed | 0 |" in counts
    assert "| total | 2 |" in counts


def test_each_transition_cites_its_cause() -> None:
    body = ledger_body("demo", [full_entry()], NOTES)
    assert "| 2026-09-01 | found | none → open | [[projects/demo/sessions/aaaa1111\\|2026-09-01]] |" in body
    assert "| 2026-09-03 | claim-fixed | open → claimed-fixed | [[projects/demo/sessions/bbbb2222\\|2026-09-03]] |" \
        in body
    assert "| 2026-09-04 | fix-commit | claimed-fixed → verified | commit 0123456 | fix: reconnect |" in body
    assert "| 2026-09-05 | merged-pr | verified (no change) | PR #20 | Merge PR #20 |" in body
    assert "| 2026-09-06 | claim-workaround | verified (no change) | note gone-note | restart it |" in body


def test_the_issue_section_has_state_kind_files_and_intervals() -> None:
    body = ledger_body("demo", [full_entry()], NOTES)
    section = body.split("### ISSUE-demo-001 — Store writes fail on reconnect", 1)[1]
    assert "- state: verified" in section
    assert "- kind: bug" in section
    assert "- files: ingest/src/store.py" in section
    assert "- valid: 2026-09-01 to 2026-09-04" in section
    assert "- sightings: 1" in section


def test_an_open_interval_says_so() -> None:
    body = ledger_body("demo", [entry(events=(event("found", "open", "2026-09-01", "note", "session-a"),))], NOTES)
    assert "- valid: 2026-09-01 to now" in body
    assert "- files: ingest/src/store.py" in body


def test_issues_are_in_id_order_and_output_is_deterministic() -> None:
    later, earlier = entry(12), entry(2)
    body = ledger_body("demo", [later, earlier], NOTES)
    assert body.index("ISSUE-demo-002") < body.index("ISSUE-demo-012")
    assert body == ledger_body("demo", [earlier, later], NOTES)
    assert not re.search(r"\d{2}:\d{2}", body)  # no timestamps in the body


def test_an_issue_without_files_says_none() -> None:
    body = ledger_body("demo", [entry(files=())], NOTES)
    assert "- files: none" in body


def test_an_empty_ledger_still_renders() -> None:
    body = ledger_body("demo", [], NOTES)
    assert "| total | 0 |" in body and "No issues yet." in body
