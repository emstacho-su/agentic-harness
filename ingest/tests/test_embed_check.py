"""``ingest embed-check``: the reference file, cosine scoring and the command line.

No model is loaded: every embedder here is a fake that hands back vectors the
test chose, so a check can be made to pass or fail on purpose.
"""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from pathlib import Path

import numpy as np
import pytest

from ingest import embed_check
from ingest.cli import main
from ingest.embed_check import (
    COSINE_THRESHOLD,
    DEFAULT_REFERENCES,
    REFERENCE_TEXTS,
    Provenance,
    References,
    check,
    cosine,
    load_references,
    record,
    score,
    write_references,
)
from ingest.errors import ConfigError

MODEL = "BAAI/bge-small-en-v1.5"
DIMENSIONS = 384
# Seeded so every run builds the same unit vectors.
SEED = 20260924
# R-D2's perturbation: enough to drop the cosine far below the threshold.
PERTURBATION = 0.05
PERTURBED_INDEX = 3


def unit_vectors(count: int, dimensions: int = DIMENSIONS) -> list[list[float]]:
    rng = np.random.default_rng(SEED)
    raw = rng.normal(size=(count, dimensions))
    return [list(map(float, row / np.linalg.norm(row))) for row in raw]


def provenance(model: str = MODEL) -> Provenance:
    return Provenance(
        model=model,
        fastembed="0.8.0",
        onnxruntime="1.29.0",
        machine="test-box",
        recorded_at="2026-09-24T00:00:00+00:00",
    )


class ReferenceEmbedder:
    """Returns a chosen vector per text, like a machine that reproduces (or not) the file."""

    def __init__(
        self,
        vectors: dict[str, list[float]],
        dimensions: int = DIMENSIONS,
        model_name: str = MODEL,
    ) -> None:
        self.vectors = vectors
        self._dimensions = dimensions
        self.model_name = model_name
        self.calls: list[list[str]] = []

    @property
    def dimensions(self) -> int:
        return self._dimensions

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        return [list(self.vectors[text]) for text in texts]


def reference_vectors() -> dict[str, list[float]]:
    return dict(zip(REFERENCE_TEXTS, unit_vectors(len(REFERENCE_TEXTS)), strict=True))


def perturbed(vectors: dict[str, list[float]], text: str) -> dict[str, list[float]]:
    changed = [value + PERTURBATION for value in vectors[text]]
    return {**vectors, text: changed}


def references_from(vectors: dict[str, list[float]]) -> References:
    return record(tuple(vectors), ReferenceEmbedder(vectors), provenance())


def write_json(path: Path, payload: object) -> Path:
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def raw_payload(vectors: dict[str, list[float]]) -> dict[str, object]:
    return {
        "model": MODEL,
        "dimensions": DIMENSIONS,
        "fastembed": "0.8.0",
        "onnxruntime": "1.29.0",
        "machine": "test-box",
        "recorded_at": "2026-09-24T00:00:00+00:00",
        "items": [{"text": text, "vector": vector} for text, vector in vectors.items()],
    }


# -- the built-in texts --------------------------------------------------------


def test_there_are_ten_distinct_non_empty_reference_texts() -> None:
    assert len(REFERENCE_TEXTS) == 10
    assert len(set(REFERENCE_TEXTS)) == 10
    assert all(text.strip() for text in REFERENCE_TEXTS)
    assert any(not text.isascii() for text in REFERENCE_TEXTS)
    assert "ok" in REFERENCE_TEXTS


def test_the_threshold_is_the_requirement_value() -> None:
    assert COSINE_THRESHOLD == 0.999


# -- cosine ---------------------------------------------------------------------


def test_cosine_of_a_vector_with_itself_is_one() -> None:
    vector = unit_vectors(1)[0]
    assert cosine(vector, vector) == pytest.approx(1.0)


def test_cosine_guards_a_zero_norm() -> None:
    assert cosine([0.0] * 4, [1.0, 0.0, 0.0, 0.0]) == 0.0


# -- check (tests 1 and 2) ------------------------------------------------------


def test_check_passes_when_the_embedder_reproduces_the_references() -> None:
    vectors = reference_vectors()
    references = references_from(vectors)

    result = check(references, ReferenceEmbedder(vectors), COSINE_THRESHOLD)

    assert result.ok is True
    assert result.worst.cosine == pytest.approx(1.0)
    assert len(result.scores) == 10


def test_check_fails_and_names_the_perturbed_item() -> None:
    vectors = reference_vectors()
    references = references_from(vectors)
    target = REFERENCE_TEXTS[PERTURBED_INDEX]

    result = check(references, ReferenceEmbedder(perturbed(vectors, target)), COSINE_THRESHOLD)

    assert result.ok is False
    assert result.worst.text == target
    assert result.worst.cosine < COSINE_THRESHOLD
    others = [s.cosine for s in result.scores if s.text != target]
    assert min(others) == pytest.approx(1.0)


def test_score_embeds_every_text_in_one_call() -> None:
    vectors = reference_vectors()
    embedder = ReferenceEmbedder(vectors)
    scores = score(references_from(vectors), embedder)
    assert [s.text for s in scores] == list(REFERENCE_TEXTS)
    assert embedder.calls == [list(REFERENCE_TEXTS)]


