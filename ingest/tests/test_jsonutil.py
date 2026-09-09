"""metadata jsonb serialisation, and the model cache location."""

from __future__ import annotations

import json
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path, PurePosixPath

import pytest

from ingest.config import ENV_MODEL_CACHE_DIR, embedding_cache_dir
from ingest.errors import SourceError
from ingest.jsonutil import dumps, json_safe


def test_scalars_pass_through():
    assert json_safe({"a": 1, "b": "x", "c": True, "d": None}) == {
        "a": 1,
        "b": "x",
        "c": True,
        "d": None,
    }


def test_yaml_dates_become_iso_strings():
    assert json_safe(date(2026, 9, 1)) == "2026-09-01"
    assert json_safe(datetime(2026, 9, 1, 12, 30)).startswith("2026-09-01T12:30")


def test_sets_become_sorted_lists():
    assert json_safe({"tags"} | {"rag"}) == ["rag", "tags"]


def test_paths_become_posix_strings():
    assert json_safe(PurePosixPath("notes/a.md")) == "notes/a.md"


def test_decimal_becomes_float():
    assert json_safe(Decimal("1.5")) == 1.5


def test_nan_and_infinity_become_null():
    assert json_safe(float("nan")) is None
    assert json_safe(float("inf")) is None


def test_unknown_objects_are_stringified_not_dropped():
    class Weird:
        def __str__(self):
            return "weird-value"

    assert json_safe(Weird()) == "weird-value"


def test_nesting_is_bounded():
    deep: object = "leaf"
    for _ in range(40):
        deep = {"next": deep}
    with pytest.raises(SourceError):
        json_safe(deep)


def test_dumps_produces_parseable_json_with_unicode_intact():
    payload = dumps({"title": "café", "created": date(2026, 9, 1)})
    assert json.loads(payload) == {"title": "café", "created": "2026-09-01"}


# --------------------------------------------------------------------------


def test_model_cache_defaults_outside_temp_and_outside_onedrive():
    default = Path(embedding_cache_dir({}))
    assert default == Path.home() / ".cache" / "fastembed"
    assert "onedrive" not in default.as_posix().lower()


def test_model_cache_can_be_overridden():
    assert embedding_cache_dir({ENV_MODEL_CACHE_DIR: "D:/models"}) == "D:/models"
