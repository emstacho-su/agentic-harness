"""Token counting.

The chunker needs a token count before anything has been embedded, and the tests
must run without downloading a 130 MB ONNX model. So counting is pluggable:

* :class:`HeuristicTokenCounter` — no dependencies, deterministic, used by the
  tests and as the fallback if the real tokenizer cannot be reached.
* :func:`model_token_counter` — the actual WordPiece tokenizer that ships inside
  the fastembed model, so ``token_count`` in the database matches what the model
  really saw.

Both satisfy ``Callable[[str], int]``.
"""

from __future__ import annotations

import logging
import re
from typing import Callable, Protocol

from .config import EMBEDDING, embedding_cache_dir

log = logging.getLogger(__name__)

TokenCounter = Callable[[str], int]

_WORDISH = re.compile(r"\w+|[^\w\s]")


class SupportsEncode(Protocol):  # pragma: no cover - structural typing only
    def encode(self, text: str) -> object: ...


class HeuristicTokenCounter:
    """Approximate a WordPiece count without loading a tokenizer.

    Splits on word/punctuation boundaries, then charges long words extra: BERT
    WordPiece breaks anything past ~6 characters into sub-word pieces. Measured
    against bge-small on this repo's markdown it lands within roughly 10% of the
    true count, and it always errs high — which is the safe direction, because
    over-counting produces slightly small chunks rather than truncated ones.
    """

    __slots__ = ("chars_per_subword",)

    def __init__(self, chars_per_subword: int = 6) -> None:
        if chars_per_subword < 1:
            raise ValueError("chars_per_subword must be >= 1")
        self.chars_per_subword = chars_per_subword

    def __call__(self, text: str) -> int:
        if not text:
            return 0
        total = 0
        for token in _WORDISH.findall(text):
            total += max(1, -(-len(token) // self.chars_per_subword))
        return total


_AUTOLOAD = object()


def model_token_counter(tokenizer: SupportsEncode | None = _AUTOLOAD) -> TokenCounter:
    """Return a counter backed by the real model tokenizer.

    Falls back to the heuristic — with a warning, never silently — if the
    tokenizer cannot be obtained.

    ``tokenizer`` is injectable. Passing ``None`` explicitly means "there is no
    tokenizer, use the heuristic"; omitting it asks fastembed for one, which can
    trigger a model download, so tests always pass it.
    """
    tok = _load_model_tokenizer() if tokenizer is _AUTOLOAD else tokenizer
    if tok is None:
        log.warning(
            "Falling back to heuristic token counts: could not reach the %s "
            "tokenizer. token_count values will be approximate.",
            EMBEDDING.model_name,
        )
        return HeuristicTokenCounter()

    def count(text: str) -> int:
        if not text:
            return 0
        encoded = tok.encode(text)
        ids = getattr(encoded, "ids", None)
        if ids is None:
            raise TypeError(
                "tokenizer.encode() returned an object without .ids: "
                f"{type(encoded).__name__}"
            )
        return len(ids)

    return count


def _load_model_tokenizer() -> SupportsEncode | None:
    """Dig the WordPiece tokenizer out of fastembed.

    fastembed does not expose this on a public API, and the attribute path has
    moved between releases, so every step is probed defensively and any failure
    degrades to the heuristic rather than aborting an ingest run.
    """
    try:
        from fastembed import TextEmbedding
    except ImportError as exc:
        log.warning("fastembed is not importable (%s)", exc)
        return None

    try:
        embedder = TextEmbedding(
            model_name=EMBEDDING.model_name, cache_dir=embedding_cache_dir()
        )
    except Exception as exc:  # noqa: BLE001 - reported, then degraded
        log.warning("Could not construct TextEmbedding: %s", exc)
        return None

    return tokenizer_from_embedder(embedder)


def tokenizer_from_embedder(embedder: object) -> SupportsEncode | None:
    """Probe the known attribute paths for fastembed's internal tokenizer."""
    candidates = (
        ("tokenizer",),
        ("model", "tokenizer"),
        ("model", "model", "tokenizer"),
    )
    for path in candidates:
        current: object | None = embedder
        for attr in path:
            current = getattr(current, attr, None)
            if current is None:
                break
        if current is not None and hasattr(current, "encode"):
            return current  # type: ignore[return-value]
    log.warning("fastembed exposed no .tokenizer on any known attribute path")
    return None
