"""JSON helpers for the ``metadata`` jsonb column.

YAML frontmatter happily produces ``date``, ``datetime`` and ``set`` values that
``json.dumps`` refuses. Rather than let a single odd note abort a vault ingest,
:func:`json_safe` coerces them to strings and lists up front.
"""

from __future__ import annotations

import json
from datetime import date, datetime, time
from decimal import Decimal
from pathlib import PurePath
from typing import Any

from .errors import SourceError

_MAX_DEPTH = 32


def json_safe(value: Any, _depth: int = 0) -> Any:
    """Recursively coerce a value into something ``json.dumps`` accepts."""
    if _depth > _MAX_DEPTH:
        raise SourceError(f"metadata nested deeper than {_MAX_DEPTH} levels")

    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        # NaN/Infinity are valid Python floats but not valid JSON.
        return value if value == value and value not in (float("inf"), float("-inf")) else None
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, PurePath):
        return value.as_posix()
    if isinstance(value, dict):
        return {str(k): json_safe(v, _depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v, _depth + 1) for v in value]
    if isinstance(value, (set, frozenset)):
        return sorted(json_safe(v, _depth + 1) for v in value)
    return str(value)


def dumps(value: Any) -> str:
    """Serialise metadata for a jsonb parameter."""
    return json.dumps(json_safe(value), ensure_ascii=False)


def parse_json_text_column(
    raw: Any, *, field: str, external_id: str, default: Any = None
) -> Any:
    """Decode a claude-mem column that holds JSON inside a TEXT field.

    ``facts``, ``concepts``, ``files_read`` and ``files_modified`` are stored as
    JSON strings, not arrays. NULL and empty string become ``default``. A value
    that is already decoded is passed through. Malformed JSON raises rather than
    being dropped — the caller decides whether to fail the document.
    """
    if raw is None:
        return default
    if isinstance(raw, (list, dict)):
        return raw
    if not isinstance(raw, str):
        raise SourceError(
            f"{external_id}: {field} has unexpected type {type(raw).__name__}"
        )
    text = raw.strip()
    if not text:
        return default
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise SourceError(f"{external_id}: {field} is not valid JSON ({exc})") from exc
