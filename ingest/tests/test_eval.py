"""The retrieval eval: golden-file validation, scoring and the command line.

No database and no model: the searcher is a fake that returns canned hits, and
the embedder is the suite's FakeEmbedder.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from ingest.errors import ConfigError
from ingest.eval import (
    EvalReport,
    GoldenCase,
    Hit,
    PostgresSearcher,
    load_golden,
    run_eval,
    score_case,
)
from ingest.eval_cli import run_eval_command


def hit(
    external_id: str,
    content: str = "",
    source: str = "obsidian",
    collection: str | None = None,
    realm: str | None = None,
) -> Hit:
    return Hit(
        source=source,
        external_id=external_id,
        title=None,
        content=content,
        similarity=0.8,
        collection=collection,
        realm=realm,
    )


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
    collection: agentic-harness
    realm: projects
  - id: floor
    query: why is the similarity floor 0.70
    expect_contains: ["relevance floor"]
    collection: estac
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
    assert (cases[0].collection, cases[0].realm) == ("agentic-harness", "projects")
    assert (cases[1].collection, cases[1].realm) == ("estac", None)
    assert (cases[2].collection, cases[2].realm) == (None, None)


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("cases: []", "no cases"),
        ("nope: 1", "cases"),
        ("cases:\n  - id: a\n    query: q\n", "expect"),
        ("cases:\n  - id: a\n    query: q\n    negative: true\n    expect: [x]\n", "negative"),
        ("cases:\n  - id: a\n    expect: [x]\n", "query"),
        (
            "cases:\n  - id: a\n    query: q\n    expect: [x]\n    collection: c\n"
            "  - id: a\n    query: r\n    expect: [y]\n    collection: c\n",
            "duplicate",
        ),
        ("cases:\n  - id: a\n    query: q\n    expect: [x]\n    surprise: 1\n", "surprise"),
        ("cases:\n  - id: a\n    query: q\n    expect: [x]\n", "collection"),
        ("cases:\n  - id: a\n    query: q\n    expect: [x]\n    collection: '  '\n", "collection"),
        ("cases:\n  - id: a\n    query: q\n    expect: [x]\n    collection: [c]\n", "collection"),
        ("cases:\n  - id: a\n    query: q\n    expect: [x]\n    collection: c\n    realm: Bad Realm\n", "realm"),
        ("cases:\n  - id: a\n    query: q\n    expect: [x]\n    collection: c\n    realm: 3\n", "realm"),
        ("cases:\n  - id: a\n    query: q\n    negative: true\n    collection: c\n", "negative"),
        ("cases:\n  - id: a\n    query: q\n    negative: true\n    realm: projects\n", "negative"),
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


# -- label check and per-collection scores -------------------------------------


def test_a_hit_from_another_collection_is_flagged_as_mislabelled() -> None:
    case = GoldenCase(id="a", query="q", expect=("want",), collection="bb2dash")
    moved = score_case(case, [hit("other", collection="bb2dash"), hit("want", collection="memory")])
    assert moved.passed(k=3) is True
    assert moved.mislabelled(k=3) is True
    assert moved.matched_hit is not None and moved.matched_hit.collection == "memory"

    same = score_case(case, [hit("want", collection="bb2dash")])
    assert same.mislabelled(k=3) is False


def test_a_miss_or_a_negative_is_never_mislabelled() -> None:
    miss = score_case(GoldenCase(id="a", query="q", expect=("want",), collection="c"), [hit("x", collection="d")])
    negative = score_case(GoldenCase(id="n", query="q", negative=True), [hit("x", collection="d")])
    assert miss.mislabelled(k=3) is False
    assert miss.matched_hit is None
    assert negative.mislabelled(k=3) is False


def test_a_case_found_below_k_is_a_failure_and_not_also_mislabelled(fake_embedder) -> None:
    case = GoldenCase(id="deep", query="q", expect=("want",), collection="bb2dash")
    hits = [hit("x1", collection="bb2dash"), hit("x2"), hit("x3"), hit("want", collection="memory")]
    result = score_case(case, hits)

    assert result.rank == 4
    assert result.mislabelled(k=3) is False
    assert result.mislabelled(k=4) is True

    report = run_eval([case], FakeSearcher({"q": hits}), fake_embedder, k=3, limit=10)
    assert [r.case.id for r in report.failures] == ["deep"]
    assert report.mislabelled == ()


def test_a_text_match_is_never_label_checked() -> None:
    """expect_contains accepts the answer from any note, so where it came from says nothing."""
    by_text = GoldenCase(id="t", query="q", expect_contains=("relevance floor",), collection="estac")
    result = score_case(by_text, [hit("elsewhere", "the relevance floor is 0.70", collection="memory")])
    assert result.passed(k=3) is True
    assert result.mislabelled(k=3) is False

    both = GoldenCase(id="b", query="q", expect=("want",), expect_contains=("floor",), collection="estac")
    by_id = score_case(both, [hit("want", "no match here", collection="memory")])
    assert by_id.mislabelled(k=3) is True
    by_text_only = score_case(both, [hit("other", "the floor", collection="memory")])
    assert by_text_only.mislabelled(k=3) is False


def test_a_hit_from_another_realm_is_flagged_as_mislabelled() -> None:
    case = GoldenCase(id="a", query="q", expect=("want",), collection="notes", realm="classes")
    assert score_case(case, [hit("want", collection="notes", realm="projects")]).mislabelled(k=3) is True
    assert score_case(case, [hit("want", collection="notes", realm="classes")]).mislabelled(k=3) is False
    assert score_case(case, [hit("want", collection="notes")]).mislabelled(k=3) is True

    no_realm = GoldenCase(id="m", query="q", expect=("want",), collection="quant-edge-tracker")
    same_home = [hit("want", collection="quant-edge-tracker")]
    gained_a_realm = [hit("want", collection="quant-edge-tracker", realm="projects")]
    assert score_case(no_realm, same_home).mislabelled(k=3) is False
    assert score_case(no_realm, gained_a_realm).mislabelled(k=3) is True


class FakeCursor:
    def __init__(self, rows: list[tuple]) -> None:
        self.rows = rows
        self.executed: list[tuple[str, dict]] = []

    def __enter__(self) -> "FakeCursor":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def execute(self, sql: str, params: dict) -> None:
        self.executed.append((sql, params))

    def fetchall(self) -> list[tuple]:
        return self.rows


class FakeConnection:
    def __init__(self, rows: list[tuple]) -> None:
        self.cursor_obj = FakeCursor(rows)

    def cursor(self) -> FakeCursor:
        return self.cursor_obj


def test_the_live_searcher_reads_the_realm_from_the_same_row() -> None:
    rows = [
        ("obsidian", "notes/a.md", "A", "text", 0.81, "bb2dash", "projects"),
        ("claude-mem", "313", None, "text", 0.77, "quant-edge-tracker", None),
    ]
    connection = FakeConnection(rows)

    hits = PostgresSearcher(connection).search("q", [0.0, 1.0], 10)

    assert [(h.collection, h.realm) for h in hits] == [("bb2dash", "projects"), ("quant-edge-tracker", None)]
    sql, _params = connection.cursor_obj.executed[0]
    assert len(connection.cursor_obj.executed) == 1
    assert "doc_metadata -> '_ingest' ->> 'realm'" in sql


def test_by_collection_scores_each_realm_and_collection_and_skips_negatives(fake_embedder) -> None:
    cases = [
        GoldenCase(id="b1", query="one", expect=("a",), collection="bb2dash", realm="projects"),
        GoldenCase(id="b2", query="two", expect=("b",), collection="bb2dash", realm="projects"),
        GoldenCase(id="i1", query="three", expect=("c",), collection="ist323", realm="classes"),
        GoldenCase(id="m1", query="four", expect=("d",), collection="ai-news-agent"),
        GoldenCase(id="neg", query="five", negative=True),
    ]
    searcher = FakeSearcher({"one": [hit("a")], "two": [hit("x"), hit("b")], "four": [hit("d")]})
    report = run_eval(cases, searcher, fake_embedder, k=3, limit=10)

    table = report.by_collection()

    assert list(table) == [("-", "ai-news-agent"), ("classes", "ist323"), ("projects", "bb2dash")]
    bb2dash = table[("projects", "bb2dash")]
    assert (bb2dash.realm, bb2dash.collection, bb2dash.cases) == ("projects", "bb2dash", 2)
    assert bb2dash.hit_rate == pytest.approx(1.0)
    assert bb2dash.mrr == pytest.approx((1 + 0.5) / 2)
    ist323 = table[("classes", "ist323")]
    assert (ist323.cases, ist323.hit_rate, ist323.mrr) == (1, 0.0, 0.0)
    assert table[("-", "ai-news-agent")].realm == "-"


# -- command line ------------------------------------------------------------

GOLDEN = """
cases:
  - id: found
    query: one
    expect: [a]
    collection: bb2dash
    realm: projects
  - id: lost
    query: two
    expect: [b]
    collection: ist323
    realm: classes
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


