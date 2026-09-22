"""The orphan sweep — the only destructive operation, so guard it hard."""

from __future__ import annotations

import pytest

from ingest.chunking import MarkdownChunker
from ingest.config import ChunkConfig
from ingest.models import SourceDocument
from ingest.pipeline import IngestPipeline
from ingest.prune import prune_orphans
from ingest.store import NullStore

SMALL = ChunkConfig(target_tokens=40, overlap_tokens=8, min_tokens=5, hard_max_tokens=80)


def document(external_id: str) -> SourceDocument:
    return SourceDocument(
        source="obsidian",
        external_id=external_id,
        body=f"Body for {external_id}, with enough words to make a chunk.",
        title=external_id,
        agent="claude-code",
    )


def ingest(store, embedder, docs):
    pipeline = IngestPipeline(
        store, embedder, MarkdownChunker(count_tokens=lambda t: len(t.split()), config=SMALL)
    )
    return pipeline.run(docs)


# --------------------------------------------------------------------------


def test_sweep_deletes_only_documents_the_loader_no_longer_produces(
    fake_store, fake_embedder
):
    ingest(fake_store, fake_embedder, [document("a.md"), document("b.md"), document("c.md")])
    survivors = [document("a.md"), document("c.md")]
    stats = ingest(fake_store, fake_embedder, survivors)

    result = prune_orphans(
        fake_store,
        "obsidian",
        [doc.external_id for doc in survivors],
        document_count=len(survivors),
        failure_count=len(stats.failures),
    )

    assert result.performed
    assert result.orphans == ("b.md",)
    assert result.deleted == 1
    assert fake_store.list_external_ids("obsidian") == {"a.md", "c.md"}


def test_sweep_removes_the_orphans_chunks_too(fake_store, fake_embedder):
    ingest(fake_store, fake_embedder, [document("a.md"), document("b.md")])
    before = fake_store.total_chunks
    prune_orphans(fake_store, "obsidian", ["a.md"], document_count=1)
    assert fake_store.total_chunks < before


def test_sweep_never_touches_another_source(fake_store, fake_embedder):
    other = SourceDocument(
        source="claude-mem", external_id="1", body="Some narrative body text here.", agent="x"
    )
    ingest(fake_store, fake_embedder, [document("a.md"), other])
    prune_orphans(fake_store, "obsidian", [], document_count=1)
    assert fake_store.list_external_ids("claude-mem") == {"1"}


def test_nothing_stale_is_reported_as_a_clean_sweep(fake_store, fake_embedder):
    docs = [document("a.md")]
    ingest(fake_store, fake_embedder, docs)
    result = prune_orphans(fake_store, "obsidian", ["a.md"], document_count=1)
    assert result.orphans == ()
    assert result.performed
    assert result.deleted == 0


# --------------------------------------------------------------------------
# guards
# --------------------------------------------------------------------------


def test_sweep_declines_after_a_limited_run(fake_store, fake_embedder):
    ingest(fake_store, fake_embedder, [document("a.md"), document("b.md")])
    result = prune_orphans(fake_store, "obsidian", ["a.md"], document_count=1, limited=True)

    assert result.declined
    assert "--limit" in result.declined_reason
    assert fake_store.list_external_ids("obsidian") == {"a.md", "b.md"}


def test_sweep_declines_when_a_document_failed(fake_store, fake_embedder):
    ingest(fake_store, fake_embedder, [document("a.md"), document("b.md")])
    result = prune_orphans(
        fake_store, "obsidian", ["a.md"], document_count=2, failure_count=1
    )

    assert result.declined
    assert "failed" in result.declined_reason
    assert fake_store.list_external_ids("obsidian") == {"a.md", "b.md"}


def test_sweep_declines_on_an_empty_loader_result(fake_store, fake_embedder):
    """A mistyped path or an unmounted vault must not empty the source."""
    ingest(fake_store, fake_embedder, [document("a.md"), document("b.md")])
    result = prune_orphans(fake_store, "obsidian", [], document_count=0)

    assert result.declined
    assert "no documents" in result.declined_reason
    assert fake_store.list_external_ids("obsidian") == {"a.md", "b.md"}


def test_dry_run_reports_orphans_without_deleting(fake_store, fake_embedder):
    ingest(fake_store, fake_embedder, [document("a.md"), document("b.md")])
    result = prune_orphans(
        fake_store, "obsidian", ["a.md"], document_count=1, dry_run=True
    )

    assert result.orphans == ("b.md",)
    assert result.performed is False
    assert result.deleted == 0
    assert fake_store.list_external_ids("obsidian") == {"a.md", "b.md"}


def test_null_store_refuses_to_delete():
    from ingest.errors import StoreError

    with pytest.raises(StoreError):
        NullStore().delete_documents("obsidian", ["a.md"])


# --------------------------------------------------------------------------
# realms: two vaults, one store
# --------------------------------------------------------------------------


def realm_document(external_id: str, realm: str | None) -> SourceDocument:
    ingest_meta = {"loader": "obsidian", "path": external_id}
    if realm is not None:
        ingest_meta["realm"] = realm
    return SourceDocument(
        source="obsidian",
        external_id=external_id,
        body=f"Body for {external_id}, with enough words to make a chunk.",
        title=external_id,
        agent="claude-code",
        metadata={"_ingest": ingest_meta},
    )


def test_sweep_never_touches_another_realm(fake_store, fake_embedder):
    # Machine A walked `projects`; machine B's `work-vm` rows are not orphans.
    ingest(fake_store, fake_embedder, [realm_document("projects/a.md", "projects"), realm_document("work-vm/b.md", "work-vm")])
    result = prune_orphans(fake_store, "obsidian", [], document_count=1, realm="projects")
    assert result.realm == "projects"
    assert result.orphans == ("projects/a.md",)
    assert fake_store.list_external_ids("obsidian", realm="work-vm") == {"work-vm/b.md"}


def test_a_realm_this_machine_did_not_walk_is_never_listed(fake_store):
    assert fake_store.list_external_ids("obsidian", realm="work-vm") == set()
    assert fake_store.delete_documents("obsidian", ["work-vm/b.md"], realm="work-vm") == 0


def test_realm_none_means_legacy_rows_only(fake_store, fake_embedder):
    # Rows ingested before realms existed carry no `_ingest.realm`. They are the
    # only rows a realm-less sweep may see, and only behind the explicit flag.
    ingest(fake_store, fake_embedder, [realm_document("old.md", None), realm_document("projects/a.md", "projects")])
    assert fake_store.list_external_ids("obsidian", realm=None) == {"old.md"}
    result = prune_orphans(fake_store, "obsidian", ["projects/a.md"], document_count=1, realm=None)
    assert result.orphans == ("old.md",)
    assert fake_store.list_external_ids("obsidian", realm=None) == set()
    assert fake_store.list_external_ids("obsidian", realm="projects") == {"projects/a.md"}
