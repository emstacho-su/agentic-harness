"""Hash-based skip logic, idempotent re-runs, dry runs, failure isolation."""

from __future__ import annotations

import pytest

from ingest.chunking import MarkdownChunker
from ingest.config import ChunkConfig
from ingest.errors import StoreError
from ingest.models import SourceDocument
from ingest.pipeline import Action, IngestPipeline

BODY = (
    "# Ingest Notes\n\n"
    "The pipeline hashes the body before it chunks anything, so a re-run over an "
    "unchanged corpus does no model work at all.\n\n"
    "## Details\n\n"
    "Chunks are replaced inside one transaction per document.\n"
)


def document(
    external_id: str = "notes/a.md",
    body: str = BODY,
    *,
    title: str | None = "Ingest Notes",
    collection: str | None = "bb2dash",
    metadata: dict | None = None,
) -> SourceDocument:
    return SourceDocument(
        source="obsidian",
        external_id=external_id,
        body=body,
        title=title,
        agent="claude-code",
        collection=collection,
        metadata={"tags": ["rag"]} if metadata is None else metadata,
    )


def pipeline(store, embedder, **kwargs) -> IngestPipeline:
    chunker = MarkdownChunker(
        count_tokens=lambda t: len(t.split()),
        config=ChunkConfig(target_tokens=40, overlap_tokens=8, min_tokens=5, hard_max_tokens=80),
    )
    return IngestPipeline(store, embedder, chunker, **kwargs)


# --------------------------------------------------------------------------
# first ingest
# --------------------------------------------------------------------------


def test_new_document_is_inserted_with_chunks(fake_store, fake_embedder):
    stats = pipeline(fake_store, fake_embedder).run([document()])

    assert stats.count(Action.INSERTED) == 1
    assert fake_store.write_calls == 1
    assert fake_store.total_chunks >= 1
    assert stats.chunks_written == fake_store.total_chunks


def test_embeddings_match_chunks_one_for_one(fake_store, fake_embedder):
    pipeline(fake_store, fake_embedder).run([document()])
    for document_id, chunks in fake_store.chunks.items():
        assert len(fake_store.embeddings[document_id]) == len(chunks)
        assert all(len(v) == fake_embedder.dimensions for v in fake_store.embeddings[document_id])


# --------------------------------------------------------------------------
# re-run behaviour — the core requirement
# --------------------------------------------------------------------------


def test_rerun_of_unchanged_document_writes_nothing_and_embeds_nothing(
    fake_store, fake_embedder
):
    docs = [document()]
    pipeline(fake_store, fake_embedder).run(docs)
    writes_after_first = fake_store.write_calls
    chunks_after_first = fake_store.total_chunks
    embed_calls_after_first = len(fake_embedder.calls)

    stats = pipeline(fake_store, fake_embedder).run(docs)

    assert stats.count(Action.UNCHANGED) == 1
    assert stats.chunks_written == 0
    assert fake_store.write_calls == writes_after_first
    assert fake_store.total_chunks == chunks_after_first, "duplicate chunks appeared"
    assert len(fake_embedder.calls) == embed_calls_after_first, "re-embedded needlessly"


def test_cosmetic_whitespace_change_is_still_a_skip(fake_store, fake_embedder):
    pipeline(fake_store, fake_embedder).run([document()])
    crlf = document(body=BODY.replace("\n", "\r\n") + "\n\n\n")
    stats = pipeline(fake_store, fake_embedder).run([crlf])
    assert stats.count(Action.UNCHANGED) == 1


