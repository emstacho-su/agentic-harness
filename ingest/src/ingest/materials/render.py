"""Pure rendering: bb2dash file rows -> vault notes. No I/O.

Identity: ``id: bb2dash-file-<bb_files.id>`` so a note keeps its row even if it
is renamed in the vault. Location:
``classes/<collection>/materials/<slug>-<bb_files.id>.md`` where the collection
is the lowercase course folder (``IST.323`` -> ``ist323``, ``GEO.103.lecture``
and ``GEO.103.recitation`` -> ``geo103``).

The filename always carries the bb2dash id. A collision-only suffix would make a
file's path depend on which *other* files are in the same run — once one of two
same-named files is superseded, the survivor would move and the old note would
linger with a duplicate ``id:``. Keying on the id makes paths a pure function of
the row, so re-runs are idempotent by construction.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any

import yaml

from ..errors import SourceError
from ..loaders.base import SkippedRecord
from .client import validate_row

GENERATOR = "export-materials 0.1.0"
NOTE_TYPE = "material"
SOURCE_NAME = "bb2dash"
MATERIALS_FOLDER = "materials"
CLASSES_FOLDER = "classes"
FALLBACK_SLUG = "material"

# SUBJECT.NUMBER with an optional lowercase section suffix (.lecture, .recitation).
_COURSE_ID = re.compile(r"^([A-Z]{2,4})\.(\d{3})(?:\.[a-z]+)?$")
_NON_SLUG = re.compile(r"[^a-z0-9]+")

_UNIT_LABELS = {"slide": "Slide", "page": "Page", "sheet": "Sheet", "doc": "Document"}


@dataclass(frozen=True)
class MaterialNote:
    file_id: int
    relative_path: str
    content: str


@dataclass(frozen=True)
class PlannedNotes:
    notes: tuple[MaterialNote, ...]
    skipped: tuple[SkippedRecord, ...]


def collection_for_course(course_id: str) -> str:
    match = _COURSE_ID.match(course_id or "")
    if not match:
        raise SourceError(f"unrecognised bb2dash course id: {course_id!r}")
    return f"{match.group(1).lower()}{match.group(2)}"


def slugify(file_name: str) -> str:
    stem = PurePosixPath(file_name).stem
    slug = _NON_SLUG.sub("-", stem.lower()).strip("-")
    return slug or FALLBACK_SLUG


def external_id_for(file_id: int) -> str:
    return f"{SOURCE_NAME}-file-{file_id}"


def plan_notes(rows: list[dict[str, Any]]) -> PlannedNotes:
    """Decide which rows become notes. Every skip is named; one bad row never
    aborts the export of the others."""
    notes: list[MaterialNote] = []
    skipped: list[SkippedRecord] = []

    for row in sorted((validate_row(r) for r in rows), key=lambda r: r["id"]):
        reason = _skip_reason(row)
        if reason:
            skipped.append(SkippedRecord(external_id_for(row["id"]), reason))
            continue
        notes.append(render_note(row))

    return PlannedNotes(tuple(notes), tuple(skipped))


def render_note(row: dict[str, Any]) -> MaterialNote:
    folder = _folder_for(row["course_id"])
    name = f"{slugify(row['file_name'])}-{row['id']}.md"
    return MaterialNote(
        file_id=row["id"],
        relative_path=f"{folder}/{name}",
        content=_frontmatter(row) + _body(row),
    )


# --------------------------------------------------------------------------


def _skip_reason(row: dict[str, Any]) -> str | None:
    if row.get("superseded_by") is not None:
        return f"superseded by {external_id_for(row['superseded_by'])}"
    status = row.get("text_status")
    if status not in (None, "extracted"):
        return f"text_status is {status}"
    if not row["bb_file_text"]:
        return "no text units"
    if not (row.get("course_id") or "").strip():
        return "no course id yet (bb_files.course_id is filled by the classifier)"
    try:
        collection_for_course(row["course_id"])
    except SourceError as exc:
        # bb_files.course_id is free text with no CHECK constraint.
        return str(exc)
    return None


def _folder_for(course_id: str) -> str:
    return f"{CLASSES_FOLDER}/{collection_for_course(course_id)}/{MATERIALS_FOLDER}"


def _frontmatter(row: dict[str, Any]) -> str:
    fields: dict[str, Any] = {
        "id": external_id_for(row["id"]),
        "title": row["file_name"],
        "collection": collection_for_course(row["course_id"]),
        "type": NOTE_TYPE,
        "ingest": False,
        "source": SOURCE_NAME,
        "course": row["course_id"],
        "bucket": row.get("bucket"),
        "week": row.get("week_no"),
        "bb_path": row.get("path"),
        "sha256": row.get("sha256"),
        "captured_at": row.get("captured_at"),
        "generator": GENERATOR,
    }
    present = {key: value for key, value in fields.items() if value is not None}
    dumped = yaml.safe_dump(present, sort_keys=False, allow_unicode=True, width=1000)
    return f"---\n{dumped}---\n\n"


def _body(row: dict[str, Any]) -> str:
    units = sorted(row["bb_file_text"], key=lambda u: u["unit_no"])
    lines = [
        f"# {row['file_name']}",
        "",
        f"> Exported from {SOURCE_NAME} (`bb_files` #{row['id']}, {row['course_id']}, "
        f"{row.get('bucket') or 'unclassified'}). Search these materials with the "
        f"`{SOURCE_NAME}` MCP server; this note carries `ingest: false` so the harness "
        "RAG never embeds it.",
        "",
    ]
    for unit in units:
        lines.append(f"## {_unit_heading(unit, single=len(units) == 1)}")
        lines.append("")
        lines.append(_clean_text(unit["text"]))
        lines.append("")
    return "\n".join(lines).rstrip("\n") + "\n"


def _unit_heading(unit: dict[str, Any], *, single: bool) -> str:
    kind = unit["unit_kind"]
    label = _UNIT_LABELS.get(kind, kind.replace("_", " ").title())
    return label if single else f"{label} {unit['unit_no']}"


def _clean_text(text: str) -> str:
    return "\n".join(line.rstrip() for line in text.splitlines()).strip()
