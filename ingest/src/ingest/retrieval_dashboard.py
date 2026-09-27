"""The retrievals dashboard (R-P3): one self-contained HTML page from the report JSON.

``render_dashboard(report, generated_at=...)`` takes the dict that ``fetch_report``
builds (or the JSON ``--json-out`` wrote) and returns a whole document: inline CSS,
an inline SVG histogram built here, no script and no external URL, so it opens
offline from disk and publishes as-is as a private Artifact. The weekly curator run
writes it with ``ingest report retrievals --html <path>``.

Sections mirror the JSON one for one. Every value from the report is text from the
store (queries, titles, collections), so every one goes through ``_esc``; numbers
are formatted in one place (counts as integers, similarity to 3 decimals).
"""

from __future__ import annotations

import html
import json
from typing import Any

PAGE_TITLE = "Harness Retrieval Provenance"
COMMAND = "ingest report retrievals"
NONE_TEXT = "-"
NO_COLLECTION = "(none)"
NUM_CLASS = ' class="num"'

# Histogram geometry, in SVG user units.
SLOT = 52
BAR = 36
PAD_X = 8
TOP = 24
PLOT_H = 150
LABELS_H = 40

CSS = """
:root {
  color-scheme: light;
  --bg: #f4f6f6; --panel: #ffffff; --ink: #142022; --muted: #58676a;
  --rule: #d8dfdf; --code: #e8eded; --bar: #2a78d6; --bar-na: #9aa7a9;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #0f1516; --panel: #162022; --ink: #e6eeed; --muted: #9db0b2;
    --rule: #2a3739; --code: #1f2b2d; --bar: #3987e5; --bar-na: #5f6e70;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0f1516; --panel: #162022; --ink: #e6eeed; --muted: #9db0b2;
  --rule: #2a3739; --code: #1f2b2d; --bar: #3987e5; --bar-na: #5f6e70;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding-inline: 16px; background: var(--bg); color: var(--ink);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 1040px; margin: 0 auto; padding-block: 32px 48px; display: grid; gap: 32px; }
header { display: grid; gap: 4px; }
h1 { margin: 0; font-size: 24px; font-weight: 650; text-wrap: balance; }
h2 { margin: 0; font-size: 16px; font-weight: 650; display: flex; gap: 10px; align-items: baseline; }
.eyebrow, th, .tile-label {
  font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted);
}
.eyebrow { margin: 0; }
.range { margin: 0; color: var(--muted); }
.mono, code, td.num, .tile-value, .count {
  font-family: ui-monospace, "Cascadia Mono", Consolas, "SF Mono", monospace;
  font-variant-numeric: tabular-nums;
}
code { background: var(--code); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
.tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.tile {
  background: var(--panel); border: 1px solid var(--rule); border-radius: 6px;
  padding: 12px 16px; display: grid; gap: 2px;
}
.tile-value { font-size: clamp(20px, 6vw, 28px); line-height: 1.2; }
section { display: grid; gap: 10px; min-width: 0; }
.count { font-size: 13px; font-weight: 400; color: var(--muted); }
.note { margin: 0; color: var(--muted); max-width: 70ch; }
.scroll { overflow-x: auto; max-width: 100%; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--rule); }
td { padding: 6px 10px; border-bottom: 1px solid var(--rule); vertical-align: top; }
td.num, th.num { text-align: right; white-space: nowrap; }
td.text { overflow-wrap: anywhere; min-width: 12em; }
td.none { color: var(--muted); }
.chart { background: var(--panel); border: 1px solid var(--rule); border-radius: 6px; padding: 12px; }
.chart svg { display: block; width: 100%; max-width: 760px; min-width: 560px; height: auto; }
.bar { fill: var(--bar); }
.bar.na { fill: var(--bar-na); }
.axis { stroke: var(--rule); stroke-width: 1; }
.chart text { fill: var(--muted); font-size: 11px; font-family: ui-monospace, Consolas, monospace; }
.chart text.value { fill: var(--ink); }
.stats { display: flex; flex-wrap: wrap; gap: 6px 20px; margin: 0; color: var(--muted); }
.stats b { color: var(--ink); font-weight: 500; }
footer { color: var(--muted); font-size: 12px; border-top: 1px solid var(--rule); padding-top: 12px; }
""".strip()


