"""Embedding backend.

fastembed downloads the ONNX weights once (~130 MB) into its cache and then runs
entirely offline on CPU. The model is loaded lazily so that ``--dry-run``, the
CLI's argument validation and the whole test suite never pay for it.
"""

from __future__ import annotations

import logging
from typing import Iterable, Protocol, Sequence

from .config import EMBEDDING, EmbeddingConfig, embedding_cache_dir
from .errors import EmbeddingError

log = logging.getLogger(__name__)


class Embedder(Protocol):
    """What the pipeline needs from an embedding backend."""

    @property
    def dimensions(self) -> int: ...

    def embed(self, texts: Sequence[str]) -> list[list[float]]: ...


class FastEmbedEmbedder:
    """:class:`Embedder` backed by fastembed + ONNX Runtime."""

    def __init__(
        self,
        config: EmbeddingConfig = EMBEDDING,
        cache_dir: str | None = None,
        batch_size: int = 32,
    ) -> None:
        if batch_size < 1:
            raise ValueError("batch_size must be >= 1")
        self.config = config
        self.cache_dir = cache_dir or embedding_cache_dir()
        self.batch_size = batch_size
        self._model = None

    @property
    def dimensions(self) -> int:
        return self.config.dimensions

    @property
    def model(self):
        """Load the model on first use, converting any failure into IngestError."""
        if self._model is None:
            try:
                from fastembed import TextEmbedding
            except ImportError as exc:  # pragma: no cover - install-time problem
                raise EmbeddingError(
                    "fastembed is not installed. Run `uv sync` in ingest/."
                ) from exc

            log.info(
                "Loading %s (first run downloads the model, then it is offline)",
                self.config.model_name,
            )
            try:
                self._model = TextEmbedding(
                    model_name=self.config.model_name,
                    cache_dir=self.cache_dir,
                )
            except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
                raise EmbeddingError(
                    f"Could not load embedding model {self.config.model_name}: {exc}"
                ) from exc
        return self._model

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        for index, text in enumerate(texts):
            if not isinstance(text, str) or not text.strip():
                raise EmbeddingError(f"text at index {index} is empty or not a str")

        try:
            raw: Iterable = self.model.embed(list(texts), batch_size=self.batch_size)
            vectors = [list(map(float, vector)) for vector in raw]
        except EmbeddingError:
            raise
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            raise EmbeddingError(f"Embedding failed: {exc}") from exc

        self._validate(vectors, len(texts))
        return vectors

    def _validate(self, vectors: list[list[float]], expected: int) -> None:
        if len(vectors) != expected:
            raise EmbeddingError(
                f"Embedder returned {len(vectors)} vectors for {expected} texts"
            )
        for index, vector in enumerate(vectors):
            if len(vector) != self.config.dimensions:
                raise EmbeddingError(
                    f"Vector {index} has {len(vector)} dimensions, expected "
                    f"{self.config.dimensions}. The `rag.chunks.embedding` column "
                    f"is fixed at {self.config.dimensions} — changing the model "
                    "means an ALTER on that column plus a full re-embed."
                )


def vector_literal(vector: Sequence[float]) -> str:
    """Render a vector as the pgvector text literal ``[0.1,0.2,...]``.

    Avoids a runtime dependency on the ``pgvector`` Python package: the insert
    casts this string to ``extensions.vector`` in SQL.
    """
    return "[" + ",".join(repr(float(value)) for value in vector) + "]"