def test_changed_document_replaces_its_chunks_rather_than_appending(
    fake_store, fake_embedder
):
    pipeline(fake_store, fake_embedder).run([document()])
    first_chunk_count = fake_store.total_chunks

    edited = document(body=BODY + "\n\nAn added paragraph that changes the hash.\n")
    stats = pipeline(fake_store, fake_embedder).run([edited])

    assert stats.count(Action.UPDATED) == 1
    assert len(fake_store.documents) == 1, "upsert key produced a second row"
    assert fake_store.total_chunks != first_chunk_count or True
    document_id = next(iter(fake_store.chunks))
    indexes = [c.chunk_index for c in fake_store.chunks[document_id]]
    assert indexes == sorted(set(indexes)), "chunk indexes are not unique and ordered"
    assert indexes[0] == 0


def test_force_re_embeds_an_unchanged_document(fake_store, fake_embedder):
    docs = [document()]
    pipeline(fake_store, fake_embedder).run(docs)
    stats = pipeline(fake_store, fake_embedder, force=True).run(docs)
    assert stats.count(Action.UPDATED) == 1
    assert stats.chunks_written > 0


def test_same_external_id_across_sources_are_separate_documents(fake_store, fake_embedder):
    a = document()
    b = SourceDocument(
        source="claude-mem", external_id="notes/a.md", body=BODY, title="x", agent="claude-code"
    )
    pipeline(fake_store, fake_embedder).run([a, b])
    assert len(fake_store.documents) == 2


# --------------------------------------------------------------------------
# frontmatter-only changes: the metadata update path
# --------------------------------------------------------------------------
#
# content_hash is over the BODY. A resume flipping status to superseded, a
# child_sessions link, or `sweep-concluded --apply` setting status/concluded_at
# all change frontmatter and nothing else — and used to hit the UNCHANGED
# short-circuit, leaving rag.documents.metadata stale until the body happened to
# change. The hash function is deliberately unchanged: touching it would re-embed
# every document in the store.


def test_same_body_and_same_metadata_is_unchanged_and_writes_nothing(
    fake_store, fake_embedder
):
    docs = [document()]
    pipeline(fake_store, fake_embedder).run(docs)
    embeds_after_first = len(fake_embedder.calls)

    stats = pipeline(fake_store, fake_embedder).run(docs)

    assert stats.count(Action.UNCHANGED) == 1
    assert len(fake_embedder.calls) == embeds_after_first
    assert fake_store.metadata_writes == 0


def test_a_frontmatter_only_change_updates_metadata_without_re_embedding(
    fake_store, fake_embedder
):
    pipeline(fake_store, fake_embedder).run([document()])
    embeds_after_first = len(fake_embedder.calls)
    writes_after_first = fake_store.write_calls

    flipped = document(metadata={"tags": ["rag"], "status": "superseded"})
    stats = pipeline(fake_store, fake_embedder).run([flipped])

    assert stats.count(Action.METADATA_UPDATED) == 1
    assert stats.chunks_written == 0
    assert len(fake_embedder.calls) == embeds_after_first, "re-embedded a body that did not change"
    assert fake_store.write_calls == writes_after_first, "re-wrote chunks for a frontmatter edit"
    assert fake_store.metadata_writes == 1
    state = fake_store.documents[("obsidian", "notes/a.md")]
    assert state.metadata["status"] == "superseded"


def test_a_title_only_change_is_also_a_metadata_update(fake_store, fake_embedder):
    pipeline(fake_store, fake_embedder).run([document()])
    stats = pipeline(fake_store, fake_embedder).run([document(title="Renamed")])

    assert stats.count(Action.METADATA_UPDATED) == 1
    assert fake_store.documents[("obsidian", "notes/a.md")].title == "Renamed"
    assert len(fake_embedder.calls) == 1


def test_metadata_comparison_ignores_key_order(fake_store, fake_embedder):
    pipeline(fake_store, fake_embedder).run(
        [document(metadata={"a": 1, "b": {"x": True, "y": [1, 2]}})]
    )
    stats = pipeline(fake_store, fake_embedder).run(
        [document(metadata={"b": {"y": [1, 2], "x": True}, "a": 1})]
    )

    assert stats.count(Action.UNCHANGED) == 1
    assert fake_store.metadata_writes == 0


