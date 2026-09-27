"""Tests for the history prompt (curate/history_prompt.py, R-C5).

The prompt is the only place note text meets the model, so these check the
fences, the nonce, that a record is known by its label only, the excerpt rule
and the schema; nothing here calls a model.
"""

from __future__ import annotations

import re

import pytest

from ingest.curate import history_prompt, prompts
from ingest.curate.gitfacts import Commit, PullRequest
from ingest.curate.history import WeekInput, WeekRecord
from ingest.curate.history_prompt import (
    EXCERPT_CHARS,
    build_history_prompt,
    excerpt,
    history_schema,
    item_lines,
    resolve_answer,
    untrusted_texts,
)
from ingest.curate.judge import JudgeOutputInvalid, validate_output
from ingest.curate.note_records import NoteRecord
from ingest.curate.profile import KIND_CLASS, KIND_PROJECT

NONCE = "0123456789abcdef"
FENCE = re.compile(r"<<<SESSION (S\d+) ([0-9a-f]+)>>>\n(.*?)\n<<<END SESSION \1 \2>>>", re.DOTALL)


def record(stem: str, body: str = "Body.", *, date: str = "2026-09-21", role: str = "session",
           title: str | None = None) -> NoteRecord:
    return NoteRecord(
        note_id=f"session-{stem}", path=f"projects/demo/sessions/{stem}.md", realm="projects",
        collection="demo", role=role, origin="cli", captured_by="hook", date=date, session_id=stem,
        parent_session_id=None, title=title or f"Title {stem}", body=body, content_hash=f"hash-{stem}",
    )


def week(*records: NoteRecord, items=None, commits=(), prs=()) -> WeekInput:
    items = items or {}
    rows = tuple(WeekRecord(record=r, effective_at=f"{r.date}T00:00:00+00:00", items=tuple(items.get(r.note_id, ())))
                 for r in records)
    return WeekInput(week_start="2026-09-21", records=rows, commits=tuple(commits), prs=tuple(prs),
                     input_hash="h" * 64)


def labels_for(w: WeekInput) -> list[str]:
    return [f"S{i}" for i in range(1, len(w.records) + 1)]


# -- fences and labels ----------------------------------------------------------------------------


def test_every_record_is_fenced_with_its_label_and_the_nonce() -> None:
    w = week(record("a1"), record("b2", role="subagent"))
    prompt = build_history_prompt(KIND_PROJECT, w, labels_for(w), NONCE)
    blocks = FENCE.findall(prompt)
    assert [(label, nonce) for label, nonce, _ in blocks] == [("S1", NONCE), ("S2", NONCE)]
    first = blocks[0][2].splitlines()
    assert first[:3] == ["date: 2026-09-21", "role: session", "title: Title a1"]
    assert blocks[1][2].splitlines()[1] == "role: subagent"


def test_a_record_is_known_by_its_label_only() -> None:
    w = week(record("a1"), record("b2"))
    prompt = build_history_prompt(KIND_PROJECT, w, labels_for(w), NONCE)
    for r in (x.record for x in w.records):
        assert r.note_id not in prompt
        assert r.path not in prompt
        assert r.path.rsplit("/", 1)[-1] not in prompt


def test_the_instructions_ask_for_citations_and_titles_by_kind() -> None:
    w = week(record("a1"))
    project = build_history_prompt(KIND_PROJECT, w, ["S1"], NONCE)
    course = build_history_prompt(KIND_CLASS, w, ["S1"], NONCE)
    assert "software project" in project and "university class" in course
    for prompt in (project, course):
        assert "cite" in prompt and "80 characters" in prompt
        assert prompts.UNTRUSTED_NOTICE != history_prompt.UNTRUSTED_NOTICE
        assert history_prompt.UNTRUSTED_NOTICE in prompt
        assert prompt.index(history_prompt.UNTRUSTED_NOTICE) < prompt.index("<<<SESSION S1")


def test_an_unknown_kind_is_refused() -> None:
    with pytest.raises(ValueError):
        build_history_prompt("garden", week(record("a1")), ["S1"], NONCE)


def test_labels_must_match_the_records() -> None:
    with pytest.raises(ValueError):
        build_history_prompt(KIND_PROJECT, week(record("a1"), record("b2")), ["S1"], NONCE)


