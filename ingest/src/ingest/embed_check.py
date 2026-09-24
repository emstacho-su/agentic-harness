"""``uv run ingest embed-check`` — does this machine embed the way the references say?

    uv run ingest embed-check                    # compare against ingest/eval/embeddings.json
    uv run ingest embed-check --json
    uv run ingest embed-check --threshold 0.9995
    uv run ingest embed-check --record [--force] # re-record the references on this machine

Ten fixed texts and their vectors are committed in ``ingest/eval/embeddings.json``.
The check embeds the same texts here and compares each pair by cosine. Run it on
every new machine before its first ingest (R-D2). It never touches the database.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import numbers
import os
import re
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib import metadata
from pathlib import Path
from typing import NamedTuple

import numpy as np

from .embedding import Embedder, FastEmbedEmbedder
from .errors import ConfigError, EmbeddingError, IngestError

log = logging.getLogger(__name__)

SUBCOMMAND = "embed-check"

# ingest/eval/embeddings.json, beside src/.
DEFAULT_REFERENCES = Path(__file__).resolve().parents[2] / "eval" / "embeddings.json"

# Same model on a different CPU drifts in the last digits (ORT #5667), which is
# harmless for cosine ranking and scores well above 0.999. A saturating kernel or
# an int8 quantization bug (ORT #14642) moves vectors far more than that, and only
# a check against recorded vectors tells the two apart.
COSINE_THRESHOLD = 0.999

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2

# Width of the text column in the per-item report.
DISPLAY_WIDTH = 60
ELLIPSIS = "…"

# The recording machine's label. Unset means "unknown": the hostname is never
# written into a committed file.
ENV_MACHINE = "HARNESS_MACHINE"
UNKNOWN = "unknown"
MACHINE_LABEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

# The two packages whose versions decide the numbers; recorded with the vectors.
FASTEMBED_PACKAGE = "fastembed"
ONNXRUNTIME_PACKAGE = "onnxruntime"

# Short English lines that between them exercise what the vault feeds the model:
# prose, a query, code, non-ASCII, a fragment, a long paragraph, markdown, links
# and numbers. Changing any of them means re-recording the reference file.
REFERENCE_TEXTS: tuple[str, ...] = (
    (
        "Session outcome: moved the nightly reconcile to 02:30 and added a lock so the "
        "sync and the collector never overlap."
    ),
    (
        "IST 323 lecture notes: a primary key uniquely identifies each row, and a foreign "
        "key points at a primary key in another table."
    ),
    "how did we decide which machine is allowed to sweep the legacy rows?",
    "def cosine(a, b): return dot(a, b) / (norm(a) * norm(b))  # guard zero norms",
    "The café's naïve résumé parser — written in a hurry — broke on accented names.",
    "ok",
    (
        "Same model, different CPU: the reference vectors were recorded on the home PC, and "
        "every new machine embeds the same ten texts before its first ingest. Differences "
        "in the last digit are harmless for ranking, because the cosine barely moves. A "
        "kernel that saturates or a quantization bug would move it a lot, and only a check "
        "tells the two apart."
    ),
    "## Decisions (Stack, 2026-09-22)",
    (
        "See [[portable-harness]] and [[vault-graph-links|the graph links note]] for the "
        "realm layout."
    ),
    "Backups ran at 03:15 on 2026-09-23: 1,284 notes, 18,407 chunks, 412.6 MB, exit code 0.",
)


class Reference(NamedTuple):
    text: str
    vector: tuple[float, ...]


@dataclass(frozen=True)
class Provenance:
    """Where and with what a set of reference vectors was produced."""

    model: str
    fastembed: str
    onnxruntime: str
    machine: str
    recorded_at: str


@dataclass(frozen=True)
class References:
    model: str
    dimensions: int
    fastembed: str
    onnxruntime: str
    machine: str
    recorded_at: str
    items: tuple[Reference, ...]


class Score(NamedTuple):
    text: str
    cosine: float


@dataclass(frozen=True)
class CheckResult:
    ok: bool
    worst: Score
    scores: tuple[Score, ...]


# -- the reference file ------------------------------------------------------------


def load_references(path: Path | str) -> References:
    """Read and validate a reference file. Any defect is a :class:`ConfigError`."""
    source = Path(path)
    try:
        raw = source.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ConfigError(f"reference file not found: {source}") from exc
    except OSError as exc:
        raise ConfigError(f"cannot read reference file {source}: {exc}") from exc
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{source}: not valid JSON ({exc})") from exc
    return _parse(payload, str(source))


def write_references(references: References, path: Path | str, *, overwrite: bool = False) -> None:
    """Write the file, one item per line, floats at full (repr) precision."""
    target = Path(path)
    if target.exists() and not overwrite:
        raise ConfigError(f"{target} already exists; refusing to overwrite it")
    staging = target.with_name(target.name + ".tmp")
    try:
        staging.write_text(_serialise(references), encoding="utf-8", newline="\n")
        os.replace(staging, target)
    except OSError as exc:
        raise IngestError(f"cannot write reference file {target}: {exc}") from exc


def record(texts: Sequence[str], embedder: Embedder, meta: Provenance) -> References:
    """Embed ``texts`` and package the vectors with their provenance."""
    if not texts:
        raise ConfigError("no texts to record")
    vectors = embedder.embed(list(texts))
    if len(vectors) != len(texts):
        raise EmbeddingError(f"embedder returned {len(vectors)} vectors for {len(texts)} texts")
    items = tuple(
        Reference(_checked_text(text, f"item {index}"),
                  _checked_vector(vector, embedder.dimensions, f"item {index}"))
        for index, (text, vector) in enumerate(zip(texts, vectors, strict=True))
    )
    _reject_duplicates(items, "recorded references")
    return References(
        model=meta.model,
        dimensions=embedder.dimensions,
        fastembed=meta.fastembed,
        onnxruntime=meta.onnxruntime,
        machine=meta.machine,
        recorded_at=meta.recorded_at,
        items=items,
    )


# -- scoring -----------------------------------------------------------------------


def cosine(left: Sequence[float], right: Sequence[float]) -> float:
    """Cosine similarity; 0.0 when either vector has zero norm."""
    a = np.asarray(left, dtype=np.float64)
    b = np.asarray(right, dtype=np.float64)
    if a.shape != b.shape:
        raise ValueError(f"cannot compare vectors of shape {a.shape} and {b.shape}")
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denominator == 0.0:
        return 0.0
    return float(np.dot(a, b) / denominator)


def score(references: References, embedder: Embedder) -> tuple[Score, ...]:
    """Embed every reference text in one call and score it against its vector."""
    texts = [item.text for item in references.items]
    vectors = embedder.embed(texts)
    if len(vectors) != len(texts):
        raise EmbeddingError(f"embedder returned {len(vectors)} vectors for {len(texts)} texts")
    return tuple(
        Score(item.text, cosine(item.vector, _checked_vector(
            vector, references.dimensions, f"embedding of item {index}")))
        for index, (item, vector) in enumerate(zip(references.items, vectors, strict=True))
    )


def threshold_problem(threshold: float) -> str | None:
    """Why ``threshold`` is unusable, or None. NaN fails the comparison too."""
    if 0.0 < threshold <= 1.0:
        return None
    return f"threshold must be in (0, 1], got {threshold}"


def check(references: References, embedder: Embedder, threshold: float = COSINE_THRESHOLD) -> CheckResult:
    """Pass only when every item's cosine reaches ``threshold``."""
    problem = threshold_problem(threshold)
    if problem:
        raise ConfigError(problem)
    scores = score(references, embedder)
    worst = min(scores, key=lambda s: s.cosine)
    return CheckResult(ok=worst.cosine >= threshold, worst=worst, scores=scores)