@pytest.mark.parametrize("threshold", [0.0, -0.5, 1.5, math.nan])
def test_check_rejects_a_threshold_outside_zero_to_one(threshold: float) -> None:
    vectors = reference_vectors()
    with pytest.raises(ConfigError, match="threshold"):
        check(references_from(vectors), ReferenceEmbedder(vectors), threshold)


# -- load_references (test 3) ---------------------------------------------------


def test_load_rejects_a_file_without_items(tmp_path: Path) -> None:
    payload = raw_payload(reference_vectors())
    del payload["items"]
    with pytest.raises(ConfigError, match="items"):
        load_references(write_json(tmp_path / "refs.json", payload))


def test_load_rejects_a_short_vector_and_names_the_item(tmp_path: Path) -> None:
    payload = raw_payload(reference_vectors())
    payload["items"][2]["vector"] = payload["items"][2]["vector"][:383]
    with pytest.raises(ConfigError, match=r"item 2.*383"):
        load_references(write_json(tmp_path / "refs.json", payload))


def test_load_rejects_a_nan_and_names_the_item(tmp_path: Path) -> None:
    payload = raw_payload(reference_vectors())
    payload["items"][5]["vector"][10] = math.nan
    with pytest.raises(ConfigError, match=r"item 5.*finite"):
        load_references(write_json(tmp_path / "refs.json", payload))


def test_load_rejects_dimensions_that_do_not_match_the_vectors(tmp_path: Path) -> None:
    payload = raw_payload(reference_vectors())
    payload["dimensions"] = 383
    with pytest.raises(ConfigError, match=r"item 0"):
        load_references(write_json(tmp_path / "refs.json", payload))


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("model", "", "model"),
        ("model", 7, "model"),
        ("dimensions", "384", "dimensions"),
        ("dimensions", True, "dimensions"),
        ("items", [], "items"),
    ],
)
def test_load_rejects_malformed_header_fields(
    tmp_path: Path, field: str, value: object, message: str
) -> None:
    payload = {**raw_payload(reference_vectors()), field: value}
    with pytest.raises(ConfigError, match=message):
        load_references(write_json(tmp_path / "refs.json", payload))


def test_load_rejects_a_duplicate_text(tmp_path: Path) -> None:
    payload = raw_payload(reference_vectors())
    payload["items"][1]["text"] = payload["items"][0]["text"]
    with pytest.raises(ConfigError, match=r"item 1.*duplicate"):
        load_references(write_json(tmp_path / "refs.json", payload))


def test_load_reports_a_missing_file_and_bad_json(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="not found"):
        load_references(tmp_path / "absent.json")
    broken = tmp_path / "broken.json"
    broken.write_text("{not json", encoding="utf-8")
    with pytest.raises(ConfigError, match="JSON"):
        load_references(broken)


# -- record / write / load round trip (test 4) ----------------------------------


def test_record_write_load_check_round_trips(tmp_path: Path) -> None:
    vectors = reference_vectors()
    embedder = ReferenceEmbedder(vectors)
    path = tmp_path / "embeddings.json"

    write_references(record(REFERENCE_TEXTS, embedder, provenance()), path)
    loaded = load_references(path)

    assert loaded.model == MODEL
    assert loaded.dimensions == DIMENSIONS
    assert loaded.machine == "test-box"
    assert [item.text for item in loaded.items] == list(REFERENCE_TEXTS)
    # repr precision: the floats come back bit for bit.
    assert list(loaded.items[0].vector) == vectors[REFERENCE_TEXTS[0]]
    assert check(loaded, embedder, COSINE_THRESHOLD).ok is True


def test_write_puts_one_item_per_line_and_keeps_non_ascii(tmp_path: Path) -> None:
    path = tmp_path / "embeddings.json"
    write_references(references_from(reference_vectors()), path)
    text = path.read_text(encoding="utf-8")
    item_lines = [line for line in text.splitlines() if line.lstrip().startswith('{"text"')]
    assert len(item_lines) == 10
    assert "café" in text


def test_write_refuses_to_overwrite_unless_asked(tmp_path: Path) -> None:
    path = tmp_path / "embeddings.json"
    references = references_from(reference_vectors())
    write_references(references, path)
    with pytest.raises(ConfigError, match="exists"):
        write_references(references, path)
    write_references(references, path, overwrite=True)


def test_record_rejects_a_vector_of_the_wrong_length() -> None:
    vectors = {text: [0.1] * 10 for text in REFERENCE_TEXTS}
    with pytest.raises(ConfigError, match="item 0"):
        record(REFERENCE_TEXTS, ReferenceEmbedder(vectors), provenance())


# -- the command line (test 5) ---------------------------------------------------


def use_embedder(monkeypatch: pytest.MonkeyPatch, embedder: ReferenceEmbedder) -> None:
    monkeypatch.setattr(embed_check, "build_embedder", lambda: embedder)


