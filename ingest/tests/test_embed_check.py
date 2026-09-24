"""``ingest embed-check``: the reference file, cosine scoring and the command line.

No model is loaded: every embedder here is a fake that hands back vectors the
test chose, so a check can be made to pass or fail on purpose.
"""

from __future__ import annotations

import json
import logging
import math
import os
from collections.abc import Iterator, Sequence
from pathlib import Path

import numpy as np
import pytest

from ingest import embed_check, envfile
from ingest.cli import main
from ingest.config import embedding_cache_dir
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
from ingest.errors import ConfigError, EmbeddingError, IngestError

MODEL = "BAAI/bge-small-en-v1.5"
DIMENSIONS = 384
# Seeded so every run builds the same unit vectors.
SEED = 20260924
# R-D2's perturbation: enough to drop the cosine far below the threshold.
PERTURBATION = 0.05
PERTURBED_INDEX = 3
# The item the "bad embedding" tests break; any index but 0 proves it is named.
BAD_INDEX = 4
# A value from the machine file that must never reach any output.
SECRET = "s3cret-value-never-printed"
# The file layout the committed embeddings.json uses; the Provenance refactor keeps it.
FLAT_KEYS = {"model", "dimensions", "fastembed", "onnxruntime", "machine", "recorded_at", "items"}


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[None]:
    """No repo .env, no real machine file, and whatever a run loads is undone after it.

    embed-check now calls load_env_file, which writes os.environ directly; monkeypatch
    only undoes what it set, so the environment is snapshotted and restored here.
    """
    saved = dict(os.environ)
    monkeypatch.setattr(envfile, "find_env_file", lambda start=None: None)
    monkeypatch.setenv("HARNESS_MACHINE_ENV", str(tmp_path / "no-machine.env"))
    yield
    for key in set(os.environ) - set(saved):
        del os.environ[key]
    os.environ.update(saved)


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

    assert loaded.provenance == provenance()
    assert loaded.dimensions == DIMENSIONS
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


def test_write_keeps_the_flat_file_layout(tmp_path: Path) -> None:
    path = tmp_path / "embeddings.json"
    write_references(references_from(reference_vectors()), path)
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert set(payload) == FLAT_KEYS
    assert payload["machine"] == "test-box"
    assert payload["model"] == MODEL


def test_write_removes_the_staging_file_when_the_rename_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "embeddings.json"

    def refuse(_source: object, _target: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(embed_check.os, "replace", refuse)
    with pytest.raises(IngestError, match="disk full"):
        write_references(references_from(reference_vectors()), path)
    assert list(tmp_path.iterdir()) == []


def test_write_removes_the_staging_file_on_any_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "embeddings.json"

    def interrupted(_source: object, _target: object) -> None:
        raise KeyboardInterrupt

    monkeypatch.setattr(embed_check.os, "replace", interrupted)
    with pytest.raises(KeyboardInterrupt):
        write_references(references_from(reference_vectors()), path)
    assert list(tmp_path.iterdir()) == []


def test_record_rejects_an_embedding_of_the_wrong_width_as_an_embedding_error() -> None:
    vectors = {text: [0.1] * 10 for text in REFERENCE_TEXTS}
    with pytest.raises(EmbeddingError, match="item 0"):
        record(REFERENCE_TEXTS, ReferenceEmbedder(vectors), provenance())


def test_record_rejects_a_non_finite_embedding_and_names_the_item() -> None:
    vectors = reference_vectors()
    broken = {**vectors, REFERENCE_TEXTS[BAD_INDEX]: [math.inf] * DIMENSIONS}
    with pytest.raises(EmbeddingError, match=rf"item {BAD_INDEX}.*finite"):
        record(REFERENCE_TEXTS, ReferenceEmbedder(broken), provenance())


@pytest.mark.parametrize(
    "bad_vector",
    [[0.1] * (DIMENSIONS - 1), [math.nan] * DIMENSIONS],
    ids=["wrong-width", "nan"],
)
def test_score_rejects_a_bad_embedding_as_an_embedding_error(bad_vector: list[float]) -> None:
    vectors = reference_vectors()
    references = references_from(vectors)
    broken = {**vectors, REFERENCE_TEXTS[BAD_INDEX]: bad_vector}
    with pytest.raises(EmbeddingError, match=rf"item {BAD_INDEX}"):
        score(references, ReferenceEmbedder(broken))


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
    assert loaded.provenance.machine == "home-pc"
    assert loaded.provenance.model == MODEL
    assert [item.text for item in loaded.items] == list(REFERENCE_TEXTS)


def test_cli_record_labels_the_machine_unknown_without_the_variable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "embeddings.json"
    use_embedder(monkeypatch, ReferenceEmbedder(reference_vectors()))
    monkeypatch.delenv("HARNESS_MACHINE", raising=False)
    assert main(["embed-check", "--record", "--file", str(path)]) == 0
    assert load_references(path).provenance.machine == "unknown"


@pytest.mark.parametrize("label", ["home-pc", "laptop2", "a", "x" * 32])
def test_cli_record_accepts_a_hooks_style_machine_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, label: str
) -> None:
    path = tmp_path / "embeddings.json"
    use_embedder(monkeypatch, ReferenceEmbedder(reference_vectors()))
    monkeypatch.setenv("HARNESS_MACHINE", label)
    assert main(["embed-check", "--record", "--file", str(path)]) == 0
    assert load_references(path).provenance.machine == label