def render_dashboard(report: dict[str, Any], *, generated_at: str) -> str:
    """The whole page, LF line endings, for the report dict ``fetch_report`` returns."""
    parts = [
        "<!doctype html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
        f"<title>{_esc(PAGE_TITLE)}</title>",
        f"<style>\n{CSS}\n</style>",
        "</head>",
        "<body>",
        "<main>",
        _header(report["totals"]),
        _tiles(report["totals"]),
        _most(report["most_retrieved"]),
        _never(report["never_retrieved"]),
        _empty(report["empty_queries"]),
        _similarity(report["similarity_distribution"]),
        _collections(report["per_collection"]),
        _cross(report["cross_collection"]),
        f"<footer>generated {_esc(generated_at)} from <code>{_esc(COMMAND)}</code></footer>",
        "</main>",
        "</body>",
        "</html>",
    ]
    return "\n".join(parts) + "\n"


# --------------------------------------------------------------------------
# sections
# --------------------------------------------------------------------------


def _header(totals: dict[str, Any]) -> str:
    since = totals["since"] or "all time"
    return (
        '<header>\n<p class="eyebrow">rag.retrieval_events</p>\n<h1>Retrieval provenance</h1>\n'
        f'<p class="range">first {_stat("first", _text(totals["first"]))} · '
        f'last {_stat("last", _text(totals["last"]))} · since {_stat("since", since)}</p>\n</header>'
    )


def _tiles(totals: dict[str, Any]) -> str:
    tiles = [
        f'<div class="tile"><span class="tile-label">{_esc(key)}</span>'
        f'<span class="tile-value" data-stat="{key}">{_count(totals[key])}</span></div>'
        for key in ("events", "retrievals", "sessions")
    ]
    return '<div class="tiles">\n' + "\n".join(tiles) + "\n</div>"


def _most(rows: list[dict[str, Any]]) -> str:
    table = _table(
        "most-retrieved",
        ("count", "sessions", "document", "collection", "title"),
        [
            (_count(r["count"]), _count(r["sessions"]), f"{r['source']}:{r['external_id']}",
             r["collection"], r["title"])
            for r in rows
        ],
        numeric=(0, 1),
    )
    note = "Documents by result rows, then by distinct sessions."
    return _section("Most retrieved", None, note, table)


def _never(section: dict[str, Any]) -> str:
    by_collection = _table(
        "never-by-collection",
        ("collection", "documents"),
        [(name, _count(n)) for name, n in section["by_collection"].items()],
        numeric=(1,),
    )
    sample = _table(
        "never-sample",
        ("collection", "document", "title"),
        [(d["collection"] or NO_COLLECTION, f"{d['source']}:{d['external_id']}", d["title"])
         for d in section["sample"]],
    )
    note = "Whole store: no event at any time names these documents; the --since bound does not apply."
    return _section("Never retrieved", _stat("never_total", _count(section["total"]), "count"), note,
                    by_collection + "\n" + sample)


def _empty(section: dict[str, Any]) -> str:
    table = _table(
        "empty-queries",
        ("retrieved at", "session", "collection", "tool", "query", "filters"),
        [
            (q["retrieved_at"], q["session_id"], q["collection"], q["tool"], q["query"],
             json.dumps(q["filters"], sort_keys=True))
            for q in section["queries"]
        ],
        wrap=(4, 5),
    )
    return _section("Empty-result queries", _stat("empty_total", _count(section["total"]), "count"),
                    "Searches that returned nothing, most recent first.", table)


def _similarity(section: dict[str, Any]) -> str:
    stats = " ".join(
        f"<span>{name} <b>{_stat(name, _similarity_text(section[name]), tag='span')}</b></span>"
        for name in ("min", "median", "max")
    )
    body = (
        f'<div class="chart scroll">{_histogram(section["buckets"])}</div>\n'
        f'<p class="stats"><span>result rows <b>{_stat("results", _count(section["results"]), tag="span")}'
        f"</b></span> {stats}</p>"
    )
    note = "Result rows by similarity, in buckets 0.05 wide labelled by their lower bound; n/a has no score."
    return _section("Similarity distribution", None, note, body)


def _collections(rows: list[dict[str, Any]]) -> str:
    table = _table(
        "per-collection",
        ("collection", "retrievals", "results", "empty", "sessions", "tool", "session-start"),
        [
            (r["collection"] or NO_COLLECTION, _count(r["retrievals"]), _count(r["results"]),
             _count(r["empty"]), _count(r["sessions"]), _count(r["channels"]["tool"]),
             _count(r["channels"]["session-start"]))
            for r in rows
        ],
        numeric=(1, 2, 3, 4, 5, 6),
    )
    return _section("Per collection", None, "By the searching session note's collection.", table)