def test_the_json_report_carries_the_per_collection_table_and_the_label_check(
    tmp_path: Path, fake_embedder, capsys
) -> None:
    golden = write_golden(tmp_path, GOLDEN)
    searcher = FakeSearcher({"one": [hit("a", collection="memory")]})

    run_eval_command(["--golden", str(golden), "--json"], searcher=searcher, embedder=fake_embedder)
    payload = json.loads(capsys.readouterr().out)

    assert payload["per_collection"] == [
        {"realm": "classes", "collection": "ist323", "cases": 1, "hit_rate": 0.0, "mrr": 0.0},
        {"realm": "projects", "collection": "bb2dash", "cases": 1, "hit_rate": 1.0, "mrr": 1.0},
    ]
    by_id = {case["id"]: case for case in payload["cases"]}
    assert by_id["found"]["mislabelled"] is True
    assert by_id["lost"]["mislabelled"] is False


def test_the_text_report_prints_the_table_and_a_label_check_block(tmp_path: Path, fake_embedder, capsys) -> None:
    golden = write_golden(tmp_path, GOLDEN)
    searcher = FakeSearcher({"one": [hit("a", collection="memory")]})

    run_eval_command(["--golden", str(golden)], searcher=searcher, embedder=fake_embedder)
    lines = capsys.readouterr().out.splitlines()

    header = next(line for line in lines if line.startswith("realm"))
    assert header.split() == ["realm", "collection", "cases", "hit@3", "MRR"]
    rows = [line.split() for line in lines if line.startswith(("classes", "projects"))]
    assert rows == [["classes", "ist323", "1", "0.00", "0.00"], ["projects", "bb2dash", "1", "1.00", "1.00"]]
    assert "label check:" in lines
    assert "  found: expected projects/bb2dash, hit came from memory" in lines