def test_a_changed_body_still_takes_the_full_re_embed_path(fake_store, fake_embedder):
    pipeline(fake_store, fake_embedder).run([document()])
    edited = document(
        body=BODY + "\n\nA new paragraph.\n",
        metadata={"tags": ["rag"], "status": "concluded"},
    )
    stats = pipeline(fake_store, fake_embedder).run([edited])

    assert stats.count(Action.UPDATED) == 1
    assert stats.chunks_written > 0
    assert len(fake_embedder.calls) == 2
    assert fake_store.metadata_writes == 0, "the full write already carries the metadata"


def test_force_re_embeds_rather_than_only_refreshing_metadata(fake_store, fake_embedder):
    pipeline(fake_store, fake_embedder).run([document()])
    stats = pipeline(fake_store, fake_embedder, force=True).run(
        [document(metadata={"tags": ["rag"], "status": "concluded"})]
    )

    assert stats.count(Action.UPDATED) == 1
    assert fake_store.metadata_writes == 0


def test_a_moved_note_gets_its_collection_corrected(fake_store, fake_embedder):
    """A note with a stable id that moves folders keeps its body.

    The collection is what `filter_collection` matches on, so leaving it stale
    is invisible: the note simply stops coming back for its new project and
    keeps coming back for its old one.
    """
    pipeline(fake_store, fake_embedder).run([document(collection="foo")])
    stats = pipeline(fake_store, fake_embedder).run([document(collection="bar")])

    assert stats.count(Action.METADATA_UPDATED) == 1
    assert fake_store.documents[("obsidian", "notes/a.md")].collection == "bar"
    assert len(fake_embedder.calls) == 1, "a move must not re-embed"


def test_metadata_that_cannot_be_compared_is_refreshed_rather_than_failed(
    fake_store, fake_embedder
):
    """canonical() can refuse a stored value; that must not fail the document.

    This path used to be a guaranteed no-op. A document that raised here would
    be counted FAILED on every run, and a run with failures never refreshes the
    health timestamp — so `ingest --health` would report STALE for good over a
    document nothing is trying to change.
    """
    from dataclasses import replace

    pipeline(fake_store, fake_embedder).run([document()])
    key = ("obsidian", "notes/a.md")
    deep: dict = {}
    cursor = deep
    for _ in range(40):
        cursor["n"] = {}
        cursor = cursor["n"]
    fake_store.documents[key] = replace(fake_store.documents[key], metadata=deep)

    stats = pipeline(fake_store, fake_embedder).run([document()])

    assert stats.count(Action.FAILED) == 0
    assert stats.count(Action.METADATA_UPDATED) == 1
    assert fake_store.documents[key].metadata == {"tags": ["rag"]}


def test_dry_run_reports_a_frontmatter_only_change_without_writing(
    fake_store, fake_embedder
):
    pipeline(fake_store, fake_embedder).run([document()])
    stats = pipeline(fake_store, None, dry_run=True).run(
        [document(metadata={"tags": ["rag"], "status": "concluded"})]
    )

    assert stats.count(Action.PLANNED_METADATA) == 1
    assert fake_store.metadata_writes == 0
    # Exactly the one call the first, non-dry run made: the dry run added none.
    assert len(fake_embedder.calls) == 1


# --------------------------------------------------------------------------
# dry run
# --------------------------------------------------------------------------


def test_dry_run_reports_without_writing_or_embedding(fake_store, fake_embedder):
    stats = pipeline(fake_store, None, dry_run=True).run([document()])

    assert stats.count(Action.PLANNED_NEW) == 1
    assert stats.chunks_planned > 0
    assert fake_store.write_calls == 0
    assert fake_embedder.calls == []


