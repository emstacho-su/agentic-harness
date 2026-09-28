"""R-C2: the extraction answer's JSON schema and the checks each item must pass.

One judge call covers several notes, so the answer is
``{"notes": [{"ref": "N1", "issues": [...], "decisions": [...], "requirement_ids": [...],
"status_claims": [...], "open_questions": [...]}]}``, Draft 2020-12 with
``additionalProperties: false`` throughout. ``ref`` is one of the short opaque
labels the prompt assigned (N1..Nk), never a note id or path, so the model never
has to echo untrusted text to route an answer.

The schema is only the structural contract (types, enums, required fields,
``additionalProperties: false``); a violation fails the whole batch
(:class:`~ingest.curate.judge.JudgeOutputInvalid`). It deliberately carries no
``maxLength``, ``minLength`` or ``pattern``: those are checked per item here, so
one over-long summary or malformed id rejects that item, never the batch. The
label pattern is checked when answers are routed (``extract.py``).

The guard, per item, rejects with a reason (:data:`REJECT_REASONS`):

* ``evidence`` not an exact substring of its note, after CRLF -> LF on both
  sides and nothing else (``not-in-note``), shorter than
  :data:`MIN_EVIDENCE_CHARS` once stripped so "the" cannot pass (``too-short``),
  or longer than :data:`MAX_EVIDENCE_CHARS` (``too-long``);
* a summary, claim or question that is blank (``too-short``) or longer than
  :data:`MAX_SUMMARY_CHARS` (``too-long``), a ``fix_ref`` longer than
  :data:`MAX_FIX_REF_CHARS` (``too-long``);
* a requirement id, alone or on a status claim, that does not match
  :data:`REQUIREMENT_ID_PATTERN` (``bad-requirement-id``) or does not appear
  verbatim in the note as a whole token (``not-in-note``).

**Stored shape.** :func:`check_note_answer` flattens a note's answer into one
tuple of item dicts, each with a ``type`` (see :data:`ITEM_TYPES`) plus its own
fields, in a fixed order: issues, decisions, requirements, status claims, open
questions, and within a type the model's order. That tuple becomes
``Extraction.result``, and the ledger addresses an item by its index in it
(``IssueMember.item_index``), so this order must never change for a given
extractor version: changing it is a change of version (see ``extract.py``).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .profile import KIND_CLASS, KIND_PROJECT

SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"

MIN_EVIDENCE_CHARS = 12
MAX_EVIDENCE_CHARS = 600
MAX_SUMMARY_CHARS = 300
MAX_FIX_REF_CHARS = 200

ISSUE_KINDS = {
    KIND_PROJECT: ("bug", "error", "breakage"),
    KIND_CLASS: ("misconception", "blocker", "unresolved-question"),
}
CLAIMS = ("found", "fixed", "workaround", "wontfix")
# A status claim's state, which R-C4 reads: finished, started, stopped, or done once and now failing.
STATUS_STATES = ("done", "in-progress", "blocked", "broken")

# Loose on purpose: R-C2, R-H4, B-3, SC-4, R-N1a all match; a bare word does not.
REQUIREMENT_ID_PATTERN = r"^[A-Z][A-Za-z0-9]*(-[A-Za-z0-9]+)+$"
REF_PATTERN = r"^N[1-9][0-9]*$"

TYPE_ISSUE = "issue"
TYPE_DECISION = "decision"
TYPE_REQUIREMENT = "requirement"
TYPE_STATUS_CLAIM = "status_claim"
TYPE_OPEN_QUESTION = "open_question"
# The stored order of Extraction.result. Load-bearing: see the module docstring.
ITEM_TYPES = (TYPE_ISSUE, TYPE_DECISION, TYPE_REQUIREMENT, TYPE_STATUS_CLAIM, TYPE_OPEN_QUESTION)

# (answer key, stored type) for the evidence-bearing lists, in stored order.
_EVIDENCE_LISTS = (
    ("issues", TYPE_ISSUE),
    ("decisions", TYPE_DECISION),
    ("status_claims", TYPE_STATUS_CLAIM),
    ("open_questions", TYPE_OPEN_QUESTION),
)

REASON_NOT_IN_NOTE = "not-in-note"
REASON_TOO_SHORT = "too-short"
REASON_TOO_LONG = "too-long"
REASON_BAD_REQUIREMENT_ID = "bad-requirement-id"
REJECT_REASONS = (REASON_NOT_IN_NOTE, REASON_TOO_SHORT, REASON_TOO_LONG, REASON_BAD_REQUIREMENT_ID)

FIELD_EVIDENCE = "evidence"
FIELD_REQUIREMENT_ID = "requirement_id"
FIELD_FIX_REF = "fix_ref"
# The short free-text fields of each item, all capped at MAX_SUMMARY_CHARS.
TEXT_FIELDS = ("summary", "claim", "question")

_REQUIREMENT_ID = re.compile(REQUIREMENT_ID_PATTERN)
_REF = re.compile(REF_PATTERN)


def build_schema(kind: str) -> dict[str, Any]:
    """The answer schema for a profile kind (``project`` or ``class``).

    Structure only: no length or pattern keyword, so no single item can fail a
    batch. Limits are stated in descriptions for the model and enforced per item.
    """
    if kind not in ISSUE_KINDS:
        raise ValueError(f"no extraction schema for kind {kind!r}")
    evidence = {
        "type": "string",
        "description": f"a quote copied character for character from the note, "
                       f"{MIN_EVIDENCE_CHARS} to {MAX_EVIDENCE_CHARS} characters",
    }
    summary = {"type": "string", "description": f"at most {MAX_SUMMARY_CHARS} characters"}
    requirement_id = {"type": "string", "description": "an id exactly as written, like R-C2 or B-3"}
    return {
        "$schema": SCHEMA_DIALECT,
        "type": "object",
        "additionalProperties": False,
        "required": ["notes"],
        "properties": {"notes": {"type": "array", "items": {"$ref": "#/$defs/note"}}},
        "$defs": {
            "note": _object({
                "ref": {"type": "string", "description": "the note's label: N1, N2, ..."},
                "issues": _array({"$ref": "#/$defs/issue"}),
                "decisions": _array({"$ref": "#/$defs/decision"}),
                "requirement_ids": _array(requirement_id),
                "status_claims": _array({"$ref": "#/$defs/status_claim"}),
                "open_questions": _array({"$ref": "#/$defs/open_question"}),
            }),
            "issue": _object({
                "kind": {"enum": list(ISSUE_KINDS[kind])},
                "summary": summary,
                "evidence": evidence,
                "files": _array({"type": "string"}),
                "claim": {"enum": list(CLAIMS)},
                "fix_ref": {
                    "type": ["string", "null"],
                    "description": "a commit sha, #<PR number>, or a note reference; null when none",
                },
            }),
            "decision": _object({"summary": summary, "evidence": evidence}),
            "status_claim": _object({
                "requirement_id": {**requirement_id, "type": ["string", "null"]},
                "state": {"enum": list(STATUS_STATES)},
                "claim": summary,
                "evidence": evidence,
            }),
            "open_question": _object({"question": summary, "evidence": evidence}),
        },
    }


def _object(properties: dict[str, Any]) -> dict[str, Any]:
    """Every property required, nothing else allowed."""
    return {"type": "object", "additionalProperties": False,
            "required": list(properties), "properties": properties}


def _array(items: dict[str, Any]) -> dict[str, Any]:
    return {"type": "array", "items": items}


# -- the guard ----------------------------------------------------------------------------------


def normalise_newlines(text: str) -> str:
    """CRLF -> LF, the only normalisation the guard applies."""
    return text.replace("\r\n", "\n")


def evidence_problem(evidence: str, body_lf: str) -> str | None:
    """Why ``evidence`` fails the guard against an LF-normalised body, or None."""
    if len(evidence.strip()) < MIN_EVIDENCE_CHARS:
        return REASON_TOO_SHORT
    if len(evidence) > MAX_EVIDENCE_CHARS:
        return REASON_TOO_LONG
    if normalise_newlines(evidence) not in body_lf:
        return REASON_NOT_IN_NOTE
    return None


def is_ref(label: str) -> bool:
    """True for a label shaped like the ones the prompt assigns (N1, N2, ...)."""
    return _REF.fullmatch(label) is not None


def requirement_problem(requirement_id: str, body_lf: str) -> str | None:
    """Why a requirement id is rejected: malformed, or not in the note; None when it is fine."""
    if _REQUIREMENT_ID.fullmatch(requirement_id) is None:
        return REASON_BAD_REQUIREMENT_ID
    if not requirement_in_body(requirement_id, body_lf):
        return REASON_NOT_IN_NOTE
    return None


def requirement_in_body(requirement_id: str, body_lf: str) -> bool:
    """True when the id appears verbatim as a whole token: R-C2 is not found in R-C23."""
    token = re.compile(r"(?<![A-Za-z0-9-])" + re.escape(requirement_id) + r"(?![A-Za-z0-9-])")
    return token.search(body_lf) is not None


@dataclass(frozen=True)
class CheckedAnswer:
    """One note's answer after the guard: what is kept, and what is not with why."""

    accepted: tuple[dict[str, Any], ...]
    rejected: tuple[dict[str, Any], ...]