@pytest.mark.parametrize(
    "label",
    ["DESKTOP-4F2K9QX", "home_pc", "laptop.local", "-leading-dash", "x" * 33],
)
def test_cli_record_refuses_a_machine_name_the_hooks_would_refuse(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    label: str,
) -> None:
    path = tmp_path / "embeddings.json"
    use_embedder(monkeypatch, ReferenceEmbedder(reference_vectors()))
    monkeypatch.setenv("HARNESS_MACHINE", label)

    assert main(["embed-check", "--record", "--file", str(path)]) == 2
    assert "HARNESS_MACHINE" in capsys.readouterr().err
    assert not path.exists()


def write_machine_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, cache: Path) -> None:
    machine = tmp_path / "machine.env"
    machine.write_text(
        "\n".join(
            [
                "HARNESS_MACHINE=laptop",
                f"FASTEMBED_CACHE_DIR={cache.as_posix()}",
                f"DATABASE_URL=postgresql://harness:{SECRET}@localhost:5432/harness",
                "",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("HARNESS_MACHINE_ENV", str(machine))
    for name in ("HARNESS_MACHINE", "FASTEMBED_CACHE_DIR", "DATABASE_URL"):
        monkeypatch.delenv(name, raising=False)


class CacheRecorder:
    """build_embedder stand-in that notes the cache dir the live embedder would use."""

    def __init__(self, embedder: ReferenceEmbedder) -> None:
        self.embedder = embedder
        self.cache_dirs: list[str] = []

    def __call__(self) -> ReferenceEmbedder:
        self.cache_dirs.append(embedding_cache_dir())
        return self.embedder


def test_cli_record_reads_the_machine_file_before_building_the_embedder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = tmp_path / "model-cache"
    write_machine_file(tmp_path, monkeypatch, cache)
    recorder = CacheRecorder(ReferenceEmbedder(reference_vectors()))
    monkeypatch.setattr(embed_check, "build_embedder", recorder)
    path = tmp_path / "embeddings.json"

    assert main(["embed-check", "--record", "--file", str(path)]) == 0

    assert load_references(path).provenance.machine == "laptop"
    assert [Path(d) for d in recorder.cache_dirs] == [cache]


def test_cli_check_reads_the_machine_file_before_building_the_embedder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = tmp_path / "model-cache"
    vectors = reference_vectors()
    path = reference_file(tmp_path, vectors)
    write_machine_file(tmp_path, monkeypatch, cache)
    recorder = CacheRecorder(ReferenceEmbedder(vectors))
    monkeypatch.setattr(embed_check, "build_embedder", recorder)

    assert main(["embed-check", "--file", str(path)]) == 0
    assert [Path(d) for d in recorder.cache_dirs] == [cache]


@pytest.mark.parametrize(
    "extra",
    [["-v"], ["-v", "--json"], ["-v", "--record", "--force"], ["--threshold", "2"]],
    ids=["check", "json", "record", "usage-error"],
)
def test_cli_never_prints_a_value_from_the_machine_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
    extra: list[str],
) -> None:
    vectors = reference_vectors()
    path = reference_file(tmp_path, vectors)
    write_machine_file(tmp_path, monkeypatch, tmp_path / "model-cache")
    use_embedder(monkeypatch, ReferenceEmbedder(vectors))
    caplog.set_level(logging.DEBUG)

    main(["embed-check", "--file", str(path), *extra])
    captured = capsys.readouterr()

    for output in (captured.out, captured.err, caplog.text, path.read_text(encoding="utf-8")):
        assert SECRET not in output


def test_cli_reports_an_unreadable_env_file_as_a_usage_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    use_embedder(monkeypatch, ReferenceEmbedder(reference_vectors()))
    code = main(["embed-check", "--env-file", str(tmp_path / "absent.env")])
    assert code == 2
    assert "env file" in capsys.readouterr().err


@pytest.mark.parametrize(
    "bad_vector",
    [[0.1] * (DIMENSIONS - 1), [math.nan] * DIMENSIONS],
    ids=["wrong-width", "nan"],
)
def test_cli_check_fails_with_exit_1_on_a_bad_embedding(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    bad_vector: list[float],
) -> None:
    vectors = reference_vectors()
    path = reference_file(tmp_path, vectors)
    use_embedder(
        monkeypatch, ReferenceEmbedder({**vectors, REFERENCE_TEXTS[BAD_INDEX]: bad_vector})
    )

    assert main(["embed-check", "--file", str(path)]) == 1
    assert f"item {BAD_INDEX}" in capsys.readouterr().err


def test_cli_check_reports_a_bad_reference_vector_as_a_usage_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    payload = raw_payload(reference_vectors())
    payload["items"][BAD_INDEX]["vector"][0] = math.nan
    path = write_json(tmp_path / "refs.json", payload)
    use_embedder(monkeypatch, ReferenceEmbedder(reference_vectors()))

    assert main(["embed-check", "--file", str(path)]) == 2
    assert f"item {BAD_INDEX}" in capsys.readouterr().err


def test_cli_record_with_a_bad_embedding_writes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vectors = reference_vectors()
    broken = {**vectors, REFERENCE_TEXTS[BAD_INDEX]: [math.nan] * DIMENSIONS}
    use_embedder(monkeypatch, ReferenceEmbedder(broken))
    path = tmp_path / "embeddings.json"

    assert main(["embed-check", "--record", "--file", str(path)]) == 1
    assert list(tmp_path.iterdir()) == []


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
    assert references.provenance.model == MODEL
    assert references.provenance.machine == "home-pc"
    assert [item.text for item in references.items] == list(REFERENCE_TEXTS)


def test_the_committed_reference_file_round_trips_byte_for_byte(tmp_path: Path) -> None:
    """The Provenance refactor maps onto the same flat layout the committed file uses."""
    copy = tmp_path / "embeddings.json"
    write_references(load_references(DEFAULT_REFERENCES), copy)
    assert copy.read_bytes() == DEFAULT_REFERENCES.read_bytes()
