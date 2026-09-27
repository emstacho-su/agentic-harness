-- Retrieval provenance: which searches each session made, and what they returned.
--
-- The capture hook writes every rag search a session made into that session's
-- note, as frontmatter `retrievals:`. The note is the record; this table is its
-- projection, rebuilt by ingest from the notes and never written by anything
-- else. Ingest keeps `retrievals` out of rag.documents.metadata, so search output
-- stays small.
--
-- One row per (retrieval, result). A retrieval that found nothing is one row
-- with a null rank and null result columns: an empty result is an answer, and
-- the report lists those queries.
--
-- Re-ingesting a note deletes its rows and inserts them again in one
-- transaction, keyed by the note, so a re-run never duplicates an event. The
-- unique index is `nulls not distinct` so the empty-result row is covered too.
--
-- document_id is the session note's own row and cascades: a pruned note takes
-- its events with it, so the table's count keeps matching the notes. The rows
-- are rebuildable from the notes, so nothing is lost that the vault still holds.
--
-- result_document_id is looked up by (source, external_id) when the row is
-- written. It is deliberately not a foreign key: a retrieved document can be
-- pruned later, and the event still happened.

create table rag.retrieval_events (
  id                 bigint generated always as identity primary key,
  note_source        text        not null,   -- the session note's row: 'obsidian'
  note_external_id   text        not null,
  document_id        bigint      references rag.documents(id) on delete cascade,
  session_id         text        not null,
  parent_session     text,
  machine            text,
  realm              text,
  collection         text,                   -- the session note's collection
  channel            text        not null check (channel in ('tool', 'session-start')),
  tool               text        not null,   -- search_context | get_document | session-start
  query              text        not null default '',
  filters            jsonb       not null default '{}'::jsonb,
  "limit"            int,
  retrieval_index    int         not null check (retrieval_index >= 0),
  retrieved_at       timestamptz not null,
  rank               int,                    -- 1-based; null for an empty result
  source             text,
  external_id        text,
  result_document_id bigint,
  chunk_id           bigint,
  similarity         double precision,
  rrf                double precision,
  search_version     text,                   -- latest rag.search migration applied when projected
  used               boolean,                -- feedback loop; null until judged
  judged_relevant    boolean,                -- feedback loop; null until judged
  created_at         timestamptz not null default now(),
  constraint retrieval_events_result_shape check (
    (rank is null and source is null and external_id is null)
    or (rank >= 1 and source is not null and external_id is not null)
  )
);

create unique index retrieval_events_note_key on rag.retrieval_events
  (note_source, note_external_id, retrieval_index, rank) nulls not distinct;

create index retrieval_events_session_idx    on rag.retrieval_events (session_id);
create index retrieval_events_result_idx     on rag.retrieval_events (source, external_id);
create index retrieval_events_time_idx       on rag.retrieval_events (retrieved_at);
create index retrieval_events_collection_idx on rag.retrieval_events (collection);
create index retrieval_events_document_idx   on rag.retrieval_events (document_id);

-- Service-role access only: RLS on, no policies granted, like rag.documents and rag.chunks.
alter table rag.retrieval_events enable row level security;

comment on table rag.retrieval_events is 'Projection of session notes'' retrievals: frontmatter. One row per result of one search; an empty result is one row with a null rank. Rebuilt by ingest; the notes are the record.';
comment on column rag.retrieval_events.search_version is 'Version of the newest applied rag.search migration in rag_meta.schema_migrations when the row was written; null where that ledger does not exist.';
comment on column rag.retrieval_events.result_document_id is 'rag.documents.id of the result, looked up by (source, external_id) at projection time. Not a foreign key: the event outlives a pruned document.';
