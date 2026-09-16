"""bb2dash class materials -> vault markdown exporter.

The exporter reads ``bb_files`` + ``bb_file_text`` from the bb2dash project
over PostgREST and writes one note per file under
``classes/<collection>/materials/``. Every note carries ``ingest: false`` so
the harness pipeline never embeds it — materials retrieval belongs to the
bb2dash store, and the two vector spaces must never mix (CONTEXT.md).
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from ingest.errors import ConfigError, SourceError
from ingest.materials.client import (
    BB2DASH_PROJECT_REF,
    assert_bb2dash_url,
    fetch_materials,
    validate_row,
)
from ingest.materials.render import (
    collection_for_course,
    plan_notes,
    render_note,
    slugify,
)
from ingest.materials.cli import main, write_notes
from ingest.loaders.obsidian import load_vault, split_frontmatter


def row(**overrides):
    base = {
        "id": 2,
        "file_name": "323Fall26V1.3.1.docx",
        "course_id": "IST.323",
        "bucket": "syllabus_policy",
        "week_no": None,
        "path": "Syllabus & Course Information / IST-323 Syllabus v1.3.1",
        "sha256": "937103b4",
        "captured_at": "2026-09-02T20:33:25.238635+00:00",
        "text_status": "extracted",
        "superseded_by": None,
        "bb_file_text": [
            {"unit_no": 2, "unit_kind": "page", "text": "Second page.  \n"},
            {"unit_no": 1, "unit_kind": "page", "text": "First page."},
        ],
    }
    return {**base, **overrides}


# --------------------------------------------------------------------------
# collection mapping
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("course_id", "expected"),
    [
        ("IST.323", "ist323"),
        ("ECN.304", "ecn304"),
        ("GEO.103.lecture", "geo103"),
        ("GEO.103.recitation", "geo103"),
    ],
)
def test_course_id_maps_to_lowercase_folder(course_id: str, expected: str):
    assert collection_for_course(course_id) == expected


@pytest.mark.parametrize("bad", ["", "ist323", "IST", "IST.", "IST.32x", "323.IST"])
def test_unrecognised_course_id_is_refused(bad: str):
    with pytest.raises(SourceError):
        collection_for_course(bad)


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------


def test_slugify_is_filesystem_safe_and_stable():
    assert slugify("LectureM3_IST466Fall 2026 (2).pptx") == "lecturem3-ist466fall-2026-2"
    assert slugify("Welcome & Course Introduction.pptx") == "welcome-course-introduction"
    assert slugify("___") == "material"


def test_note_path_carries_the_bb2dash_id_and_frontmatter_is_complete():
    note = render_note(row())
    assert note.relative_path == "classes/ist323/materials/323fall26v1-3-1-2.md"
    frontmatter, body = split_frontmatter(note.content)
    assert frontmatter["id"] == "bb2dash-file-2"
    assert frontmatter["title"] == "323Fall26V1.3.1.docx"
    assert frontmatter["collection"] == "ist323"
    assert frontmatter["type"] == "material"
    assert frontmatter["ingest"] is False
    assert frontmatter["course"] == "IST.323"
    assert frontmatter["bucket"] == "syllabus_policy"
    assert frontmatter["sha256"] == "937103b4"
    assert frontmatter["bb_path"].startswith("Syllabus &")
    assert "week" not in frontmatter  # null week_no is omitted, not written as null


def test_units_render_in_order_with_headings_and_trimmed_text():
    _, body = split_frontmatter(render_note(row()).content)
    first = body.index("## Page 1")
    second = body.index("## Page 2")
    assert first < second
    assert "First page." in body
    assert "Second page." in body
    assert "  \n" not in body


def test_single_doc_unit_has_a_plain_heading():
    single = row(bb_file_text=[{"unit_no": 1, "unit_kind": "doc", "text": "Whole doc."}])
    _, body = split_frontmatter(render_note(single).content)
    assert "## Document" in body
    assert "## Document 1" not in body


def test_speaker_notes_marker_is_preserved_verbatim():
    slide = row(bb_file_text=[{"unit_no": 1, "unit_kind": "slide", "text": "Title\n[notes] private"}])
    _, body = split_frontmatter(render_note(slide).content)
    assert "[notes] private" in body


def test_note_declares_where_retrieval_lives():
    _, body = split_frontmatter(render_note(row()).content)
    assert "bb2dash" in body and "ingest: false" in body


def test_exported_note_round_trips_as_an_ingest_skip(tmp_path: Path):
    note = render_note(row())
    target = tmp_path / note.relative_path
    target.parent.mkdir(parents=True)
    target.write_text(note.content, encoding="utf-8")
    loaded = load_vault(tmp_path)
    assert not loaded.documents
    assert loaded.skipped[0].reason == "frontmatter ingest: false"


# --------------------------------------------------------------------------
# planning: skips and collisions
# --------------------------------------------------------------------------


def test_plan_skips_unextracted_and_superseded_files():
    rows = [
        row(id=1),
        row(id=2, text_status="pending", bb_file_text=[]),
        row(id=3, superseded_by=9),
        row(id=4, bb_file_text=[]),
    ]
    planned = plan_notes(rows)
    assert [n.file_id for n in planned.notes] == [1]
    reasons = {s.external_id: s.reason for s in planned.skipped}
    assert reasons["bb2dash-file-2"] == "text_status is pending"
    assert reasons["bb2dash-file-3"] == "superseded by bb2dash-file-9"
    assert reasons["bb2dash-file-4"] == "no text units"


def test_same_filename_in_one_course_never_collides():
    rows = [row(id=10), row(id=11)]
    paths = [n.relative_path for n in plan_notes(rows).notes]
    assert paths == [
        "classes/ist323/materials/323fall26v1-3-1-10.md",
        "classes/ist323/materials/323fall26v1-3-1-11.md",
    ]


def test_note_path_is_a_pure_function_of_the_row():
    # A path must not depend on which other files are in the run: once a
    # same-named sibling is superseded, the survivor must not move.
    alone = plan_notes([row(id=11)]).notes[0].relative_path
    with_sibling = [n for n in plan_notes([row(id=10), row(id=11)]).notes if n.file_id == 11][0]
    assert alone == with_sibling.relative_path


def test_plan_order_is_by_file_id_regardless_of_input_order():
    planned = plan_notes([row(id=5), row(id=3)])
    assert [n.file_id for n in planned.notes] == [3, 5]


def test_unrecognised_course_id_is_a_skip_not_an_abort():
    rows = [row(id=1), row(id=2, course_id="COMPSCI.335"), row(id=3, course_id="ist323")]
    planned = plan_notes(rows)
    assert [n.file_id for n in planned.notes] == [1]
    reasons = {s.external_id: s.reason for s in planned.skipped}
    assert "unrecognised bb2dash course id" in reasons["bb2dash-file-2"]
    assert "unrecognised bb2dash course id" in reasons["bb2dash-file-3"]


# --------------------------------------------------------------------------
# client
# --------------------------------------------------------------------------


def test_null_course_id_is_a_skip_not_an_abort():
    # bb_files.course_id is nullable: the classifier fills it in later. One
    # unclassified file must not abort the export of every other file.
    rows = [row(id=1), row(id=2, course_id=None), row(id=3, course_id="")]
    planned = plan_notes(rows)
    assert [n.file_id for n in planned.notes] == [1]
    reasons = {s.external_id: s.reason for s in planned.skipped}
    assert "no course id" in reasons["bb2dash-file-2"]
    assert "no course id" in reasons["bb2dash-file-3"]


def test_validate_row_accepts_a_null_course_id_but_not_a_non_string():
    assert validate_row(row(course_id=None))["course_id"] is None
    with pytest.raises(SourceError):
        validate_row(row(course_id=323))


def test_only_https_to_the_bb2dash_project_is_accepted():
    # A plain-http URL would send the service-role key in cleartext.
    with pytest.raises(ConfigError, match="https"):
        assert_bb2dash_url(f"http://{BB2DASH_PROJECT_REF}.supabase.co")
    with pytest.raises(ConfigError, match="https"):
        assert_bb2dash_url(f"{BB2DASH_PROJECT_REF}.supabase.co")


def test_only_the_bb2dash_project_url_is_accepted():
    assert_bb2dash_url(f"https://{BB2DASH_PROJECT_REF}.supabase.co")
    with pytest.raises(ConfigError):
        assert_bb2dash_url("https://hqkytnyiiuxovnnyixye.supabase.co")  # harness-memory
    with pytest.raises(ConfigError):
        assert_bb2dash_url("")


def test_validate_row_rejects_missing_fields():
    with pytest.raises(SourceError):
        validate_row({"id": 1})
    with pytest.raises(SourceError):
        validate_row(row(id="two"))
    with pytest.raises(SourceError):
        validate_row(row(bb_file_text="not a list"))


class FakeResponse(io.BytesIO):
    def __init__(self, payload, status=200):
        super().__init__(json.dumps(payload).encode("utf-8"))
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def test_fetch_paginates_and_sends_service_role_headers():
    seen: list = []

    def opener(request, timeout):
        seen.append(request)
        # PostgREST pagination: `Range-Unit: items` + `Range: <first>-<last>`.
        assert request.get_header("Range-unit") == "items"
        offset = int(request.get_header("Range").split("-")[0])
        page = [row(id=offset + 1)] if offset < 2 else []
        return FakeResponse(page)

    rows = fetch_materials(
        f"https://{BB2DASH_PROJECT_REF}.supabase.co", "service-key", opener=opener, page_size=1
    )
    assert [r["id"] for r in rows] == [1, 2]
    first = seen[0]
    assert first.get_header("Apikey") == "service-key"
    assert first.get_header("Authorization") == "Bearer service-key"
    assert "bb_files" in first.full_url and "bb_file_text" in first.full_url


def test_fetch_course_filter_is_forwarded():
    def opener(request, timeout):
        assert "course_id=eq.IST.323" in request.full_url
        return FakeResponse([])

    assert fetch_materials(
        f"https://{BB2DASH_PROJECT_REF}.supabase.co", "k", opener=opener, course="IST.323"
    ) == []


def test_fetch_surfaces_http_errors_without_the_key():
    import urllib.error

    def opener(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, io.BytesIO(b"{}"))

    with pytest.raises(SourceError) as excinfo:
        fetch_materials(f"https://{BB2DASH_PROJECT_REF}.supabase.co", "secret-key", opener=opener)
    assert "401" in str(excinfo.value)
    assert "secret-key" not in str(excinfo.value)


# --------------------------------------------------------------------------
# writing
# --------------------------------------------------------------------------


def test_write_is_idempotent_and_reports_changes(tmp_path: Path):
    notes = plan_notes([row(id=1), row(id=2, course_id="ECN.304")]).notes
    first = write_notes(tmp_path, notes, dry_run=False)
    assert (first.created, first.updated, first.unchanged) == (2, 0, 0)
    second = write_notes(tmp_path, notes, dry_run=False)
    assert (second.created, second.updated, second.unchanged) == (0, 0, 2)

    changed = plan_notes([row(id=1, sha256="new"), row(id=2, course_id="ECN.304")]).notes
    third = write_notes(tmp_path, changed, dry_run=False)
    assert (third.created, third.updated, third.unchanged) == (0, 1, 1)


def test_dry_run_writes_nothing(tmp_path: Path):
    stats = write_notes(tmp_path, plan_notes([row()]).notes, dry_run=True)
    assert stats.created == 1
    assert not list(tmp_path.rglob("*.md"))


def test_write_refuses_a_missing_vault_root(tmp_path: Path):
    with pytest.raises(ConfigError):
        write_notes(tmp_path / "nope", plan_notes([row()]).notes, dry_run=False)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def test_cli_requires_env_file_and_vault(capsys):
    with pytest.raises(SystemExit):
        main([])


def test_cli_end_to_end_with_injected_fetch(tmp_path: Path, monkeypatch, capsys):
    for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE"):
        monkeypatch.delenv(name, raising=False)
    env = tmp_path / "bb2dash.env"
    env.write_text(
        f"SUPABASE_URL=https://{BB2DASH_PROJECT_REF}.supabase.co\nSUPABASE_SERVICE_ROLE=k\n",
        encoding="utf-8",
    )
    vault = tmp_path / "vault"
    vault.mkdir()
    calls: list = []

    def fetch(url, key, *, course=None):
        calls.append((url, key, course))
        return [row(id=1), row(id=2, text_status="failed", bb_file_text=[])]

    code = main(["--env-file", str(env), "--vault", str(vault)], fetch=fetch)
    assert code == 0
    assert calls == [(f"https://{BB2DASH_PROJECT_REF}.supabase.co", "k", None)]
    out = capsys.readouterr().out
    assert "created" in out and "1" in out
    assert "text_status is failed" in out
    assert (vault / "classes/ist323/materials/323fall26v1-3-1-1.md").is_file()


def _bb2dash_env(tmp_path: Path) -> Path:
    env = tmp_path / "bb2dash.env"
    env.write_text(
        f"SUPABASE_URL=https://{BB2DASH_PROJECT_REF}.supabase.co\nSUPABASE_SERVICE_ROLE=k\n",
        encoding="utf-8",
    )
    return env


def test_cli_rejects_a_malformed_course_filter_before_any_request(tmp_path: Path, capsys):
    vault = tmp_path / "vault"
    vault.mkdir()

    def fetch(*args, **kwargs):
        raise AssertionError("must not be called")

    code = main(
        ["--env-file", str(_bb2dash_env(tmp_path)), "--vault", str(vault), "--course", "ist323"],
        fetch=fetch,
    )
    assert code == 2
    assert "IST.323" in capsys.readouterr().err


def test_cli_treats_an_empty_course_match_as_an_error(tmp_path: Path, capsys):
    vault = tmp_path / "vault"
    vault.mkdir()
    code = main(
        ["--env-file", str(_bb2dash_env(tmp_path)), "--vault", str(vault), "--course", "IST.999"],
        fetch=lambda *a, **k: [],
    )
    assert code == 1
    assert "IST.999" in capsys.readouterr().err


def test_cli_refuses_the_harness_env_file(tmp_path: Path, monkeypatch, capsys):
    for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE"):
        monkeypatch.delenv(name, raising=False)
    env = tmp_path / "harness.env"
    env.write_text(
        "SUPABASE_URL=https://hqkytnyiiuxovnnyixye.supabase.co\nSUPABASE_SERVICE_ROLE=k\n",
        encoding="utf-8",
    )
    vault = tmp_path / "vault"
    vault.mkdir()
    code = main(["--env-file", str(env), "--vault", str(vault)], fetch=lambda *a, **k: [])
    assert code == 2
    assert "bb2dash" in capsys.readouterr().err
