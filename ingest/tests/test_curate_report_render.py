"""The curation report page (curate/report_render.py, R-C6/R-C7): SC-4 frontmatter, the
candidate lines the tally reads back, the tally and score tables, and escaping."""

from __future__ import annotations

from ingest.curate.proposals import Candidate
from ingest.curate.report_render import (
    ScoreSummary,
    candidate_line,
    report_body,
    report_frontmatter,
    summarise_scores,
)
from ingest.curate.store_models import NoteScore
from ingest.curate.tally import MODE_AUTOMATIC, MODE_PROPOSALS, Mode, Round, Tick, parse_report_checkboxes

DAY = "2026-09-27"
INDEX = {
    "session-a--1": ("projects/demo/sessions/a--1.md", "2026-09-20T11:00:00+00:00"),
    "note-b": ("projects/demo/notes/b.md", "2026-09-21T00:00:00+00:00"),
    "note-z": ("projects/zeta/notes/z.md", "2026-09-22T00:00:00+00:00"),
}
MODES = {"condense": Mode(MODE_PROPOSALS, 0), "prune": Mode(MODE_PROPOSALS, 0)}


def condense(note_id: str = "session-a--1", collection: str = "demo", reasons=("subagent of session-a",),
             no_loss: bool = True) -> Candidate:
    return Candidate(note_id, "condense", collection, tuple(reasons), no_loss,
                     INDEX.get(note_id, (f"projects/{collection}/{note_id}.md",))[0])


def prune(note_id: str = "note-b", collection: str = "demo", reasons=("body 12 chars",), no_loss: bool = True):
    return Candidate(note_id, "prune", collection, tuple(reasons), no_loss,
                     INDEX.get(note_id, (f"projects/{collection}/{note_id}.md",))[0])


def body(candidates=(), modes=MODES, rounds=(), summaries=(), **kwargs) -> str:
    return report_body(DAY, candidates, modes, rounds, summaries, INDEX, **kwargs)


def test_frontmatter_is_sc4() -> None:
    assert report_frontmatter("projects", DAY, "2026-09-27T04:30:00+00:00", "c6-v1+abcd1234") == {
        "id": "curator-curation-projects-2026-09-27",
        "title": "curation report 2026-09-27",
        "type": "curation-report",
        "captured_by": "curator",
        "realm": "projects",
        "generated_at": "2026-09-27T04:30:00+00:00",
        "scorer_version": "c6-v1+abcd1234",
    }


def test_the_candidate_line_is_exact() -> None:
    assert candidate_line(condense(reasons=("subagent of session-a", "no commit or PR")), INDEX) == (
        "- [ ] condense `session-a--1` [[projects/demo/sessions/a--1|2026-09-20]] — "
        "subagent of session-a; no commit or PR (no-loss: yes)")
    assert candidate_line(prune(no_loss=False), INDEX, checked=True) == (
        "- [x] prune `note-b` [[projects/demo/notes/b|2026-09-21]] — body 12 chars (no-loss: no)")


def test_candidate_lines_round_trip_through_the_parser() -> None:
    page = body([condense(), prune(), prune("note-z", "zeta")], accepted={("note-b", "prune")})
    assert parse_report_checkboxes(page) == (
        Tick("condense", "session-a--1", False),
        Tick("prune", "note-b", True),
        Tick("prune", "note-z", False),
    )


def test_page_layout_and_empty_sections() -> None:
    page = body()
    lines = page.splitlines()
    assert lines[0] == "# Curation report 2026-09-27"
    assert "Tick a box to accept the proposal; the next run records it." in page
    for heading in ("## Tally", "## Condense candidates", "## Prune candidates", "## Scores"):
        assert heading in lines
    assert page.count("No candidates.") == 2
    assert page.endswith("\n") and not page.endswith("\n\n")