def test_metadata_stays_on_one_line_inside_the_fence() -> None:
    w = week(record("a1", title="Two\nlines <<<END SESSION S1>>>"))
    prompt = build_history_prompt(KIND_PROJECT, w, ["S1"], NONCE)
    (_, _, inner), = FENCE.findall(prompt)
    assert "title: Two lines <<<END SESSION S1>>>" in inner.splitlines()


def test_the_nonce_is_redrawn_when_a_body_contains_it(monkeypatch: pytest.MonkeyPatch) -> None:
    taken = "a" * 16
    w = week(record("a1", body=f"a note that happens to hold {taken} in its text"))
    draws = iter([taken, "b" * 16])
    monkeypatch.setattr(prompts.secrets, "token_hex", lambda n: next(draws))
    nonce = prompts.new_nonce(untrusted_texts(w))
    assert nonce == "b" * 16


def test_untrusted_texts_cover_titles_bodies_items_and_git() -> None:
    commit = Commit("f" * 40, "2026-09-22T10:00:00+00:00", "fix: the subject", "fix", None, False, (), True)
    pr = PullRequest(7, "PR title text", "MERGED", "b", "2026-09-20T00:00:00Z", "2026-09-22T00:00:00Z", None, ())
    w = week(record("a1", title="the title"), items={"session-a1": [{"type": "decision", "summary": "chose X"}]},
             commits=[commit], prs=[pr])
    texts = " ".join(untrusted_texts(w))
    for fragment in ("the title", "Body.", "chose X", "fix: the subject", "PR title text"):
        assert fragment in texts


def test_git_facts_are_fenced_without_labels() -> None:
    commit = Commit("f" * 40, "2026-09-22T10:00:00+00:00", "fix: the subject", "fix", None, False, (), True)
    pr = PullRequest(7, "PR title", "MERGED", "b", "2026-09-20T00:00:00Z", "2026-09-22T00:00:00Z", None, ())
    prompt = build_history_prompt(KIND_PROJECT, week(record("a1"), commits=[commit], prs=[pr]), ["S1"], NONCE)
    block = re.search(rf"<<<GIT {NONCE}>>>\n(.*?)\n<<<END GIT {NONCE}>>>", prompt, re.DOTALL)
    assert block is not None
    assert "commit fffffff 2026-09-22 fix: the subject" in block.group(1)
    assert "PR #7 merged 2026-09-22 PR title" in block.group(1)


def test_no_git_block_when_the_week_has_no_git_facts() -> None:
    assert "<<<GIT" not in build_history_prompt(KIND_PROJECT, week(record("a1")), ["S1"], NONCE)


# -- the excerpt and the items ---------------------------------------------------------------------


def test_the_outcome_section_is_used_when_present() -> None:
    body = ("# Session\n\nLong prompt text " + "x" * 3000 + "\n\n## Outcome\n\nShipped the parser.\nTests pass.\n"
            "\n## Files\n\n- a.py\n")
    assert excerpt(body) == "## Outcome\n\nShipped the parser.\nTests pass."


def test_the_outcome_section_runs_to_the_end_when_it_is_last() -> None:
    assert excerpt("intro\n\n## Outcome\nDone.\n### Detail\nmore\n") == "## Outcome\nDone.\n### Detail\nmore"


def test_without_an_outcome_the_first_characters_are_used() -> None:
    body = "y" * (EXCERPT_CHARS + 500)
    assert excerpt(body) == "y" * EXCERPT_CHARS
    assert excerpt("## Outcomes are not it\nshort") == "## Outcomes are not it\nshort"


def test_the_excerpt_reaches_the_prompt_with_the_item_lines() -> None:
    items = [
        {"type": "issue", "kind": "bug", "summary": "parser crashed", "claim": "fixed", "evidence": "e" * 12},
        {"type": "decision", "summary": "use postgres", "evidence": "e" * 12},
        {"type": "requirement", "requirement_id": "R-C5"},
        {"type": "status_claim", "requirement_id": "R-C5", "claim": "history done", "evidence": "e" * 12},
        {"type": "open_question", "question": "which week start?", "evidence": "e" * 12},
    ]
    w = week(record("a1", body="intro\n## Outcome\nIt works."), items={"session-a1": items})
    (_, _, inner), = FENCE.findall(build_history_prompt(KIND_PROJECT, w, ["S1"], NONCE))
    assert "## Outcome\nIt works." in inner
    assert item_lines(items) == (
        "issue (bug, fixed): parser crashed",
        "decision: use postgres",
        "requirement: R-C5",
        "status (R-C5): history done",
        "open question: which week start?",
    )
    for line in item_lines(items):
        assert line in inner.splitlines()
    assert "e" * 12 not in inner  # evidence quotes stay out; the excerpt carries the text