def check_note_answer(answer: Mapping[str, Any], body: str) -> CheckedAnswer:
    """Apply the guard to one schema-valid note answer; see the module docstring for order."""
    body_lf = normalise_newlines(body)
    kept: dict[str, list[dict[str, Any]]] = {item_type: [] for item_type in ITEM_TYPES}
    rejected: list[dict[str, Any]] = []

    for key, item_type in _EVIDENCE_LISTS:
        for fields in answer.get(key, ()):
            item = {"type": item_type, **fields}
            problem = _item_problem(item, body_lf)
            if problem is None:
                kept[item_type].append(item)
            else:
                rejected.append({**item, "field": problem[0], "reason": problem[1]})

    seen: set[str] = set()
    for requirement_id in answer.get("requirement_ids", ()):
        if requirement_id in seen:
            continue  # the same id twice is one reference, not two
        seen.add(requirement_id)
        item = {"type": TYPE_REQUIREMENT, FIELD_REQUIREMENT_ID: requirement_id}
        reason = requirement_problem(requirement_id, body_lf)
        if reason is None:
            kept[TYPE_REQUIREMENT].append(item)
        else:
            rejected.append({**item, "field": FIELD_REQUIREMENT_ID, "reason": reason})

    accepted = tuple(item for item_type in ITEM_TYPES for item in kept[item_type])
    return CheckedAnswer(accepted=accepted, rejected=tuple(rejected))


def _item_problem(item: Mapping[str, Any], body_lf: str) -> tuple[str, str] | None:
    """(field, reason) for the first check the item fails, or None.

    Order: evidence, then the free-text fields, then fix_ref, then the requirement id.
    """
    reason = evidence_problem(item[FIELD_EVIDENCE], body_lf)
    if reason is not None:
        return FIELD_EVIDENCE, reason
    for name in TEXT_FIELDS:
        text = item.get(name)
        if text is None:
            continue
        if not text.strip():
            return name, REASON_TOO_SHORT
        if len(text) > MAX_SUMMARY_CHARS:
            return name, REASON_TOO_LONG
    fix_ref = item.get(FIELD_FIX_REF)
    if fix_ref is not None and len(fix_ref) > MAX_FIX_REF_CHARS:
        return FIELD_FIX_REF, REASON_TOO_LONG
    requirement_id = item.get(FIELD_REQUIREMENT_ID)
    if requirement_id is not None:
        reason = requirement_problem(requirement_id, body_lf)
        if reason is not None:
            return FIELD_REQUIREMENT_ID, reason
    return None
