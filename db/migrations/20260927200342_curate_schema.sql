-- The curator's own schema: the extraction cache (R-C2) and the issue ledger (R-C3).
--
-- The curator (`uv run ingest curate <stage>`) reads the vault and git, asks a
-- judge model to extract issues, decisions and claims from each note, and
-- clusters the issues into a ledger. It is read-only towards the vault and the
-- rag schema; everything it learns lives here, in its own schema, so a weekly
-- run never churns notes or rag rows.
--
-- extractions is a cache keyed by (note id, content hash, extractor version):
-- a rerun pays the judge only for notes whose text or extractor changed. A new
-- version is a new row; old rows stay, because the ledger's members point at
-- the exact version they were read from. result holds the accepted items as a
-- JSON array; rejected holds the items the substring guard or validation threw
-- out, each with its reason, so a pilot reviewer can see what was dropped.
--
-- issues are one row per clustered issue, with a stable id
-- ISSUE-<collection>-NNN (spaces in the collection become '-' in the id only;
-- the collection column is verbatim). seq is allocated from issue_counters,
-- one row per collection, bumped with insert .. on conflict do update ..
-- returning in the same transaction as the issue insert: the row lock
-- serializes two allocators and a rollback gives the number back. max(seq)+1
-- cannot be locked (Postgres refuses FOR UPDATE with an aggregate) and two
-- concurrent readers would pick the same seq.
--
-- issue_members says which extracted item (result[item_index] of one
-- extraction) belongs to which issue; an item belongs to at most one. It
-- references issues only, not extractions: nothing here is ever deleted, and
-- an old extraction version must keep its members.
--
-- issue_events is append-only and bi-temporal, after Graphiti's validity
-- intervals: effective_at is when a thing happened (the note, commit or merge
-- date), recorded_at is when the curator learned it. An issue's state is the
-- fold of its events; a fixed issue gets an end, never a delete. to_state is
-- null for an annotation that moves no state. The unique key is the cause, so
-- a rerun over the same notes and commits inserts nothing.
--
-- judge_confirmations caches the judge's "same issue?" verdicts, keyed by the
-- item, the candidate issue and the extractor version. It is a pure cache and
-- holds no foreign key.
--
-- Service-role access only, like rag: RLS on every table and no policies. The
-- revoke below is a guard for Supabase, where anon and authenticated exist;
-- a plain Postgres has neither role and skips it.

create schema if not exists curate;

create table curate.extractions (
  note_id           text        not null,   -- the vault note's id (external_id in rag)
  content_hash      text        not null,
  extractor_version text        not null,
  realm             text,
  collection        text        not null,
  note_path         text        not null,   -- vault-relative path when extracted
  result            jsonb       not null,
  rejected          jsonb       not null default '[]'::jsonb,
  model             text,
  input_tokens      int         check (input_tokens >= 0),
  output_tokens     int         check (output_tokens >= 0),
  created_at        timestamptz not null default now(),
  primary key (note_id, content_hash, extractor_version),
  constraint extractions_result_array   check (jsonb_typeof(result) = 'array'),
  constraint extractions_rejected_array check (jsonb_typeof(rejected) = 'array')
);

create index extractions_collection_idx on curate.extractions (collection);

create table curate.issue_counters (
  collection text primary key,
  last_seq   int  not null check (last_seq >= 1)
);

create table curate.issues (
  issue_id      text        primary key,   -- ISSUE-<collection>-NNN
  collection    text        not null,
  seq           int         not null check (seq >= 1),
  kind          text,
  summary       text        not null,
  files         text[]      not null default '{}',
  first_seen_at timestamptz not null,
  created_at    timestamptz not null default now(),
  constraint issues_collection_seq_uniq unique (collection, seq)
);

create table curate.issue_members (
  issue_id          text        not null references curate.issues (issue_id),
  note_id           text        not null,
  content_hash      text        not null,
  extractor_version text        not null,
  item_index        int         not null check (item_index >= 0),
  created_at        timestamptz not null default now(),
  primary key (note_id, content_hash, extractor_version, item_index)
);

create index issue_members_issue_idx on curate.issue_members (issue_id);

create table curate.issue_events (
  id           bigint generated always as identity primary key,
  issue_id     text        not null references curate.issues (issue_id),
  to_state     text        check (to_state in ('open', 'claimed-fixed', 'verified', 'regressed')),
  event_kind   text        not null check (event_kind in (
                 'found', 'claim-fixed', 'claim-workaround', 'claim-wontfix',
                 'fix-commit', 'merged-pr', 'recurrence')),
  effective_at timestamptz not null,
  recorded_at  timestamptz not null default now(),
  cause_type   text        not null check (cause_type in ('note', 'commit', 'pr')),
  cause_ref    text        not null,     -- note id, commit sha, or PR number
  evidence     text,
  constraint issue_events_cause_uniq unique (issue_id, event_kind, cause_type, cause_ref)
);

create table curate.judge_confirmations (
  item_key          text        not null,
  issue_id          text        not null,
  extractor_version text        not null,
  same              boolean     not null,
  model             text,
  created_at        timestamptz not null default now(),
  primary key (item_key, issue_id, extractor_version)
);

-- Service-role access only: RLS on, no policies.
alter table curate.extractions         enable row level security;
alter table curate.issue_counters      enable row level security;
alter table curate.issues              enable row level security;
alter table curate.issue_members       enable row level security;
alter table curate.issue_events        enable row level security;
alter table curate.judge_confirmations enable row level security;

do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on schema curate from %I', api_role);
      execute format('revoke all on all tables in schema curate from %I', api_role);
      execute format('revoke all on all sequences in schema curate from %I', api_role);
    end if;
  end loop;
end;
$$;

comment on schema curate is 'The read-only curator''s own state: extraction cache (R-C2) and issue ledger (R-C3). Nothing is deleted.';
comment on table curate.extractions is 'Judge output per (note_id, content_hash, extractor_version). result: accepted items, a JSON array; rejected: items refused by the substring guard or validation, with a reason.';
comment on table curate.issue_counters is 'Last allocated seq per collection, bumped in the same transaction as the issue insert.';
comment on table curate.issue_events is 'Append-only, bi-temporal: effective_at is when it happened, recorded_at when the curator learned it. Unique per cause, so reruns insert nothing.';
comment on table curate.judge_confirmations is 'Cache of same-issue verdicts. The first verdict for a key is kept.';