def _cross(section: dict[str, Any]) -> str:
    table = _table(
        "cross-collection",
        ("retrieved at", "session", "note", "filter", "query"),
        [
            (r["retrieved_at"], r["session_id"], r["note_collection"], r["filter_collection"], r["query"])
            for r in section["retrievals"]
        ],
        wrap=(4,),
    )
    note = "Searches whose collection filter names a collection other than the note's own."
    return _section("Cross-collection searches", _stat("cross_total", _count(section["total"]), "count"),
                    note, table)


# --------------------------------------------------------------------------
# pieces
# --------------------------------------------------------------------------


def _histogram(buckets: list[dict[str, Any]]) -> str:
    """One labelled <rect> per bucket, heights on one linear scale from zero."""
    width = PAD_X * 2 + SLOT * len(buckets)
    base = TOP + PLOT_H
    peak = max((b["count"] for b in buckets), default=0)
    marks = []
    for i, bucket in enumerate(buckets):
        count = int(bucket["count"])
        height = round(PLOT_H * count / peak, 2) if peak else 0
        x = PAD_X + i * SLOT + (SLOT - BAR) / 2
        centre = x + BAR / 2
        label = bucket["bucket"]
        kind = "bar na" if label == "n/a" else "bar"
        tip = f"{label}: {count} rows ({_share(bucket['share'])})"
        marks.append(
            f'<rect class="{kind}" data-bucket="{_esc(label)}" data-count="{count}" x="{x:g}" '
            f'y="{base - height:g}" width="{BAR}" height="{height:g}" rx="2"><title>{_esc(tip)}</title></rect>'
            f'<text class="value" x="{centre:g}" y="{base - height - 6:g}" text-anchor="middle">{count}</text>'
            f'<text x="{centre:g}" y="{base + 18}" text-anchor="middle">{_esc(label.split("-")[0])}</text>'
        )
    axis = f'<line class="axis" x1="{PAD_X}" y1="{base}" x2="{width - PAD_X}" y2="{base}"></line>'
    caption = (f'<text x="{width / 2:g}" y="{base + 34}" text-anchor="middle">'
               "similarity (bucket lower bound)</text>")
    return (
        f'<svg viewBox="0 0 {width} {TOP + PLOT_H + LABELS_H}" role="img" '
        f'aria-label="Result rows per similarity bucket">{axis}{"".join(marks)}{caption}</svg>'
    )


def _section(heading: str, badge: str | None, note: str, body: str) -> str:
    title = f"<h2>{_esc(heading)}{' ' + badge if badge else ''}</h2>"
    return f'<section>\n{title}\n<p class="note">{_esc(note)}</p>\n{body}\n</section>'


def _table(
    table_id: str,
    headers: tuple[str, ...],
    rows: list[tuple[Any, ...]],
    *,
    numeric: tuple[int, ...] = (),
    wrap: tuple[int, ...] = (),
) -> str:
    def cls(i: int) -> str:
        return NUM_CLASS if i in numeric else ' class="text"' if i in wrap else ""

    head = "".join(f"<th{NUM_CLASS if i in numeric else ''}>{_esc(h)}</th>" for i, h in enumerate(headers))
    if rows:
        body = "\n".join(
            "<tr>" + "".join(f"<td{cls(i)}>{_esc(_text(v))}</td>" for i, v in enumerate(row)) + "</tr>"
            for row in rows
        )
    else:
        body = f'<tr><td class="none" colspan="{len(headers)}">(none)</td></tr>'
    return (
        f'<div class="scroll"><table id="{table_id}">\n<thead><tr>{head}</tr></thead>\n'
        f"<tbody>\n{body}\n</tbody>\n</table></div>"
    )


def _stat(key: str, text: str, cls: str | None = None, *, tag: str = "span") -> str:
    klass = f' class="{cls}"' if cls else ""
    return f'<{tag}{klass} data-stat="{key}">{_esc(text)}</{tag}>'


def _text(value: Any) -> str:
    return NONE_TEXT if value is None else str(value)


def _count(value: Any) -> str:
    return str(int(value))


def _similarity_text(value: float | None) -> str:
    return NONE_TEXT if value is None else f"{value:.3f}"


def _share(value: float) -> str:
    return f"{value:.1%}"


def _esc(value: Any) -> str:
    return html.escape(str(value), quote=True)
