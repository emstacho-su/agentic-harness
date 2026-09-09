"""Shared loader types.

A loader turns one source of truth into :class:`SourceDocument` objects. It does
no chunking, no embedding and no database work — that is the pipeline's job, and
keeping it there is what lets both sources share one code path.

Loaders report what they deliberately skipped. Skips are counted and shown, never
hidden.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..models import SourceDocument


@dataclass(frozen=True)
class SkippedRecord:
    external_id: str
    reason: str


@dataclass(frozen=True)
class LoadedSource:
    """Everything a loader produced, plus what it left behind and why."""

    documents: tuple[SourceDocument, ...] = ()
    skipped: tuple[SkippedRecord, ...] = ()
    notes: tuple[str, ...] = field(default=())

    def skip_reasons(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for record in self.skipped:
            counts[record.reason] = counts.get(record.reason, 0) + 1
        return counts

    def merge(self, other: "LoadedSource") -> "LoadedSource":
        return LoadedSource(
            documents=self.documents + other.documents,
            skipped=self.skipped + other.skipped,
            notes=self.notes + other.notes,
        )
