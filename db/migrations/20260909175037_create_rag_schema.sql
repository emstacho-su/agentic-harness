-- Session-history RAG for the agentic harness.
-- Relocated from bb2dash, which now owns only its own app + class-materials corpus.
-- Agent-neutral by design so Hermes Agent can share it without migration.

create extension if not exists vector with schema extensions;

create schema if not exists rag;

create table rag.documents (
  id           bigint generated always as identity primary key,
  source       text        not null,   -- 'obsidian' | 'claude-mem' | 'hermes'
  collection   text,                   -- project or class: 'ev-trainer', 'IST335', ...
  agent        text,                   -- which agent authored/ingested it
  external_id  text        not null,   -- vault rel path, or claude-mem observation id
  title        text,
  body         text        not null,
  metadata     jsonb       not null default '{}'::jsonb,
  content_hash text        not null,   -- sha256, drives change detection
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint documents_source_external_uniq unique (source, external_id)
);

create index documents_source_idx     on rag.documents (source);
create index documents_collection_idx on rag.documents (collection);
create index documents_agent_idx      on rag.documents (agent);
create index documents_hash_idx       on rag.documents (content_hash);
create index documents_metadata_idx   on rag.documents using gin (metadata jsonb_path_ops);

create table rag.chunks (
  id          bigint generated always as identity primary key,
  document_id bigint not null references rag.documents(id) on delete cascade,
  chunk_index int    not null,
  content     text   not null,
  token_count int,
  embedding   extensions.vector(384),  -- bge-small-en-v1.5 via local fastembed
  tsv         tsvector generated always as (to_tsvector('english', content)) stored,
  created_at  timestamptz not null default now(),
  constraint chunks_doc_idx_uniq unique (document_id, chunk_index)
);

create index chunks_document_idx  on rag.chunks (document_id);
create index chunks_tsv_idx       on rag.chunks using gin (tsv);
create index chunks_embedding_idx on rag.chunks
  using hnsw (embedding extensions.vector_cosine_ops);

create or replace function rag.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger documents_touch_updated_at
  before update on rag.documents
  for each row execute function rag.touch_updated_at();

-- Service-role access only: RLS on, no policies granted.
alter table rag.documents enable row level security;
alter table rag.chunks    enable row level security;

comment on schema rag is 'Agentic harness session-history RAG. Obsidian vault + migrated claude-mem history. Shared with Hermes Agent.';
comment on column rag.documents.source is 'Open text, not enum, so new producers need no migration.';
comment on column rag.documents.collection is 'Project or class this history belongs to, e.g. ev-trainer or IST335. Mirrors the vault folder structure.';
comment on column rag.chunks.embedding is '384-dim, BAAI/bge-small-en-v1.5 via local fastembed. Changing model = change dim + re-embed all rows.';