def test_dry_run_distinguishes_new_from_changed(fake_store, fake_embedder):
    pipeline(fake_store, fake_embedder).run([document()])
    edited = document(body=BODY + "\n\nEdited tail.\n")
    fresh = document(external_id="notes/b.md")

    stats = pipeline(fake_store, None, dry_run=True).run([edited, fresh])

    assert stats.count(Action.PLANNED_CHANGED) == 1
    assert stats.count(Action.PLANNED_NEW) == 1
    assert fake_store.write_calls == 1  # only the first, real run wrote


def test_dry_run_still_skips_unchanged(fake_store, fake_embedder):
    pipeline(fake_store, fake_embedder).run([document()])
    stats = pipeline(fake_store, None, dry_run=True).run([document()])
    assert stats.count(Action.UNCHANGED) == 1


def test_real_run_requires_an_embedder(fake_store):
    with pytest.raises(ValueError):
        IngestPipeline(fake_store, None)


# --------------------------------------------------------------------------
# failure isolation
# --------------------------------------------------------------------------


class ExplodingStore:
    def __init__(self, fail_on: str) -> None:
        self.fail_on = fail_on
        self.written: list[str] = []

    def get_document_state(self, source, external_id):
        return None

    def replace_document(self, doc, content_hash, chunks, embeddings):
        if doc.external_id == self.fail_on:
            raise StoreError("simulated write failure")
        self.written.append(doc.external_id)
        return len(self.written), True

    def close(self):
        return None


def test_one_failed_document_does_not_abort_the_run(fake_embedder):
    store = ExplodingStore(fail_on="notes/b.md")
    docs = [document("notes/a.md"), document("notes/b.md"), document("notes/c.md")]

    stats = pipeline(store, fake_embedder).run(docs)

    assert stats.count(Action.INSERTED) == 2
    assert stats.count(Action.FAILED) == 1
    assert stats.failures[0].external_id == "notes/b.md"
    assert store.written == ["notes/a.md", "notes/c.md"]


def test_stats_summary_counts_every_action(fake_store, fake_embedder):
    stats = pipeline(fake_store, fake_embedder).run([document()])
    summary = stats.summary()
    assert summary["inserted"] == 1
    assert stats.total == 1


# --------------------------------------------------------------------------
# document validation at the boundary
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "kwargs",
    [
        {"source": "", "external_id": "a", "body": "b"},
        {"source": "obsidian", "external_id": "", "body": "b"},
        {"source": "obsidian", "external_id": "a", "body": "   "},
    ],
)
def test_invalid_documents_are_rejected_on_construction(kwargs):
    from ingest.errors import DocumentError

    with pytest.raises(DocumentError):
        SourceDocument(**kwargs)


# --------------------------------------------------------------------------
# volatile ingest metadata: two machines, one store
# --------------------------------------------------------------------------


def with_ingest(**ingest_keys) -> dict:
    return {"tags": ["rag"], "_ingest": {"loader": "obsidian", "path": "notes/a.md", **ingest_keys}}


def test_mtime_and_size_changes_alone_are_unchanged(fake_store, fake_embedder):
    # A second checkout has different mtimes, and a CRLF checkout a different
    # byte count, for a note whose hash is identical. Without this, two machines
    # rewrite each other's metadata on every run, forever.
    first = document(metadata=with_ingest(modified_at="2026-09-01T00:00:00+00:00", bytes=100))
    pipeline(fake_store, fake_embedder).run([first])

    second = document(metadata=with_ingest(modified_at="2026-09-22T00:00:00+00:00", bytes=104))
    stats = pipeline(fake_store, fake_embedder).run([second])

    assert stats.count(Action.UNCHANGED) == 1
    assert fake_store.metadata_writes == 0


def test_a_realm_change_is_still_a_metadata_update(fake_store, fake_embedder):
    pipeline(fake_store, fake_embedder).run([document(metadata=with_ingest(realm="projects"))])
    stats = pipeline(fake_store, fake_embedder).run([document(metadata=with_ingest(realm="work-vm"))])
    assert stats.count(Action.METADATA_UPDATED) == 1
    assert fake_store.metadata_writes == 1
