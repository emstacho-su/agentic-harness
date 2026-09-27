"""Tests for history.md's frontmatter and body (curate/history_render.py, R-C5).

The acceptance test for R-C5 is here: every citation in the rendered history
resolves to a note the inventory holds.
"""

from __future__ import annotations

import re
from pathlib import Path

from ingest.curate.history_render import history_body, history_frontmatter
from ingest.curate.store_models import HistoryWeek, InMemoryCurateStore

from test_curate_history import (
    HVERSION,
    add_session,
    add_subagent,
    inventory,
    labels_in,
    make_vault,
    run,
)
from ingest.curate.judge import FakeJudge

WIKILINK = re.compile(r"\[\[([^\]|]+)\|([^\]]+)\]\]")


def built(vault: Path, answer=None):
    judge = FakeJudge(answer or (lambda prompt, schema: {
        "paragraphs": [{"text": f"Worked on {len(labels_in(prompt))} things.", "cites": labels_in(prompt)}],
        "titles": [{"ref": "S1", "title": "built the week"}],
    }))
    result, _ = run(inventory(vault), InMemoryCurateStore(), judge)
    return result


def render(result) -> str:
    return history_body(result.collection, result.weeks, result.narratives, result.note_index)


def two_weeks(tmp_path: Path) -> Path:
    root = make_vault(tmp_path)
    add_session(root, "a", "2026-09-15")
    add_subagent(root, "a", "x", "2026-09-15")
    add_session(root, "b", "2026-09-22")
    return root


def test_the_frontmatter_follows_sc4() -> None:
    fields = history_frontmatter("projects", "wta dog finder", "2026-09-27T04:30:00+00:00", "c5-v1+abcdef01")
    assert fields == {
        "id": "curator-history-projects-wta-dog-finder",
        "title": "wta dog finder history",
        "type": "history",
        "captured_by": "curator",
        "collection": "wta dog finder",
        "generated_at": "2026-09-27T04:30:00+00:00",
        "history_version": "c5-v1+abcdef01",
    }


def test_every_citation_resolves_to_a_note_in_the_index(tmp_path: Path) -> None:
    """R-C5 acceptance: every citation in history.md resolves to a note."""
    vault = two_weeks(tmp_path)
    result = built(vault)
    body = render(result)
    paths = {path for path, _ in result.note_index.values()}
    cited = [line for line in body.splitlines() if line.startswith("— ")]
    assert cited, "the history cites nothing"
    for line in cited:
        links = WIKILINK.findall(line)
        assert links and len(links) == line.count("[[")
        for target, day in links:
            assert f"{target}.md" in paths
            assert (vault / f"{target}.md").is_file()
            assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", day)


def test_the_body_lists_weeks_in_order_with_paragraphs_citations_and_sessions(tmp_path: Path) -> None:
    body = render(built(two_weeks(tmp_path)))
    lines = body.splitlines()
    assert lines[0] == "# demo history"
    weeks = [line for line in lines if line.startswith("## ")]
    assert weeks == ["## Week of 2026-09-14", "## Week of 2026-09-21"]
    first = body.split("## Week of 2026-09-21")[0]
    assert "Worked on 2 things.\n— [[projects/demo/sessions/a|2026-09-15]], " \
           "[[projects/demo/sessions/a--x|2026-09-15]]" in first
    assert "Sessions:\n\n- [[projects/demo/sessions/a|2026-09-15]] Title a → built the week\n" \
           "- [[projects/demo/sessions/a--x|2026-09-15]] Title a--x\n" in first


def test_a_week_without_a_narrative_says_pending(tmp_path: Path) -> None:
    vault = two_weeks(tmp_path)
    result, _ = run(inventory(vault), InMemoryCurateStore(), None, dry_run=True)
    body = render(result)
    assert body.count("narrative pending") == 2
    assert "- [[projects/demo/sessions/b|2026-09-22]] Title b" in body
    assert "→" not in body


def test_a_cached_week_with_no_surviving_paragraph_says_so(tmp_path: Path) -> None:
    vault = two_weeks(tmp_path)
    result = built(vault, lambda p, s: {"paragraphs": [], "titles": []})
    body = render(result)
    assert "narrative pending" not in body
    assert body.count("No paragraph of this week's narrative cited a session.") == 2


def test_untrusted_text_is_escaped(tmp_path: Path) -> None:
    vault = two_weeks(tmp_path)
    nasty = "See [[secret|x]] and <script>alert(1)</script> | a pipe"
    result = built(vault, lambda p, s: {"paragraphs": [{"text": nasty, "cites": ["S1"]}],
                                        "titles": [{"ref": "S1", "title": "# [[t]] <b>"}]})
    body = render(result)
    assert "<script>" not in body and "[[secret" not in body
    assert "See \\[\\[secret\\|x\\]\\] and &lt;script&gt;alert(1)&lt;/script&gt; \\| a pipe" in body
    assert "→ \\# \\[\\[t\\]\\] &lt;b&gt;" in body


def test_a_title_from_the_note_is_escaped(tmp_path: Path) -> None:
    root = make_vault(tmp_path)
    add_session(root, "a", "2026-09-15")
    note = root / "projects" / "demo" / "sessions" / "a.md"
    note.write_text(note.read_text(encoding="utf-8").replace("title: 'Title a'", "title: '[[evil]] <i>'"),
                    encoding="utf-8")
    body = render(built(root))
    assert "\\[\\[evil\\]\\] &lt;i&gt;" in body and "[[evil]]" not in body


def test_the_body_is_deterministic(tmp_path: Path) -> None:
    vault = two_weeks(tmp_path)
    result = built(vault)
    reordered = dict(reversed(list(result.narratives.items())))
    assert render(result) == history_body(result.collection, tuple(reversed(result.weeks)), reordered,
                                          result.note_index)
    assert "2026-09-27" not in render(result) and "T00:00" not in render(result)


def test_cites_render_in_timeline_order_whatever_the_stored_order(tmp_path: Path) -> None:
    vault = two_weeks(tmp_path)
    result = built(vault)
    week = result.weeks[0]
    ids = [r.record.note_id for r in week.records]
    swapped = HistoryWeek("demo", week.week_start, week.input_hash, HVERSION,
                          ({"text": "p", "note_ids": list(reversed(ids))},), {})
    body = history_body("demo", result.weeks, {**result.narratives, week.week_start: swapped}, result.note_index)
    assert "p\n— [[projects/demo/sessions/a|2026-09-15]], [[projects/demo/sessions/a--x|2026-09-15]]" in body


def test_an_empty_collection_renders_a_stub() -> None:
    body = history_body("demo", (), {}, {})
    assert body.startswith("# demo history\n") and "No dated sessions yet." in body
    assert body.endswith("\n") and not body.endswith("\n\n")
