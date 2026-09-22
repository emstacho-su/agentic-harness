"""The retrieval eval: golden-file validation, scoring and the command line.

No database and no model: the searcher is a fake that returns canned hits, and
the embedder is the suite's FakeEmbedder.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ingest.errors import ConfigError
from ingest.eval import (
    EvalReport,
    GoldenCase,
    Hit,
    load_golden,
    run_eval,
    score_case,
)
from ingest.eval_cli import run_eval_command


def hit(external_id: str, content: str = "", source: str = "obsidian") -> Hit:
    return Hit(source=source, external_id=external_id, title=None, content=content, similarity=0.8)


class FakeSearcher:
    """Returns the canned hits for a query; records what it was asked."""

    def __init__(self, by_query: dict[str, list[Hit]]) -> None:
        self.by_query = by_query
        self.calls: list[tuple[str, int]] = []

    def search(self, query: str, embedding: list[float], limit: int) -> list[Hit]:
        self.calls.append((query, limit))
        return list(self.by_query.get(query, []))[:limit]


def write_golden(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "golden.yaml"
    path.write_text(text, encoding="utf-8")
    return path


# -- load_golden -------------------------------------------------------------


def test_load_golden_reads_positive_and_negative_cases(tmp_path: Path) -> None:
    path = write_golden(
        tmp_path,
        """
cases:
  - id: reconcile
    query: how does the nightly reconcile job work
    expect: [session-abc]
  - id: floor
    query: why is the similarity floor 0.70
    expect_contains: ["relevance floor"]
  - id: sourdough
    query: best sourdough hydration
    negative: true
""",
    )
    cases = load_golden(path)
    assert [case.id for case in cases] == ["reconcile", "floor", "sourdough"]
    assert cases[0].expect == ("session-abc",)
    assert cases[1].expect_contains == ("relevance floor",)
    assert cases[2].negative is True


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("cases: []", "no cases"),
        ("nope: 1", "cases"),
        ("cases:\n  - id: a\n    query: q\n", "expect"),
        ("cases:\n  - id: a\n    query: q\n    negative: true\n    expect: [x]\n", "negative"),
        ("cases:\n  - id: a\n    expect: [x]\n", "query"),
        (
            "cases:\n  - id: a\n    query: q\n    expect: [x]\n  - id: a\n    query: r\n    expect: [y]\n",
            "duplicate",
        ),
        ("cases:\n  - id: a\n    query: q\n    expect: [x]\n    surprise: 1\n", "surprise"),
    ],
)
def test_load_golden_refuses_a_malformed_file(tmp_path: Path, text: str, message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        load_golden(write_golden(tmp_path, text))


def test_load_golden_refuses_a_missing_file(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="not found"):
        load_golden(tmp_path / "absent.yaml")


# -- score_case --------------------------------------------------------------


def test_score_case_ranks_the_first_expected_external_id() -> None:
    case = GoldenCase(id="a", query="q", expect=("want",))
    result = score_case(case, [hit("other"), hit("want"), hit("want")])
    assert result.rank == 2
    assert result.passed(k=3) is True
    assert result.passed(k=1) is False


def test_score_case_matches_expected_text_case_insensitively() -> None:
    case = GoldenCase(id="a", query="q", expect_contains=("Relevance Floor",))
    result = score_case(case, [hit("x", "the relevance floor is 0.70")])
    assert result.rank == 1


def test_score_case_misses_when_nothing_matches() -> None:
    case = GoldenCase(id="a", query="q", expect=("want",))
    result = score_case(case, [hit("other")])
    assert result.rank is None
    assert result.passed(k=3) is False


def test_a_negative_case_passes_only_on_an_empty_result() -> None:
    case = GoldenCase(id="n", query="q", negative=True)
    assert score_case(case, []).passed(k=3) is True
    assert score_case(case, [hit("anything")]).passed(k=3) is False


# -- run_eval and the report ---------------------------------------------------


def test_run_eval_aggregates_hit_rate_mrr_and_negatives(fake_embedder) -> None:
    cases = [
        GoldenCase(id="first", query="one", expect=("a",)),
        GoldenCase(id="second", query="two", expect=("b",)),
        GoldenCase(id="miss", query="three", expect=("c",)),
        GoldenCase(id="neg-ok", query="four", negative=True),
        GoldenCase(id="neg-bad", query="five", negative=True),
    ]
    searcher = FakeSearcher(
        {
            "one": [hit("a")],
            "two": [hit("x"), hit("b")],
            "three": [hit("x")],
            "five": [hit("noise")],
        }
    )
    report = run_eval(cases, searcher, fake_embedder, k=3, limit=10)

    assert isinstance(report, EvalReport)
    assert report.hit_rate == pytest.approx(2 / 3)
    assert report.mrr == pytest.approx((1 + 0.5 + 0) / 3)
    assert report.negative_pass_rate == pytest.approx(0.5)
    assert [r.case.id for r in report.failures] == ["miss", "neg-bad"]
    assert searcher.calls == [("one", 10), ("two", 10), ("three", 10), ("four", 10), ("five", 10)]


def test_a_report_with_no_cases_of_a_kind_scores_that_kind_as_perfect(fake_embedder) -> None:
    report = run_eval(
        [GoldenCase(id="n", query="q", negative=True)], FakeSearcher({}), fake_embedder, k=3, limit=10
    )
    assert report.hit_rate == 1.0
    assert report.mrr == 1.0
    assert report.negative_pass_rate == 1.0


# -- command line ------------------------------------------------------------

GOLDEN = """
cases:
  - id: found
    query: one
    expect: [a]
  - id: lost
    query: two
    expect: [b]
"""


def test_the_command_prints_json_and_gates_on_the_hit_rate(tmp_path: Path, fake_embedder, capsys) -> None:
    golden = write_golden(tmp_path, GOLDEN)
    searcher = FakeSearcher({"one": [hit("a")]})

    code = run_eval_command(
        ["--golden", str(golden), "--json", "--min-hit-rate", "0.9"],
        searcher=searcher,
        embedder=fake_embedder,
    )
    payload = json.loads(capsys.readouterr().out)

    assert code == 1
    assert payload["hit_rate"] == pytest.approx(0.5)
    assert payload["k"] == 3
    assert [case["id"] for case in payload["cases"] if not case["passed"]] == ["lost"]


def test_the_command_exits_zero_without_a_gate(tmp_path: Path, fake_embedder, capsys) -> None:
    golden = write_golden(tmp_path, GOLDEN)
    code = run_eval_command(
        ["--golden", str(golden)], searcher=FakeSearcher({"one": [hit("a")]}), embedder=fake_embedder
    )
    out = capsys.readouterr().out
    assert code == 0
    assert "hit@3" in out
    assert "lost" in out


def test_the_command_reports_a_bad_golden_file_as_a_usage_error(tmp_path: Path, fake_embedder, capsys) -> None:
    code = run_eval_command(
        ["--golden", str(tmp_path / "absent.yaml")], searcher=FakeSearcher({}), embedder=fake_embedder
    )
    assert code == 2
    assert "not found" in capsys.readouterr().err