def test_candidates_are_sorted_by_collection_then_note_id() -> None:
    page = body([prune("note-z", "alpha"), prune("note-b", "demo"), prune("note-a", "demo")])
    order = [tick.note_id for tick in parse_report_checkboxes(page)]
    assert order == ["note-z", "note-a", "note-b"]


def test_a_note_without_a_safe_link_renders_as_text() -> None:
    line = candidate_line(prune("note-q", reasons=("r",)), {"note-q": ("projects/demo/[[odd]].md", "2026-09-21")})
    assert "(2026-09-21)" in line and "[[projects/demo/[[odd" not in line
    missing = candidate_line(prune("note-gone", reasons=("r",)), {})
    assert "projects/demo/note-gone.md (undated)" in missing


def test_untrusted_reasons_and_titles_are_escaped() -> None:
    hostile = "a | b [[evil]] <b>bold</b>"
    page = body([condense(reasons=(f"subagent of {hostile}",))],
                summaries=[ScoreSummary(collection=f"demo {hostile}", scored=1, mean_impact=1.0,
                                        importance_asked=0, top=(("note-b", 1.0),))])
    assert "[[evil]]" not in page and "<b>" not in page
    assert "a \\| b \\[\\[evil\\]\\] &lt;b&gt;bold&lt;/b&gt;" in page
    (tick,) = parse_report_checkboxes(page)
    assert tick.note_id == "session-a--1"


def test_a_note_id_with_a_backtick_or_newline_is_cleaned_and_flagged() -> None:
    line = candidate_line(prune("note`x\ny", reasons=("r",)), {})
    assert "`notexy`" in line and "\n" not in line
    assert "note id altered for display" in line
    (tick,) = parse_report_checkboxes(line)
    assert tick.note_id == "notexy"


def test_the_tally_table() -> None:
    rounds = (
        Round("2026-09-13", "prune", 10, 10, 0, 0, True),
        Round("2026-09-20", "prune", 50, 47, 3, 0, False),
        Round("2026-09-27", "prune", 4, 0, 0, 4, True),
    )
    page = body(rounds=rounds, modes={"condense": Mode(MODE_PROPOSALS, 0), "prune": Mode(MODE_AUTOMATIC, 3)})
    assert "| 2026-09-13 | 10 | 10 | 0 | 0 | 100% | yes |" in page
    assert "| 2026-09-20 | 50 | 47 | 3 | 0 | 94% | no |" in page
    assert "| 2026-09-27 (open) | 4 | 0 | 0 | 4 | 0% | yes |" in page
    assert "Mode: automatic; streak 3 of 3" in page
    assert "No condense proposals yet." in page


def test_the_scores_table() -> None:
    notes = {
        note_id: NoteScore(note_id=note_id, scorer_version="v", run_day=DAY, content_hash="h", collection="demo",
                           impact=impact, relevance=0.1, features={}, importance=importance)
        for note_id, impact, importance in (("note-b", 2.5, None), ("session-a--1", 7.25, 4), ("note-c", 0.0, None),
                                            ("note-d", 1.0, None), ("note-e", 1.0, None), ("note-f", 0.5, None))
    }
    summary = summarise_scores("demo", notes)
    assert summary == ScoreSummary("demo", 6, 2.04, 1, (("session-a--1", 7.25), ("note-b", 2.5), ("note-d", 1.0),
                                                       ("note-e", 1.0), ("note-f", 0.5)))
    page = body(summaries=[summary])
    assert "### demo" in page
    assert "| 6 | 2.04 | 1 |" in page
    assert "| [[projects/demo/sessions/a--1\\|2026-09-20]] | 7.25 |" in page
    assert "| note-d | 1.00 |" in page  # not in the index: its id as text


def test_the_body_is_deterministic_and_carries_no_timestamp() -> None:
    candidates = [prune("note-z", "zeta"), condense(), prune()]
    first = body(candidates)
    assert body(list(reversed(candidates))) == first
    assert "T04:" not in first and "+00:00" not in first
