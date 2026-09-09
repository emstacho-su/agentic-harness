"""Orphan sweep.

After a *complete* ingest of one source, any ``external_id`` still in
``rag.documents`` that the loader did not produce is an orphan — a deleted note,
or a note renamed while it had no stable frontmatter ``id:``.

This is the only destructive operation in the package, so it is off by default
and refuses to run unless the sweep can be trusted:

* the run must have been a full pass — ``--limit`` truncates the seen set, so a
  sweep after one would delete most of the corpus;
* no document may have failed — a failure means the seen set is incomplete;
* the loader must have produced something — an empty vault (a mistyped path, an
  unmounted OneDrive folder) would otherwise wipe the source.

Each guard reports why it declined. Nothing is ever deleted silently.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Iterable

from .store import ChunkStore

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class PruneResult:
    """What the sweep found and whether it acted."""

    source: str
    orphans: tuple[str, ...] = ()
    deleted: int = 0
    performed: bool = False
    declined_reason: str | None = None

    @property
    def declined(self) -> bool:
        return self.declined_reason is not None


def prune_orphans(
    store: ChunkStore,
    source: str,
    seen_external_ids: Iterable[str],
    *,
    dry_run: bool = False,
    document_count: int = 0,
    failure_count: int = 0,
    limited: bool = False,
) -> PruneResult:
    """Delete documents of ``source`` whose ``external_id`` was not seen."""
    declined = _decline_reason(document_count, failure_count, limited)
    if declined:
        log.warning("Skipping orphan sweep for %s: %s", source, declined)
        return PruneResult(source=source, declined_reason=declined)

    seen = {str(value) for value in seen_external_ids}
    existing = store.list_external_ids(source)
    orphans = tuple(sorted(existing - seen))

    if not orphans:
        return PruneResult(source=source, performed=not dry_run)
    if dry_run:
        return PruneResult(source=source, orphans=orphans, performed=False)

    deleted = store.delete_documents(source, orphans)
    log.info("Orphan sweep removed %d document(s) from %s", deleted, source)
    return PruneResult(source=source, orphans=orphans, deleted=deleted, performed=True)


def _decline_reason(document_count: int, failure_count: int, limited: bool) -> str | None:
    if limited:
        return "--limit was used, so the seen set is not a complete pass"
    if failure_count:
        return f"{failure_count} document(s) failed, so the seen set is incomplete"
    if document_count == 0:
        return "the loader produced no documents; refusing to empty the source"
    return None
