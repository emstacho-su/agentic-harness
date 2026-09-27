"""The retrievals dashboard (R-P3): one offline HTML page rendered from the report JSON,
and the ``--html`` / ``--json-out`` flags that write it and the JSON beside it.

Every number is read back out of the page by element (tile, table cell, SVG bar), so a
match is a real match and not a stray digit elsewhere. Nothing here touches a database.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

import pytest

from ingest.report_cli import EXIT_FAILED, run_report
from ingest.retrieval_dashboard import render_dashboard
from ingest.retrieval_report import DocumentRow, build_report
from test_retrieval_report import CLASS, EVENTS, HARNESS, NEVER, ScriptedConnection, at, event

GENERATED = "2026-09-27T06:00:00+00:00"
CLOCK_NOW = datetime(2026, 9, 27, 6, 0, tzinfo=timezone.utc)
ATTACK = "<script>alert(1)</script>"
QUOTED_TITLE = 'He said "hi" & <b>left</b>'


class Page(HTMLParser):
    """Tables by id (rows of cell texts), stat values by data-stat, SVG bars in order."""

    def __init__(self, html: str) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: dict[str, list[list[str]]] = {}
        self.stats: dict[str, str] = {}
        self.bars: list[dict[str, str]] = []
        self.title = ""
        self._table: str | None = None
        self._cell: list[str] | None = None
        self._stat: str | None = None
        self._in_title = False
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        if tag == "table":
            self._table = attr.get("id") or ""
            self.tables[self._table] = []
        elif tag == "tr" and self._table is not None:
            self.tables[self._table].append([])
        elif tag in ("td", "th") and self._table is not None:
            self._cell = []
        elif tag == "rect":
            self.bars.append({k: v or "" for k, v in attr.items()})
        elif tag == "title" and not self.bars and self._table is None:
            self._in_title = True
        if "data-stat" in attr:
            self._stat = attr["data-stat"]
            self.stats[self._stat] = ""

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None:
            self.tables[self._table][-1].append("".join(self._cell).strip())
            self._cell = None
        elif tag == "table":
            self._table = None
        elif tag == "title":
            self._in_title = False
        if self._stat is not None and tag in ("span", "b", "strong", "dd"):
            self._stat = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)
        if self._stat is not None:
            self.stats[self._stat] += data
        if self._in_title:
            self.title += data


@pytest.fixture
def report() -> dict:
    return build_report(EVENTS, NEVER, since=datetime(2026, 9, 1, tzinfo=timezone.utc), limit=10)


@pytest.fixture
def page(report) -> Page:
    return Page(render_dashboard(report, generated_at=GENERATED))


def body_rows(page: Page, table: str) -> list[list[str]]:
    return page.tables[table][1:]


# --------------------------------------------------------------------------
# the page
# --------------------------------------------------------------------------


def test_the_page_is_one_offline_document_with_a_short_title(report):
    html = render_dashboard(report, generated_at=GENERATED)
    assert html.startswith("<!doctype html>")
    assert "<script src" not in html
    assert "http://" not in html and "https://" not in html
    assert "@import" not in html and "url(" not in html
    words = Page(html).title.split()
    assert 2 <= len(words) <= 4
    assert "prefers-color-scheme: dark" in html and ":root" in html
    assert html.count("\r") == 0


def test_the_footer_names_the_time_and_the_command(report):
    html = render_dashboard(report, generated_at=GENERATED)
    assert f"generated {GENERATED} from <code>ingest report retrievals</code>" in html


def test_totals_are_tiles(page, report):
    totals = report["totals"]
    for key in ("events", "retrievals", "sessions"):
        assert page.stats[key] == str(totals[key])
    assert page.stats["first"] == totals["first"]
    assert page.stats["last"] == totals["last"]
    assert page.stats["since"] == totals["since"]


def test_most_retrieved_rows_match(page, report):
    rows = body_rows(page, "most-retrieved")
    assert len(rows) == len(report["most_retrieved"])
    for row, doc in zip(rows, report["most_retrieved"]):
        assert row[:2] == [str(doc["count"]), str(doc["sessions"])]
        assert row[2] == f"{doc['source']}:{doc['external_id']}"
        assert row[3] == (doc["collection"] or "-")
        assert row[4] == (doc["title"] or "-")


def test_never_retrieved_has_the_total_counts_and_sample(page, report):
    section = report["never_retrieved"]
    assert page.stats["never_total"] == str(section["total"])
    counts = {r[0]: r[1] for r in body_rows(page, "never-by-collection")}
    assert counts == {name: str(n) for name, n in section["by_collection"].items()}
    sample = body_rows(page, "never-sample")
    assert [r[1] for r in sample] == [f"{d['source']}:{d['external_id']}" for d in section["sample"]]


def test_empty_queries_are_listed(page, report):
    section = report["empty_queries"]
    assert page.stats["empty_total"] == str(section["total"])
    rows = body_rows(page, "empty-queries")
    assert [r[4] for r in rows] == [q["query"] for q in section["queries"]]
    assert rows[1][5] == json.dumps({"collection": HARNESS}, sort_keys=True)


def test_the_similarity_chart_has_one_labelled_bar_per_bucket(page, report):
    section = report["similarity_distribution"]
    buckets = section["buckets"]
    assert len(page.bars) == len(buckets) == 12
    assert [b["data-bucket"] for b in page.bars] == [b["bucket"] for b in buckets]
    assert [b["data-count"] for b in page.bars] == [str(b["count"]) for b in buckets]
    assert page.stats["results"] == str(section["results"])
    assert page.stats["min"] == f"{section['min']:.3f}" == "0.450"
    assert page.stats["median"] == f"{section['median']:.3f}"
    assert page.stats["max"] == "1.000"


def test_bar_heights_follow_the_counts(page):
    heights = {b["data-bucket"]: float(b["height"]) for b in page.bars}
    assert heights["0.55-0.60"] == 0
    assert heights["0.50-0.55"] == pytest.approx(2 * heights["<0.50"])
    assert max(heights.values()) == heights["0.95-1.00"]


def test_per_collection_rows_match(page, report):
    rows = {r[0]: r[1:] for r in body_rows(page, "per-collection")}
    for section in report["per_collection"]:
        assert rows[section["collection"]] == [
            str(section[k]) for k in ("retrievals", "results", "empty", "sessions")
        ] + [str(section["channels"]["tool"]), str(section["channels"]["session-start"])]


def test_cross_collection_rows_match(page, report):
    section = report["cross_collection"]
    assert page.stats["cross_total"] == str(section["total"])
    rows = body_rows(page, "cross-collection")
    assert [(r[1], r[2], r[3], r[4]) for r in rows] == [
        (x["session_id"], x["note_collection"], x["filter_collection"], x["query"])
        for x in section["retrievals"]
    ]


def test_an_empty_report_renders_with_none_rows():
    html = render_dashboard(build_report((), (), since=None, limit=5), generated_at=GENERATED)
    page = Page(html)
    assert page.stats["events"] == "0" and page.stats["since"] == "all time"
    assert page.stats["min"] == "-"
    assert len(page.bars) == 12 and all(float(b["height"]) == 0 for b in page.bars)
    assert "(none)" in html


def test_queries_and_titles_are_escaped():
    rows = (
        event("x", 0, None, query=ATTACK, when=at(20)),
        event("y", 0, 1, query=ATTACK, filters={"collection": CLASS}, title=QUOTED_TITLE, when=at(21)),
    )
    never = (DocumentRow(source="obsidian", external_id="q.md", title=QUOTED_TITLE, collection=ATTACK),)
    html = render_dashboard(build_report(rows, never, since=None, limit=5), generated_at=ATTACK)
    assert ATTACK not in html
    assert "<b>left</b>" not in html
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html
    assert "He said &quot;hi&quot; &amp; &lt;b&gt;left&lt;/b&gt;" in html
    page = Page(html)
    assert body_rows(page, "empty-queries")[0][4] == ATTACK
    assert body_rows(page, "most-retrieved")[0][4] == QUOTED_TITLE


# --------------------------------------------------------------------------
# --html and --json-out
# --------------------------------------------------------------------------


def run(argv: list[str]) -> int:
    return run_report(argv, connection=ScriptedConnection(), clock=lambda: CLOCK_NOW)


def test_html_and_json_out_write_the_page_and_the_json(tmp_path: Path, capsys):
    json_path = tmp_path / "out" / "deep" / "retrievals-2026-09-27.json"
    html_path = tmp_path / "out" / "retrievals-dashboard.html"
    code = run(["retrievals", "--json", "--json-out", str(json_path), "--html", str(html_path)])
    assert code == 0
    stdout = json.loads(capsys.readouterr().out)
    written = json_path.read_bytes().decode("utf-8")
    assert json.loads(written) == stdout
    assert written == json.dumps(stdout, indent=2) + "\n"
    page = html_path.read_bytes().decode("utf-8")
    assert "\r" not in page
    assert page == render_dashboard(json.loads(written), generated_at=GENERATED)


def test_html_alone_keeps_the_text_report_on_stdout(tmp_path: Path, capsys):
    html_path = tmp_path / "dash.html"
    assert run(["retrievals", "--html", str(html_path)]) == 0
    assert "most retrieved" in capsys.readouterr().out
    assert Page(html_path.read_text(encoding="utf-8")).stats["events"] == "15"


def test_a_rerun_replaces_the_file(tmp_path: Path, capsys):
    html_path = tmp_path / "dash.html"
    html_path.write_text("old", encoding="utf-8")
    assert run(["retrievals", "--html", str(html_path)]) == 0
    assert html_path.read_text(encoding="utf-8").startswith("<!doctype html>")
    assert sorted(os.listdir(tmp_path)) == ["dash.html"]


@pytest.mark.parametrize("flag", ["--html", "--json-out"])
def test_an_unwritable_path_is_exit_1_with_no_partial_file(tmp_path: Path, capsys, flag: str):
    blocker = tmp_path / "a-file"
    blocker.write_text("x", encoding="utf-8")
    assert run(["retrievals", flag, str(blocker / "out.html")]) == EXIT_FAILED
    assert capsys.readouterr().err.startswith("error: ")
    assert sorted(os.listdir(tmp_path)) == ["a-file"]


@pytest.mark.parametrize("flag", ["--html", "--json-out"])
def test_a_directory_in_the_way_leaves_no_temp_file(tmp_path: Path, capsys, flag: str):
    target = tmp_path / "taken"
    target.mkdir()
    assert run(["retrievals", flag, str(target)]) == EXIT_FAILED
    assert "error: " in capsys.readouterr().err
    assert sorted(os.listdir(tmp_path)) == ["taken"]
    assert os.listdir(target) == []
