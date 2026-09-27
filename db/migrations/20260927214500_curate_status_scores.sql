-- The curator's C-b state: the history cache (R-C5), note scores and the
-- judge's importance (R-C6), and the curation report's proposals and Stack's
-- decisions on them (R-C6, R-C7).
--
-- Scores, titles, narratives, proposals and decisions live here, never in note
-- frontmatter: a weekly run that rewrote every note's score would churn the
-- vault's git history and re-embed every note for a number nobody reads there.
-- Like 20260927200342_curate_schema.sql this file only adds, and nothing in
-- these tables is removed or rewritten: a new input, version or day is a new
-- row, so a rerun with nothing new inserts nothing.
--
-- history_weeks caches the judge's narrative for one week of one collection,
-- keyed by the hash of the notes it read and the history version: a rerun pays
-- the judge only for a week whose notes or prompt changed. narrative is an
-- array of {"text", "note_ids"} paragraphs, each citing the session ids it rests
-- on; titles maps note id to the better title R-N3 shows.
--
-- note_scores holds one row per note per weekly run and scorer version: impact
-- (deterministic features: commits, PRs, decisions, issues, citations,
-- retrievals, children) and relevance (open items, recency, ledger links).
-- features keeps the inputs, so a surprising score can be explained without a
-- rerun. importance is the judge's 1-10, present only where the features
-- disagreed and the judge was asked; importance_judgements caches it per note
-- version so the next week does not ask again.
--
-- proposals are the condense and prune candidates exactly as one report listed
-- them, with their reasons and the R-C7 verifier's no_loss verdict (every
-- issue, decision and requirement reference in the removed text survives
-- elsewhere). decisions is the append-only log of Stack's ticks (accepted) and
-- unticks in those reports: a row lands only when it changes the latest
-- decision for its proposal, and the latest row per (realm_folder, report_day,
-- note_id, action) is the decision. The tally and the promotion rule read it.
-- It holds no foreign key to proposals: a tick is recorded as Stack made it.
--
-- Service-role access only, like the rest of curate: RLS on every table and no
-- policies. The revoke below repeats the one in the curate schema migration,
-- because "all tables in schema" means the tables that exist when it runs.

create table curate.history_weeks (
  collection      text        not null,
  week_start      date        not null,
  input_hash      text        not null,   -- hash of the week's notes as the judge saw them
  history_version text        not null,   -- prompt + schema fingerprint
  narrative       jsonb       not null,
  titles          jsonb       not null default '{}'::jsonb,
  model           text,
  input_tokens    int         check (input_tokens >= 0),
  output_tokens   int         check (output_tokens >= 0),
  created_at      timestamptz not null default now(),
  primary key (collection, week_start, input_hash, history_version),
  constraint history_weeks_narrative_array check (jsonb_typeof(narrative) = 'array'),
  constraint history_weeks_titles_object   check (jsonb_typeof(titles) = 'object')
);

-- float8 admits NaN and the infinities; NaN sorts above 'infinity', so the
-- open interval below refuses all three.
create table curate.note_scores (
  note_id        text             not null,
  scorer_version text             not null,
  run_day        date             not null,
  content_hash   text             not null,   -- the note version that was scored
  realm          text,
  collection     text             not null,
  impact         double precision not null
                 check (impact > '-infinity'::float8 and impact < 'infinity'::float8),
  relevance      double precision not null
                 check (relevance > '-infinity'::float8 and relevance < 'infinity'::float8),
  features       jsonb            not null default '{}'::jsonb,
  importance     int              check (importance between 1 and 10),
  created_at     timestamptz      not null default now(),
  primary key (note_id, scorer_version, run_day),
  constraint note_scores_features_object check (jsonb_typeof(features) = 'object')
);

create index note_scores_collection_day_idx on curate.note_scores (collection, run_day);

create table curate.importance_judgements (
  note_id        text        not null,
  content_hash   text        not null,
  scorer_version text        not null,
  importance     int         not null check (importance between 1 and 10),
  model          text,
  created_at     timestamptz not null default now(),
  primary key (note_id, content_hash, scorer_version)
);

create table curate.proposals (
  realm_folder text        not null,   -- the realm's vault folder the report sits in
  report_day   date        not null,
  note_id      text        not null,
  action       text        not null check (action in ('condense', 'prune')),
  collection   text        not null,
  reasons      jsonb       not null,
  no_loss      boolean     not null,
  created_at   timestamptz not null default now(),
  primary key (realm_folder, report_day, note_id, action),
  constraint proposals_reasons_array check (jsonb_typeof(reasons) = 'array')
);

create table curate.decisions (
  id           bigint generated always as identity primary key,
  realm_folder text        not null,
  report_day   date        not null,
  note_id      text        not null,
  action       text        not null check (action in ('condense', 'prune')),
  accepted     boolean     not null,   -- true: ticked; false: unticked
  recorded_at  timestamptz not null default now()
);

-- The latest decision per proposal is the last id under this prefix.
create index decisions_proposal_idx on curate.decisions (realm_folder, report_day, note_id, action, id);

-- Service-role access only: RLS on, no policies.
alter table curate.history_weeks         enable row level security;
alter table curate.note_scores           enable row level security;
alter table curate.importance_judgements enable row level security;
alter table curate.proposals             enable row level security;
alter table curate.decisions             enable row level security;

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

comment on table curate.history_weeks is 'Cache of the judge''s weekly narrative per collection (R-C5), keyed by the input hash and history version so an unchanged week is never paid for twice. narrative: [{"text", "note_ids"}]; titles: note id -> title.';
comment on table curate.note_scores is 'Impact and relevance per note per weekly run (R-C6), kept here rather than in frontmatter so weekly runs do not churn the vault. features: the inputs, so a score can be explained.';
comment on table curate.importance_judgements is 'Cache of the judge''s 1-10 importance per note version, asked only where the features disagree. The first judgement for a key is kept.';
comment on table curate.proposals is 'Condense and prune candidates as a curation report listed them, with reasons and the R-C7 verifier''s no_loss verdict.';
comment on table curate.decisions is 'Append-only log of Stack''s ticks and unticks (R-C7). A row lands only when it changes the latest decision for its proposal; the latest row per key is the decision.';
comment on column curate.note_scores.importance is 'The judge''s 1-10, null unless the features disagreed and the judge was asked.';
comment on column curate.proposals.no_loss is 'True when every issue, decision and requirement reference in the removed text is present in what remains.';
comment on column curate.decisions.accepted is 'True for a tick, false for an untick.';
