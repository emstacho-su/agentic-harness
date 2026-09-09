"""The one pipeline both loaders feed.

hash -> skip-if-unchanged -> chunk -> embed -> transactional upsert

Change detection happens before chunking and embedding, so a re-run over an
unchanged corpus does no model work and issues no writes at all.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Iterable

from .chunking import MarkdownChunker
from .embedding import Embedder
from .errors import IngestError
from .hashing import content_hash as compute_hash
from .models import SourceDocument
from .store import ChunkStore

log = logging.getLogger(__name__)


class Action(str, Enum):
    INSERTED = "inserted"
    UPDATED = "updated"
    UNCHANGED = "unchanged"
    PLANNED_NEW = "would-insert"
    PLANNED_CHANGED = "would-update"
    FAILED = "failed"


@dataclass(frozen=True)
class DocumentOutcome:
    external_id: str
    action: Action
    chunk_count: int = 0
    detail: str | None = None


@dataclass
class IngestStats:
    """Run accumulator. Mutable by design — it is a counter, not domain data."""

    outcomes: list[DocumentOutcome] = field(default_factory=list)

    def record(self, outcome: DocumentOutcome) -> None:
        self.outcomes.append(outcome)

    def count(self, action: Action) -> int:
        return sum(1 for o in self.outcomes if o.action is action)

    @property
    def total(self) -> int:
        return len(self.outcomes)

    @property
    def chunks_written(self) -> int:
        writing = (Action.INSERTED, Action.UPDATED)
        return sum(o.chunk_count for o in self.outcomes if o.action in writing)

    @property
    def chunks_planned(self) -> int:
        planned = (Action.PLANNED_NEW, Action.PLANNED_CHANGED)
        return sum(o.chunk_count for o in self.outcomes if o.action in planned)

    @property
    def failures(self) -> list[DocumentOutcome]:
        return [o for o in self.outcomes if o.action is Action.FAILED]

    def summary(self) -> dict[str, int]:
        return {action.value: self.count(action) for action in Action}


class IngestPipeline:
    """Chunk, embed and store documents from any loader."""

    def __init__(
        self,
        store: ChunkStore,
        embedder: Embedder | None,
        chunker: MarkdownChunker | None = None,
        *,
        dry_run: bool = False,
        force: bool = False,
    ) -> None:
        if not dry_run and embedder is None:
            raise ValueError("a real run needs an embedder; pass dry_run=True instead")
        self.store = store
        self.embedder = embedder
        self.chunker = chunker or MarkdownChunker()
        self.dry_run = dry_run
        self.force = force

    def run(self, documents: Iterable[SourceDocument]) -> IngestStats:
        stats = IngestStats()
        for document in documents:
            try:
                stats.record(self._process(document))
            except IngestError as exc:
                log.error("%s failed: %s", document.external_id, exc)
                stats.record(
                    DocumentOutcome(document.external_id, Action.FAILED, detail=str(exc))
                )
            except Exception as exc:  # noqa: BLE001 - counted, never swallowed
                log.exception("%s failed unexpectedly", document.external_id)
                stats.record(
                    DocumentOutcome(
                        document.external_id,
                        Action.FAILED,
                        detail=f"{type(exc).__name__}: {exc}",
                    )
                )
        return stats

    # -- per document ------------------------------------------------------

    def _process(self, document: SourceDocument) -> DocumentOutcome:
        digest = compute_hash(document.body)
        state = self.store.get_document_state(document.source, document.external_id)
        is_new = state is None

        if state is not None and state.content_hash == digest and not self.force:
            log.debug("%s unchanged, skipping", document.external_id)
            return DocumentOutcome(document.external_id, Action.UNCHANGED)

        chunks = self.chunker.chunk(document.body, title=document.title)
        if not chunks:
            raise IngestError(
                f"{document.external_id}: chunker produced nothing from a "
                f"{len(document.body)}-character body"
            )

        if self.dry_run:
            action = Action.PLANNED_NEW if is_new else Action.PLANNED_CHANGED
            return DocumentOutcome(document.external_id, action, len(chunks))

        assert self.embedder is not None  # guaranteed by __init__
        embeddings = self.embedder.embed([chunk.content for chunk in chunks])
        _, inserted = self.store.replace_document(
            document, digest, chunks, embeddings
        )
        return DocumentOutcome(
            document.external_id,
            Action.INSERTED if inserted else Action.UPDATED,
            len(chunks),
        )