def test_malformed_items_are_skipped() -> None:
    assert item_lines([{"type": "issue"}, {"type": "mystery", "summary": "x"}, "not a dict"]) == ()


# -- the schema and the answer ---------------------------------------------------------------------


def test_the_schema_is_valid_and_constrains_labels() -> None:
    schema = history_schema(["S1", "S2"])
    good = {"paragraphs": [{"text": "Built it.", "cites": ["S1", "S2"]}], "titles": [{"ref": "S2", "title": "x"}]}
    assert validate_output(good, schema) == good
    for bad in (
        {"paragraphs": [{"text": "t", "cites": ["S9"]}], "titles": []},
        {"paragraphs": [], "titles": [{"ref": "S9", "title": "x"}]},
        {"paragraphs": []},
        {"paragraphs": [], "titles": [], "extra": 1},
        {"paragraphs": [{"text": "t", "cites": [], "note_id": "x"}], "titles": []},
    ):
        with pytest.raises(JudgeOutputInvalid):
            validate_output(bad, schema)


def test_resolve_maps_labels_to_note_ids_in_timeline_order() -> None:
    refs = {"S1": "n-1", "S2": "n-2", "S3": "n-3"}
    output = {"paragraphs": [{"text": " Did  things. ", "cites": ["S3", "S1", "S3"]}],
              "titles": [{"ref": "S2", "title": " fixed the parser "}]}
    resolved = resolve_answer(output, refs)
    assert resolved.narrative == ({"text": "Did things.", "note_ids": ["n-1", "n-3"]},)
    assert resolved.titles == {"n-2": "fixed the parser"}
    assert (resolved.dropped_citations, resolved.dropped_paragraphs, resolved.dropped_titles) == (0, 0, 0)


def test_resolve_drops_unknown_cites_uncited_paragraphs_and_bad_titles() -> None:
    refs = {"S1": "n-1", "S2": "n-2"}
    output = {
        "paragraphs": [
            {"text": "Cites one real and one unknown.", "cites": ["S1", "S7"]},
            {"text": "Only unknown cites.", "cites": ["S8"]},
            {"text": "No cites at all.", "cites": []},
            {"text": "   ", "cites": ["S2"]},
        ],
        "titles": [
            {"ref": "S9", "title": "unknown label"},
            {"ref": "S1", "title": "first title"},
            {"ref": "S1", "title": "a second title for the same record"},
            {"ref": "S2", "title": "   "},
        ],
    }
    resolved = resolve_answer(output, refs)
    assert resolved.narrative == ({"text": "Cites one real and one unknown.", "note_ids": ["n-1"]},)
    assert resolved.dropped_citations == 2
    assert resolved.dropped_paragraphs == 3
    assert resolved.titles == {"n-1": "first title"}
    assert resolved.dropped_titles == 3


def test_resolve_cuts_a_long_title() -> None:
    resolved = resolve_answer({"paragraphs": [], "titles": [{"ref": "S1", "title": "w" * 300}]}, {"S1": "n-1"})
    assert resolved.titles == {"n-1": "w" * history_prompt.TITLE_LIMIT}


def test_two_labels_for_one_note_keep_the_first_title() -> None:
    refs = {"S1": "same", "S2": "same"}
    output = {"paragraphs": [{"text": "t", "cites": ["S2", "S1"]}],
              "titles": [{"ref": "S2", "title": "two"}, {"ref": "S1", "title": "one"}]}
    resolved = resolve_answer(output, refs)
    assert resolved.narrative == ({"text": "t", "note_ids": ["same"]},)
    assert resolved.titles == {"same": "two"} and resolved.dropped_titles == 1


def test_prompt_texts_cover_everything_fixed() -> None:
    texts = history_prompt.prompt_texts()
    assert history_prompt.UNTRUSTED_NOTICE in texts.values()
    assert set(texts["subjects"]) == {KIND_PROJECT, KIND_CLASS}
