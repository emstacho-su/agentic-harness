"""Plain data carried between loader -> chunker -> embedder -> store.

All of these are frozen. Nothing in the pipeline mutates a document in place;
transformations return new objects.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from .errors import DocumentError


@dataclass(frozen=True)
class SourceDocument:
    """One row destined for ``rag.documents``, before hashing or chunking."""

    source: str
    external_id: str
    body: str
    title: str | None = None
    agent: str | None = None
    # Project or class this document belongs to ('ev-trainer', 'IST335').
    # Mirrors the vault folder structure; exposed as filter_collection on rag.search.
    collection: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # Validate at the boundary: a loader bug must not reach the database.
        if not self.source or not self.source.strip():
            raise DocumentError(self.external_id or "<unknown>", "source is empty")
        if not self.external_id or not self.external_id.strip():
            raise DocumentError("<unknown>", "external_id is empty")
        if not self.body or not self.body.strip():
            raise DocumentError(self.external_id, "body is empty")
        if not isinstance(self.metadata, dict):
            raise DocumentError(self.external_id, "metadata must be a dict")

    def with_metadata(self, **extra: Any) -> "SourceDocument":
        return replace(self, metadata={**self.metadata, **extra})


@dataclass(frozen=True)
class Chunk:
    """One row destined for ``rag.chunks``."""

    chunk_index: int
    content: str
    token_count: int


@dataclass(frozen=True)
class DocumentState:
    """What the store already knows about a ``(source, external_id)`` pair."""

    document_id: int
    content_hash: str


@dataclass(frozen=True)
class PreparedDocument:
    """A document that has been hashed and chunked, ready to embed and write."""

    document: SourceDocument
    content_hash: str
    chunks: tuple[Chunk, ...]