def reference_file(tmp_path: Path, vectors: dict[str, list[float]]) -> Path:
    path = tmp_path / "embeddings.json"
    write_references(references_from(vectors), path)
    return path


def test_cli_passes_and_prints_one_line_per_item(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    vectors = reference_vectors()
    path = reference_file(tmp_path, vectors)
    use_embedder(monkeypatch, ReferenceEmbedder(vectors))

    code = main(["embed-check", "--file", str(path)])
    out = capsys.readouterr().out

    assert code == 0
    lines = out.splitlines()
    assert sum(1 for line in lines if line.startswith("  1.000000  ")) == 10
    assert lines[-1].startswith("embed-check: pass (worst ")


def test_cli_fails_on_a_perturbed_reference(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    vectors = reference_vectors()
    target = REFERENCE_TEXTS[PERTURBED_INDEX]
    path = reference_file(tmp_path, perturbed(vectors, target))
    use_embedder(monkeypatch, ReferenceEmbedder(vectors))

    code = main(["embed-check", "--file", str(path)])
    last = capsys.readouterr().out.splitlines()[-1]

    assert code == 1
    assert last.startswith("embed-check: FAIL (worst ")
    assert "threshold 0.999" in last


def test_cli_refuses_a_dimension_mismatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    vectors = reference_vectors()
    path = reference_file(tmp_path, vectors)
    use_embedder(monkeypatch, ReferenceEmbedder(vectors, dimensions=256))

    code = main(["embed-check", "--file", str(path)])

    assert code == 2
    assert "dimensions" in capsys.readouterr().err


def test_cli_refuses_a_model_mismatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    vectors = reference_vectors()
    path = reference_file(tmp_path, vectors)
    use_embedder(monkeypatch, ReferenceEmbedder(vectors, model_name="other/model"))

    code = main(["embed-check", "--file", str(path)])

    assert code == 2
    assert "model" in capsys.readouterr().err


def test_cli_json_reports_ok_and_worst(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    vectors = reference_vectors()
    path = reference_file(tmp_path, vectors)
    use_embedder(monkeypatch, ReferenceEmbedder(vectors))

    code = main(["embed-check", "--file", str(path), "--json", "--threshold", "0.9"])
    payload = json.loads(capsys.readouterr().out)

    assert code == 0
    assert payload["ok"] is True
    assert payload["threshold"] == 0.9
    assert payload["worst"]["cosine"] == pytest.approx(1.0)
    assert payload["worst"]["text"] in REFERENCE_TEXTS
    assert len(payload["scores"]) == 10


def test_cli_reports_a_bad_file_as_a_usage_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    use_embedder(monkeypatch, ReferenceEmbedder(reference_vectors()))
    code = main(["embed-check", "--file", str(tmp_path / "absent.json")])
    assert code == 2
    assert "not found" in capsys.readouterr().err


def test_cli_rejects_a_threshold_out_of_range(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    vectors = reference_vectors()
    path = reference_file(tmp_path, vectors)
    use_embedder(monkeypatch, ReferenceEmbedder(vectors))
    assert main(["embed-check", "--file", str(path), "--threshold", "1.5"]) == 2
    assert "threshold" in capsys.readouterr().err


def test_cli_record_writes_the_built_in_texts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    vectors = reference_vectors()
    path = tmp_path / "embeddings.json"
    use_embedder(monkeypatch, ReferenceEmbedder(vectors))
    monkeypatch.setenv("HARNESS_MACHINE", "home-pc")

    code = main(["embed-check", "--record", "--file", str(path)])

    assert code == 0
    assert capsys.readouterr().out.strip() == f"recorded 10 references to {path}"
    loaded = load_references(path)
    assert loaded.machine == "home-pc"
    assert loaded.model == MODEL
    assert [item.text for item in loaded.items] == list(REFERENCE_TEXTS)


def test_cli_record_labels_the_machine_unknown_without_the_variable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "embeddings.json"
    use_embedder(monkeypatch, ReferenceEmbedder(reference_vectors()))
    monkeypatch.delenv("HARNESS_MACHINE", raising=False)
    assert main(["embed-check", "--record", "--file", str(path)]) == 0
    assert load_references(path).machine == "unknown"


def test_cli_record_refuses_an_existing_file_without_force(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    vectors = reference_vectors()
    path = reference_file(tmp_path, vectors)
    before = path.read_text(encoding="utf-8")
    use_embedder(monkeypatch, ReferenceEmbedder(vectors))

    assert main(["embed-check", "--record", "--file", str(path)]) == 2
    assert "--force" in capsys.readouterr().err
    assert path.read_text(encoding="utf-8") == before

    assert main(["embed-check", "--record", "--force", "--file", str(path)]) == 0


def test_cli_force_without_record_is_a_usage_error(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["embed-check", "--force"]) == 2
    assert "--record" in capsys.readouterr().err


# -- the committed reference file (test 6) ---------------------------------------


def test_the_committed_reference_file_is_well_formed() -> None:
    references = load_references(DEFAULT_REFERENCES)
    assert len(references.items) == 10
    assert references.dimensions == 384
    assert references.model == MODEL
    assert [item.text for item in references.items] == list(REFERENCE_TEXTS)