def test_the_text_report_omits_the_label_check_when_every_label_holds(tmp_path: Path, fake_embedder, capsys) -> None:
    golden = write_golden(tmp_path, GOLDEN)
    searcher = FakeSearcher({"one": [hit("a", collection="bb2dash", realm="projects")]})
    run_eval_command(["--golden", str(golden)], searcher=searcher, embedder=fake_embedder)
    assert "label check" not in capsys.readouterr().out


def test_a_case_found_below_k_is_reported_only_as_a_failure(tmp_path: Path, fake_embedder, capsys) -> None:
    golden = write_golden(tmp_path, GOLDEN)
    history = tmp_path / "history.jsonl"
    deep = [hit("x1"), hit("x2"), hit("x3"), hit("b", collection="memory")]
    searcher = FakeSearcher({"one": [hit("a", collection="bb2dash", realm="projects")], "two": deep})

    run_eval_command(["--golden", str(golden), "--json"], searcher=searcher, embedder=fake_embedder)
    by_id = {case["id"]: case for case in json.loads(capsys.readouterr().out)["cases"]}
    assert (by_id["lost"]["passed"], by_id["lost"]["mislabelled"]) == (False, False)

    run_eval_command(
        ["--golden", str(golden), "--history", str(history)], searcher=searcher, embedder=fake_embedder
    )
    out = capsys.readouterr().out
    assert "label check" not in out
    assert "lost: rank 4" in out
    record = json.loads(history.read_text(encoding="utf-8"))
    assert (record["failures"], record["mislabelled"]) == (["lost"], [])


# -- history -----------------------------------------------------------------


def test_history_appends_one_line_per_run(tmp_path: Path, fake_embedder, capsys) -> None:
    golden = write_golden(tmp_path, GOLDEN)
    history = tmp_path / "history.jsonl"
    searcher = FakeSearcher({"one": [hit("a", collection="memory")]})
    argv = ["--golden", str(golden), "--history", str(history)]

    assert run_eval_command(argv, searcher=searcher, embedder=fake_embedder) == 0
    first = history.read_text(encoding="utf-8").splitlines()
    assert len(first) == 1
    record = json.loads(first[0])
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", record["at"])
    assert record["k"] == 3
    assert record["hit_rate"] == pytest.approx(0.5)
    assert record["mrr"] == pytest.approx(0.5)
    assert record["negative_pass_rate"] == 1.0
    assert record["cases"] == 2
    assert [row["collection"] for row in record["per_collection"]] == ["ist323", "bb2dash"]
    assert record["failures"] == ["lost"]
    assert record["mislabelled"] == ["found"]

    assert run_eval_command(argv, searcher=searcher, embedder=fake_embedder) == 0
    assert history.read_text(encoding="utf-8").endswith("\n")
    assert len(history.read_text(encoding="utf-8").splitlines()) == 2


def test_the_history_flag_alone_uses_the_default_path() -> None:
    from ingest.eval_cli import DEFAULT_GOLDEN, DEFAULT_HISTORY, build_eval_parser

    assert DEFAULT_HISTORY == DEFAULT_GOLDEN.parent / "history.jsonl"
    assert build_eval_parser().parse_args(["--history"]).history == str(DEFAULT_HISTORY)
    assert build_eval_parser().parse_args([]).history is None


@pytest.mark.parametrize(("gate", "expected_code"), [([], 0), (["--min-hit-rate", "0.9"], 1)])
def test_an_unwritable_history_warns_and_keeps_the_exit_code(
    tmp_path: Path, fake_embedder, capsys, gate: list[str], expected_code: int
) -> None:
    golden = write_golden(tmp_path, GOLDEN)
    blocker = tmp_path / "not-a-directory"
    blocker.write_text("", encoding="utf-8")
    argv = ["--golden", str(golden), "--history", str(blocker / "history.jsonl"), *gate]

    code = run_eval_command(argv, searcher=FakeSearcher({"one": [hit("a")]}), embedder=fake_embedder)

    captured = capsys.readouterr()
    assert code == expected_code
    assert "warning" in captured.err
    assert "history" in captured.err
    assert "hit@3" in captured.out


def test_no_history_is_written_when_the_eval_does_not_run(tmp_path: Path, fake_embedder) -> None:
    history = tmp_path / "history.jsonl"
    code = run_eval_command(
        ["--golden", str(tmp_path / "absent.yaml"), "--history", str(history)],
        searcher=FakeSearcher({}),
        embedder=fake_embedder,
    )
    assert code == 2
    assert not history.exists()