# -- the command line -------------------------------------------------------------


def build_embedder() -> Embedder:
    """The live embedder. Tests replace this function."""
    return FastEmbedEmbedder()


def embedder_model_name(embedder: object) -> str | None:
    """The model an embedder runs, read without loading it; None when it does not say."""
    config = getattr(embedder, "config", None)
    name = getattr(config, "model_name", None) or getattr(embedder, "model_name", None)
    return name if isinstance(name, str) and name else None


def current_provenance(model: str) -> Provenance:
    return Provenance(
        model=model,
        fastembed=_package_version(FASTEMBED_PACKAGE),
        onnxruntime=_package_version(ONNXRUNTIME_PACKAGE),
        machine=_machine_label(),
        recorded_at=datetime.now(UTC).isoformat(timespec="seconds"),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=f"ingest {SUBCOMMAND}",
        description="Compare this machine's embeddings of ten fixed texts with the committed references.",
    )
    parser.add_argument("--file", default=str(DEFAULT_REFERENCES), help="reference file (JSON)")
    parser.add_argument(
        "--threshold",
        type=float,
        default=None,
        help=f"minimum cosine per item (default {COSINE_THRESHOLD})",
    )
    parser.add_argument("--json", action="store_true", help="machine-readable result on stdout")
    parser.add_argument("--record", action="store_true", help="embed the built-in texts and write the file")
    parser.add_argument("--force", action="store_true", help="with --record: replace an existing file")
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return parser


def run_embed_check(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    refusal = _refuse_bad_combination(args)
    if refusal:
        print(f"error: {refusal}", file=sys.stderr)
        return EXIT_USAGE
    try:
        return _run_record(args) if args.record else _run_check(args)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_FAIL


def _refuse_bad_combination(args: argparse.Namespace) -> str | None:
    if args.force and not args.record:
        return "--force applies to --record only"
    if args.record and (args.json or args.threshold is not None):
        return "--record writes the file; --json and --threshold apply to a check"
    if args.threshold is not None:
        return threshold_problem(args.threshold)
    return None


def _run_check(args: argparse.Namespace) -> int:
    threshold = COSINE_THRESHOLD if args.threshold is None else args.threshold
    references = load_references(args.file)
    embedder = build_embedder()
    mismatch = _mismatch(references, embedder)
    if mismatch:
        print(f"error: {mismatch}", file=sys.stderr)
        return EXIT_USAGE
    log.info(
        "references from machine %s (fastembed %s, onnxruntime %s, %s)",
        references.machine, references.fastembed, references.onnxruntime, references.recorded_at,
    )
    result = check(references, embedder, threshold)
    if args.json:
        print(json.dumps(_as_json(result, threshold), indent=2))
    else:
        print(_as_text(result, threshold))
    return EXIT_OK if result.ok else EXIT_FAIL


def _run_record(args: argparse.Namespace) -> int:
    target = Path(args.file)
    if target.exists() and not args.force:
        print(f"error: {target} exists; pass --force to replace it", file=sys.stderr)
        return EXIT_USAGE
    embedder = build_embedder()
    model = embedder_model_name(embedder)
    if model is None:
        print("error: the embedder does not report its model name", file=sys.stderr)
        return EXIT_USAGE
    references = record(REFERENCE_TEXTS, embedder, current_provenance(model))
    write_references(references, target, overwrite=args.force)
    print(f"recorded {len(references.items)} references to {target}")
    return EXIT_OK


def _mismatch(references: References, embedder: Embedder) -> str | None:
    """A reference file for another model or width cannot be checked, only refused."""
    model = embedder_model_name(embedder)
    if model is None:
        return "the embedder does not report its model name"
    if model != references.model:
        return f"the reference file is for model {references.model}; this embedder runs {model}"
    if embedder.dimensions != references.dimensions:
        return (
            f"the reference file has {references.dimensions} dimensions; "
            f"this embedder produces {embedder.dimensions}"
        )
    return None


def _as_json(result: CheckResult, threshold: float) -> dict[str, object]:
    return {
        "ok": result.ok,
        "threshold": threshold,
        "worst": {"text": result.worst.text, "cosine": result.worst.cosine},
        "scores": [{"text": s.text, "cosine": s.cosine} for s in result.scores],
    }


def _as_text(result: CheckResult, threshold: float) -> str:
    lines = [f"  {s.cosine:.6f}  {_display(s.text)}" for s in result.scores]
    worst = f'worst {result.worst.cosine:.5f} on "{_display(result.worst.text)}"'
    if result.ok:
        lines.append(f"embed-check: pass ({worst})")
    else:
        lines.append(f"embed-check: FAIL ({worst}; threshold {threshold:g})")
    return "\n".join(lines)


def _display(text: str) -> str:
    flat = " ".join(text.split())
    if len(flat) <= DISPLAY_WIDTH:
        return flat
    return flat[: DISPLAY_WIDTH - len(ELLIPSIS)] + ELLIPSIS


def _package_version(package: str) -> str:
    try:
        return metadata.version(package)
    except metadata.PackageNotFoundError:
        log.warning("%s is not installed; recording its version as %s", package, UNKNOWN)
        return UNKNOWN


def _machine_label() -> str:
    value = os.environ.get(ENV_MACHINE, "").strip()
    if not value:
        return UNKNOWN
    if not MACHINE_LABEL.match(value):
        raise ConfigError(
            f"{ENV_MACHINE}={value!r} is not a plain label (letters, digits, '.', '_', '-'; 64 max)"
        )
    return value


# -- parsing and serialising --------------------------------------------------------

_PROVENANCE_FIELDS = ("fastembed", "onnxruntime", "machine", "recorded_at")


def _parse(payload: object, where: str) -> References:
    if not isinstance(payload, dict):
        raise ConfigError(f"{where}: the top level must be a JSON object")
    model = payload.get("model")
    if not isinstance(model, str) or not model.strip():
        raise ConfigError(f"{where}: 'model' must be a non-empty string")
    dimensions = payload.get("dimensions")
    if isinstance(dimensions, bool) or not isinstance(dimensions, int) or dimensions < 1:
        raise ConfigError(f"{where}: 'dimensions' must be a positive integer, got {dimensions!r}")
    provenance = {name: payload.get(name) for name in _PROVENANCE_FIELDS}
    for name, value in provenance.items():
        if not isinstance(value, str) or not value.strip():
            raise ConfigError(f"{where}: '{name}' must be a non-empty string")
    raw_items = payload.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise ConfigError(f"{where}: 'items' must be a non-empty list")
    items = tuple(_parse_item(raw, index, dimensions, where) for index, raw in enumerate(raw_items))
    _reject_duplicates(items, where)
    return References(model=model, dimensions=dimensions, items=items, **provenance)


def _parse_item(raw: object, index: int, dimensions: int, where: str) -> Reference:
    label = f"{where}: item {index}"
    if not isinstance(raw, dict):
        raise ConfigError(f"{label}: must be an object with 'text' and 'vector'")
    return Reference(_checked_text(raw.get("text"), label),
                     _checked_vector(raw.get("vector"), dimensions, label))


def _checked_text(text: object, label: str) -> str:
    if not isinstance(text, str) or not text.strip():
        raise ConfigError(f"{label}: 'text' must be a non-empty string")
    return text


def _checked_vector(values: object, dimensions: int, label: str) -> tuple[float, ...]:
    if not isinstance(values, (list, tuple)):
        raise ConfigError(f"{label}: 'vector' must be a list of numbers")
    if len(values) != dimensions:
        raise ConfigError(f"{label}: vector has {len(values)} values, expected {dimensions}")
    for position, value in enumerate(values):
        finite = (
            isinstance(value, numbers.Real)
            and not isinstance(value, bool)
            and math.isfinite(value)
        )
        if not finite:
            raise ConfigError(f"{label}: vector[{position}] is {value!r}, not a finite number")
    return tuple(float(value) for value in values)


def _reject_duplicates(items: tuple[Reference, ...], where: str) -> None:
    first_seen: dict[str, int] = {}
    for index, item in enumerate(items):
        if item.text in first_seen:
            raise ConfigError(
                f"{where}: item {index} duplicates the text of item {first_seen[item.text]}"
            )
        first_seen[item.text] = index


def _serialise(references: References) -> str:
    header = {
        "model": references.model,
        "dimensions": references.dimensions,
        "fastembed": references.fastembed,
        "onnxruntime": references.onnxruntime,
        "machine": references.machine,
        "recorded_at": references.recorded_at,
    }
    lines = ["{"]
    lines.extend(f"  {json.dumps(key)}: {json.dumps(value, ensure_ascii=False)}," for key, value in header.items())
    lines.append('  "items": [')
    # json.dumps writes each float with repr(), so a load returns the same bits.
    item_lines = [
        "    " + json.dumps(
            {"text": item.text, "vector": list(item.vector)}, ensure_ascii=False, allow_nan=False
        )
        for item in references.items
    ]
    lines.append(",\n".join(item_lines))
    lines.extend(["  ]", "}"])
    return "\n".join(lines) + "\n"
