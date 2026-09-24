# Memory sprint: requirements, tests and definitions of done

**Status:** proposed, 2026-09-24. **Owner:** Stack. **Scope:** the harness's own history in
its own realm, hub notes a person can read, proof that RAG is correct and used, a record of
what every session retrieved, and the read-only half of a curator that reviews the whole
corpus. `docs/vault-migration-requirements.md` is the format; this is the next contract.

Every requirement has an ID, a rationale with its source, tests in the order they are run
(unit → dry run → live), and a definition of done that a person can check without
judgement. A phase is closed only when every requirement in it is done.

## Why this sprint

Six asks from Stack (2026-09-24), in the order given:

1. The harness's own development and planning sessions get their own vault, portable to
   another machine by git, and RAG is used when the harness is developed.
2. `index` is renamed: every hub node in the graph is labelled `index`.
3. (Consideration only) the graph will become unreadable as it grows.
4. Test that chunking and embedding are correct and that sessions started from different
   places use RAG properly.
5. A cadenced reviewer that reads everything: a bug ledger with fixed/not-fixed, status
   against the plans, relevance and impact scores, and eventually condensing and pruning, with
   one agent trajectory across projects and classes.
6. Retrieval references recorded as metadata, for audit and a later feedback loop.

## Decisions Stack made (2026-09-24)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Where does harness history live? | A third realm, `harness`, in the existing vault, with its own private remote. |
| 2 | What runs the reviewer? | Tool-neutral repo commands; headless Claude Code (`claude -p`) runs them now, Hermes may run the same commands later. |
| 3 | How autonomous is it? | **The end goal is fully automatic.** This sprint builds the evidence that makes that safe (R-C7). |
| 4 | Where does the sprint stop? | Items 1, 2, 4, 6 built, plus the read-only half of item 5. Condense and prune are applied next sprint. Item 3 is design notes. |

## Facts this rests on (measured 2026-09-24)

- Vault `C:\Users\estac\vault`: realms `projects` and `classes`; 774 `.md`; 548 session notes, all
  `concluded`; `captured_by` sweep 318, hook 159, skill 2; `origin` cli 246, **sdk-py 225** (not
  ingested), claude-desktop 4, cloud 2, sdk-cli 2.
- Harness work is spread over five `projects` collections: `agentic-harness` 196 notes,
  `projects` 38, `memory` 27, `claude` 2, `remote` 2. The last four come from cwds under
  `~/.claude/projects/…` and `AppData/Local/Temp/claude/…` (scratchpads) that the folder walk-up
  resolves to whatever vault folder it meets first (`hooks/lib/collection.mjs:42`).
- 19 hub notes, all named `index.md` (`INDEX_FILENAME`, `hooks/lib/constants.mjs:143`). 614
  notes carry `up:`: 332 point at a hub, 282 at a parent session as a bare `[[<uuid>]]`
  (`parentLink`, `hooks/lib/links.mjs:63`).
- A 0-byte `vault/20c43c73-….md` appeared at the vault root at 09:58 today. A subagent's
  `up: [[20c43c73-…]]` pointed at a parent note that is only written when the parent session
  ends; following the link made Obsidian create the note at the vault root.
- Only `SessionEnd` and `SubagentStop` hooks are registered. **Nothing injects RAG context at
  session start**; a session remembers the past only if the agent chooses to search.
- The MCP server logs nothing about queries or results and knows neither the session nor the
  cwd (`mcp-server/src/tools/search-context.ts`). Notes record only call counts
  (`tools_used: mcp__rag__search_context: 3`, `hooks/lib/note.mjs`).
- Eval: 25 golden cases (12 claude-mem, 5 sessions, 1 vault note, 2 contains, 5 negatives), no
  per-collection field, no class session, not run by the nightly job. Last run hit@3 0.95,
  MRR 0.775, negatives 5/5.
- No store audit exists: no check for zero-chunk documents, null embeddings (the column is
  nullable) or vault↔store drift. Write-time guards only (`ingest/src/ingest/store.py`).
- Dogfood query today, "which chunks were retrieved by a session, retrieval logging,
  provenance", returned six hits at cosine 0.72–0.74 on a topic nothing in the store covers,
  all from session boilerplate sections (`Commands run`, `Files created or modified`).
- A metadata-only update already rewrites `collection` (`store.py:123`), and realm-scoped
  prune runs after the whole load (`ingest/src/ingest/cli.py:275`). A move between realms in
  one full run is therefore not read as a delete; R-H3 adds the test that pins it.
- `~/.claude` (CLAUDE.md, rules, skills, settings) is in no git repo. It is half of what
  "the harness" is.
- Hermes Agent (v0.21.5, MIT) runs cron jobs, mounts stdio MCP servers and runs on native
  Windows, but reaches Claude only through `ANTHROPIC_API_KEY` or Max with purchased extra
  usage ([providers](https://hermes-agent.nousresearch.com/docs/integrations/providers),
  [cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)). Its native
  Windows maturity is disputed between its own docs and third-party guides.

## Gates and order

Prerequisites: PR #15 merged (done, 151a584); the three
`committed -> pulled -> pushed` nights (2026-09-25 to 27, R-B1 of the migration contract) finish
before any live realm change in Phase H.

| Phase | Asks | PRs | Why this order |
| --- | --- | --- | --- |
| N — names a person can read | 2 | 1 | Smallest; touches the link code H also touches |
| H — the harness's own realm | 1 | 2 | Needs N's link shape; R-H4 is the first consumer of C's `status.md` but works without it |
| P — retrieval provenance | 6 | 1 | Q5 and C6 read its events |
| Q — RAG correctness and use | 4 | 1–2 | Needs H's routing and P's events for the location matrix |
| C — curator, read-only | 5 | 2 | Reads everything above |
| G — the graph at scale | 3 | 0 | Design notes only |

Every phase: tests first; `/code-review` with an explicit `main...<branch>` range (the review
skills diff the main checkout by default); conventional commits; `uv run ingest eval` before and
after any change to capture, chunking or `rag.search`, both scores in the commit body.
`/security-review` for P (queries are user text written to disk and the store), C (an LLM reading
untrusted notes) and R-H5 (a repo built from a folder that holds credentials).

---

## Phase N — names a person can read

### R-N1 Hub notes are named after their folder
- **Requirement.** `<realm>/<collection>/index.md` becomes `<realm>/<collection>/<collection>.md`.
  `type: index` and the UUID `id` stay. `INDEX_FILENAME`/`INDEX_NOTE`
  (`hooks/lib/constants.mjs:142-143`) become a function of the collection; `indexLink`
  (`hooks/lib/links.mjs:71`), `ensureIndex` (`hooks/lib/notes-io.mjs:161`), `link-sessions.mjs`,
  `migrate-sessions.mjs`, the materials renderer (`ingest/src/ingest/materials/render.py:35,134`)
  and the docs follow. A one-shot `hooks/rename-hubs.mjs --dry-run|--apply` does `git mv` per realm
  and rewrites every `up:` link that names a hub, reusing the frontmatter I/O in
  `hooks/lib/notes-io.mjs`.
- **Why.** Obsidian labels graph nodes by filename; `aliases` do not change the label, and showing
  them is an open feature request since 2024
  ([forum](https://forum.obsidian.md/t/aliases-in-graph-view/81698)). A note named after its folder is
  the convention folder-note plugins use
  ([Folder Notes](https://github.com/LostPaul/obsidian-folder-notes),
  [Waypoint](https://github.com/IdreesInc/Waypoint)). Because `external_id` is the frontmatter UUID
  (`ingest/src/ingest/loaders/obsidian.py`), the rename costs the store a metadata update, not a
  re-embed.
- **Tests.** Unit: `indexLink('projects','bb2dash')` returns
  `[[projects/bb2dash/bb2dash|bb2dash]]`; `ensureIndex` writes `<c>/<c>.md`; the rename script on a
  fixture vault moves the hub and rewrites the links, and a second run changes nothing. Dry run on the
  live vault: 19 moves, 332 link rewrites listed, nothing written. Live: `--apply`, one sync, one
  ingest (19 `metadata-updated`), eval.
- **Done when.** `Get-ChildItem C:\Users\estac\vault -Recurse -Filter index.md` is empty; a link
  check finds 0 `up:` values naming a missing file; the eval scores equal the previous run's, and
  golden case `ist323-index` still hits.

### R-N2 Subagent links resolve and never create stray notes
- **Requirement.** A subagent's `up` is path-qualified,
  `[[<realm>/<c>/sessions/<parent-uuid>|<short parent title>]]`. The capture hook treats a
  0-byte or frontmatter-less file at its target path as absent and writes over it. The existing
  root orphan is moved to `~/.claude-archive/2026-09-24-vault-orphans/` (a move, never `rm`).
- **Why.** A bare `[[uuid]]` whose note does not exist yet is created by Obsidian at the vault root
  (the "new note location" default) when followed: the 09:58 file above. A path-qualified link that
  is followed early creates the file where the hook will write it, and the hook must not be blocked
  by that empty file.
- **Tests.** Unit: `withLinks` for a subagent returns the qualified form; capture over a 0-byte file
  at the target path writes a full note. Live: follow a subagent's `up` while its parent is still
  running; the created file is in the right `sessions/` folder and is complete after the parent ends.
- **Done when.** No `.md` at the vault root; every subagent `up` resolves after its parent concludes.

### R-N3 Session titles that say something (stretch)
- **Requirement.** New session titles read `2026-09-24 · agentic-harness · <first six words of the
  first prompt>` instead of `Session 2026-09-24 — agentic-harness`. Existing notes are left alone
  until C5 supplies better titles. `docs/portable.md` documents the Front Matter Title plugin as an
  optional MANUAL step per machine (`.obsidian` is untracked).
- **Why.** Session files are named by UUID, so their nodes read as noise; Front Matter Title shows the
  frontmatter `title` in the graph without renaming files
  ([plugin](https://github.com/snezhig/obsidian-front-matter-title)).
- **Tests.** Unit: title builder on prompts with slash commands, pasted blocks and non-ASCII. Live: one
  new note's title.
- **Done when.** Stack decides whether to adopt it (open item 3); if yes, new notes carry the form.

---

## Phase H — the harness's own realm

### R-H1 A `harness` realm
- **Requirement.** `node hooks/init-realm.mjs --vault C:/Users/estac/vault --realm harness` creates
  the realm with its three policy files and one baseline commit; a private remote
  `emstacho-su/vault-harness`; `HARNESS_REALMS=projects:push,classes:push,harness:push`; `AREAS`
  (`hooks/lib/constants.mjs:133`) gains `harness`. Layout:
  `harness/agentic-harness/{agentic-harness.md, sessions/, notes/, decisions/}`.
- **Why.** A realm is already the unit that is its own git repo and its own sync and prune scope
  (`docs/portable.md`), so a separate history costs no new mechanism. A second Obsidian vault would have
  needed every tier (hook, sweep, collector, sync, ingest, doctor) to learn about more than one vault
  (decision 1).
- **Tests.** Unit: `AREAS` and the realm allowlist accept `harness`; `init-realm` in a scratch vault.
  Dry run: `init-realm --dry-run`, `sync-realms.mjs --push --dry-run` shows
  `harness: would-commit -> would-pull -> would-push`. Live: the same without `--dry-run`, then doctor.
- **Done when.** Doctor shows a `realm harness` row with its origin, and the next nightly log has a
  `harness: … -> pushed` line.

### R-H2 Harness sessions are routed there from wherever they start
- **Requirement.** A rule ahead of the git-remote rule in `deriveCollection`
  (`hooks/lib/collection.mjs:42`) sends to `harness/agentic-harness`: a repo whose remote is
  `emstacho-su/agentic-harness` (worktrees included), and any cwd under `~/.claude/` or `~/.harness/`.
  Scratchpad cwds `…/AppData/Local/Temp/claude/<sanitised-cwd>/…` are decoded back to the cwd they
  were made for (`C--Users-estac-agentic-harness` → `C:/Users/estac/agentic-harness`) and resolved
  again. That fix applies to every project, not only the harness. The rule list is data in one module
  with a table of cases.
- **Why.** The `claude`, `remote`, `memory` and `projects` collections are artefacts of cwds that the
  folder walk-up cannot interpret, and they split one project's history four ways. Subagents already
  take their parent's collection (PR #15).
- **Tests.** Unit, table-driven: the harness repo, a `-wt-` worktree, `~/.claude`,
  `~/.claude/projects/C--Users-estac-agentic-harness/memory`, a scratchpad cwd for the harness and one
  for bb2dash, `~`, the vault root, `vault/classes/ist323`, bb2dash. Each has an expected
  realm/collection.
- **Done when.** The table passes and three real sessions (harness repo, `~/.claude`, a scratchpad)
  land in `harness/agentic-harness/sessions/`.

### R-H3 The existing harness history moves, and the store follows
- **Requirement.** `hooks/move-to-realm.mjs --dry-run|--apply` re-resolves every note in the five
  collections with the R-H2 rules and moves those that now resolve to `harness` (copy into the harness
  realm, `git rm` in `projects`; both realms committed by one sync). The dry run prints one line per
  note: from, to, reason. A note that resolves elsewhere (a subagent of a bb2dash session, say) goes
  there, and the dry run says so. Hubs of the emptied folders are moved to the archive, not deleted.
- **Why.** Stable frontmatter ids mean the rows survive the move as metadata updates. Realm-scoped
  prune runs after the full load, so it no longer sees them as `projects` rows. What remains is the
  shared-store race: a second machine that holds `projects` but not `harness`, pulling the deletion
  before home-pc re-tags the rows, would prune them. The next home-pc ingest re-inserts them at
  re-embed cost only.
- **Tests.** Unit (Python): one full run over a fixture vault where a note moves from realm A to B
  updates `collection` and `_ingest.realm` and prunes nothing. Dry run on the live vault, reviewed by
  Stack line by line. Live: `--apply`, sync, ingest, eval.
- **Done when.** `projects/{claude,memory,projects,remote}` are gone; `harness/agentic-harness` holds
  the moved notes; ingest reports only `metadata-updated` for them and 0 deleted; eval is unchanged.

### R-H4 A harness session starts knowing where the project is
- **Requirement.** A `SessionStart` hook (startup and resume) resolves the collection with the same
  rules as capture and returns `additionalContext` of at most ~1,500 tokens: the collection's
  `status.md` (C4) when it exists, otherwise the `## Outcome` sections of the last five main sessions.
  It adds one line naming the `search_context` `collection` filter to use. It works for every
  collection, not only the harness. It fails open (empty context, logged) on any error or after 2 s,
  and records what it injected as a retrieval event (R-P1, channel `session-start`). The exact hook
  input/output contract is confirmed against the Claude Code docs before it is built.
- **Why.** Ask 1: RAG must be in play when the harness is developed, and today it is only if the agent
  decides to search. A short, fixed-cost brief plus a pointer to the filter is the cheapest reliable
  way to get there.
- **Tests.** Unit: resolution, the budget cap, the fallback, the 2 s timeout, and that a thrown error
  still yields a valid empty response. Live: a new session in the harness repo shows the brief in its
  first turn; a session in `~` gets the `estac` brief or none.
- **Done when.** R-Q4's matrix shows the right brief for every row it covers.

### R-H5 `~/.claude` travels too
- **Requirement.** A private repo `emstacho-su/claude-config` built from an **allowlist**: `CLAUDE.md`,
  `rules/`, `skills/`, and a `settings.template.json` holding the hooks and permissions but no secret.
  `install.mjs --config --dry-run|--apply` places it on a machine. A **denylist** that is refused even
  if allowlisted: `.credentials.json`, `history.jsonl`, `projects/`, `sessions/`, `file-history/`,
  `paste-cache/`, `shell-snapshots/`, `telemetry/`, `*.log`, `daemon*`. A secret scan with the capture
  hook's redaction rules (`hooks/lib/redact.mjs`) runs before every commit and refuses on a hit.
  Doctor gains a row for it.
- **Why.** Ask 1 asks for a harness that installs on another machine from GitHub. The code and the
  notes already do; the Claude Code configuration that shapes every session does not. The folder also
  holds live credentials, so only an allowlist is safe.
- **Tests.** Unit: allowlist/denylist resolution; a planted fake key in a skill file is refused. Dry
  run on the real `~/.claude`: the file list for Stack to read. Live: first push; install on a scratch
  user profile.
- **Done when.** The repo exists, private; its tree contains only allowlisted paths; the scan passes;
  a scratch profile gets a working `CLAUDE.md`, rules, skills and hooks from it.

### R-H6 One command brings up a machine
- **Requirement.** `scripts/bootstrap.ps1` and `.sh`, each with `--dry-run`, run the second-machine
  runbook steps 2–7 of `docs/portable.md` in order (clone, `uv sync`, build, store, `embed-check`,
  `db migrate`, clone the realms named in the machine file, R-H5 config, install, doctor). They stop at
  the first failure with the step named. The PAT (runbook step 8) stays MANUAL.
- **Why.** The runbook is ten manual steps; a portable harness should be one command plus a credential.
- **Tests.** Unit (Pester or bash) on the step sequencing and stop-on-failure. Live: a scratch Windows
  user profile, clean to doctor all-green.
- **Done when.** That live run succeeds with only the bootstrap and the MANUAL credential step, and the
  dev-VM runbook in `docs/portable.md` is rewritten around it.

---

## Phase P — retrieval provenance

### R-P1 Every retrieval is captured from the transcript
- **Requirement.** Capture (hook and sweep) extracts every `mcp__rag__search_context` and
  `mcp__rag__get_document` call from a transcript, main or subagent: the query, the filters, the
  limit, and per result the rank, `source`, `external_id`, chunk id, document id, `similarity` and
  `rrf`. R-H4 injections are recorded as channel `session-start`. Query text goes through the same
  redaction as prompts. **Spike first:** if the server's result can carry `structuredContent` and the
  transcript keeps it, parse that; otherwise parse the existing stable lines (`external_id:`,
  `similarity:`, `ids: doc N, chunk M`), pinned by a contract test in the MCP server's suite.
- **Why.** The transcript already exists for every local surface and names the session. The server
  runs as one process per client and would need new plumbing to know either. The field set follows the
  retrieval spans of OpenTelemetry GenAI and OpenInference
  ([OTel](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/),
  [OpenInference](https://arize-ai.github.io/openinference/spec/semantic_conventions.html)).
- **Tests.** Unit: fixture transcripts with zero, one and several searches, an empty result, a
  `get_document`, a subagent. A contract test fails if the server's output format drifts. Live: a
  session that searches twice has both searches in its note.
- **Done when.** The next ten live sessions that searched each list every search they made.

### R-P2 Stored markdown-first, projected into the store
- **Requirement.** Notes gain frontmatter `retrievals:` (compact: time, channel, tool, query, filters,
  results as `external_id@similarity`) and `retrieved:` (quoted, path-qualified links to the distinct
  vault notes retrieved, capped at 20, so the graph draws session → memory edges). Ingest projects
  `retrievals` into a new table `rag.retrieval_events` (session, parent session, machine, realm,
  collection, channel, tool, query, filters, limit, rank, source, external_id, chunk and document id,
  similarity, rrf, the `rag.search` migration version, and nullable `used` and `judged_relevant` for the
  feedback loop) and strips it from `documents.metadata`. The migration lives in `db/migrations/` and is
  applied with `uv run ingest db migrate`.
- **Why.** Markdown first, store second: the record travels with the note by git and can be rebuilt.
  Keeping it out of `documents.metadata` keeps search output small. Whether property links draw graph
  edges is not in Obsidian's docs ([properties](https://obsidian.md/help/properties)), so it is checked
  live before `retrieved:` is relied on for visualisation.
- **Tests.** Unit: frontmatter round-trip; the projection; stripping; idempotent re-ingest (no
  duplicate events). Dry run: `ingest --dry-run` reports the events it would write. Live: one live check
  that `retrieved:` draws edges in the graph.
- **Done when.** `select count(*) from rag.retrieval_events` matches the notes' `retrievals` entries,
  and re-running ingest leaves it unchanged.

### R-P3 Visible
- **Requirement.** `uv run ingest report retrievals [--json] [--since]` reports: most- and
  never-retrieved documents, empty-result queries, the similarity distribution, retrievals per
  collection, and searches whose `collection` filter differs from the session's own. A private Artifact
  dashboard renders the JSON; the curator run refreshes it weekly.
- **Why.** Ask 6: auditability. Never-retrieved and empty-result lists are also the raw material for
  the feedback loop and new golden cases (R-Q3).
- **Tests.** Unit on a fixture event set. Live: the first report reviewed with Stack.
- **Done when.** The dashboard exists and its numbers match the SQL they come from.

---

## Phase Q — is RAG correct, and is it used

### R-Q1 `uv run ingest verify` audits the store
- **Requirement.** A read-only command, exit 0 clean / 1 findings / 2 could not run, run by the nightly
  job after ingest. It checks:
  - every document has at least one chunk and `chunk_index` has no gaps;
  - no chunk has a null embedding and every stored vector's L2 norm is within 1e-3 of 1;
  - every `token_count`, recounted with the real tokenizer, is at most 512;
  - per realm, every ingestable note has a row with a matching `content_hash` and every row has a note;
  - no `external_id` is filed under two collections (the eight seen in the nightly log);
  - 50 random chunks, re-embedded, match their stored vectors at cosine ≥ 0.999.
- **Why.** Ask 4, "chunked and embedded properly", is a property of the store, not of the code that
  wrote it. Today only write-time guards exist, and the embedding column is nullable. The re-embed
  sample catches a model or package drift on one machine, the failure `embed-check` guards against
  before ingest but not after.
- **Tests.** Unit: each check against a fixture store with one planted defect of each kind. Live: first
  run, and every finding either fixed or explained.
- **Done when.** Two consecutive nightly runs report `verify: clean`.

### R-Q2 Boilerplate noise: measured, then fixed behind the eval
- **Requirement.** `verify --noise` reports, for the negative cases and a fixed list of off-topic
  probes, which session sections the returned chunks come from. One experiment follows: stop embedding
  `## Commands run` and `## Session facts` (they stay in the body and stay reachable by full-text
  search). It is kept only if hit@3 and MRR do not drop and the noise share falls. Today's dogfood query
  becomes a negative case now, before P makes it a real topic, with a note to retire it when P lands.
- **Why.** Today's off-topic query cleared the 0.70 floor six times on boilerplate alone. Smaller,
  focused chunks retrieve more precisely
  ([Chroma](https://www.trychroma.com/research/evaluating-chunking)), and the house rule is to measure
  first.
- **Tests.** Unit: section filter on fixture notes. Live: eval before and after, both scores in the
  commit.
- **Done when.** The experiment is either kept with better numbers or reverted with the numbers
  recorded in `docs/retrieval.md`'s table.

### R-Q3 Every collection is covered by the golden set
- **Requirement.** Golden cases gain `collection` and `realm`. At least three cases for every
  collection with sessions, including `harness/agentic-harness` and every class with material. The eval
  prints a per-collection table, runs nightly (read-only), and appends to `ingest/eval/history.jsonl`.
  Later, label proposals may come from P's events in the LLM-judge style of UMBRELA
  ([paper](https://arxiv.org/html/2406.06519v1)); Stack confirms every label, and none is edited to make
  a run pass.
- **Why.** Today's 25 cases never touch a class session or most project collections, so a regression
  there is invisible.
- **Tests.** Unit: the loader validates the new fields; per-collection aggregation. Live: first run.
- **Done when.** Every collection with sessions has three or more cases and the nightly log carries the
  scores.

### R-Q4 The location matrix
- **Requirement.** `scripts/location-matrix.ps1` runs `claude -p` with a fixed question from each of:
  the harness repo, a worktree, `~/.claude`, `~`, the vault root, `vault/classes/ist323`, bb2dash and a
  scratchpad cwd, against a scratch vault (`HARNESS_VAULT` override). For each it asserts that `rag`
  was connected, R-H4 injected the right collection's brief, the note landed in the right
  realm/collection, and the search was recorded (R-P1). The desktop app, a cloud session (expected: no
  `rag`; `/checkpoint` is the path) and the VM (migration Phase E) are MANUAL rows in the same table.
- **Why.** Ask 4, "sessions started from different locations". The routing is unit-tested in R-H2; this
  proves the whole chain on the real surfaces.
- **Tests.** The script is the test. Its assertion helpers are unit-tested against saved transcripts.
- **Done when.** Every automated row passes and the MANUAL rows are recorded with a date.

### R-Q5 "Used properly" is a number
- **Requirement.** `ingest report retrievals` adds four numbers:
  - the share of main sessions that retrieved at all;
  - the empty-result rate;
  - the share of searches whose collection filter differs from the session's own;
  - the `get_document` follow-through rate.

  Each is reported per collection and per week. **No threshold is set until two weeks of baseline
  exist**; the spec then records the thresholds and why.
- **Why.** Ask 4, "efficiently, accurately and meaningfully", needs numbers, and inventing targets
  before a baseline would be guessing.
- **Tests.** Unit on fixture events.
- **Done when.** Two weekly reports exist and the thresholds are written into this file.

---

## Phase C — the curator, read-only

**Shape.** `uv run ingest curate <stage>` in Python does every read and write. The LLM is a pure
function behind a `Judge` interface: text and a JSON schema in, JSON out, **no tools**. The first
backend is `claude -p --json-schema --output-format json --model <m>`, run on Stack's login
([headless](https://code.claude.com/docs/en/headless)). An API Batches backend (50% off,
[batches](https://platform.claude.com/docs/en/build-with-claude/batch-processing)) and a Hermes cron
job calling the same commands are later options, not this sprint. It runs weekly, Sunday 04:00, after
the nightly job and the store backup. Registering the task is Stack's to do with the `!` prefix.

**One trajectory for every realm.** Each hub note gains `kind: project | class` and `plan_sources:`
(repo paths or vault notes). The stages are shared; the prompts and scoring rubrics come from the
profile.
- A **project**'s plan is its requirement and phase documents. An issue is a bug, error or breakage.
- A **class**'s plan is the syllabus and assignment briefs (the exported materials notes). An issue is a
  misconception, blocker or unresolved question.

### R-C1 Inventory and timeline
- **Requirement.** A deterministic stage that lists, per collection in date order, main sessions with
  their subagents nested beneath, the plan sources, and git facts: commits with their conventional
  type, and PRs with merge state via `gh`. It reads the vault, **including the 225 `sdk-*` review-worker
  notes the store leaves out**, because they hold the code-review findings the ledger needs.
- **Tests.** Unit on a fixture vault and a fixture git repo. Dry run: counts per collection.
- **Done when.** The counts match the vault's own counts per collection.

### R-C2 Extraction, cached and checked
- **Requirement.** Per note, the judge returns the following, validated against the schema:
  - issues: kind, summary, a verbatim evidence quote, files, a claim (found, fixed, workaround or
    wontfix), and a fix reference;
  - decisions, requirement ids referenced, status claims, and open questions.

  An evidence quote that is not an exact substring of the note rejects that item (a hallucination
  guard). Results are cached in a new `curate` schema keyed by
  `(note id, content_hash, extractor_version)`, so a rerun only pays for changed notes. Several notes go
  in one call. A per-run budget (calls and tokens) stops the run and reports how far it got. `--dry-run`
  prints the planned calls and their estimated size.
- **Why.** Every later stage reads these facts, and a quote that must exist in the source is a cheap,
  exact check on an LLM summariser.
- **Tests.** Unit: schema validation, the substring guard, cache hits and misses, the budget stop, all
  with a fake judge. Pilot: `agentic-harness` only, with Stack reading 20 random extractions.
- **Done when.** The pilot's sampled extractions are judged correct by Stack at 18 of 20 or better.

### R-C3 The issue ledger, bi-temporal
- **Requirement.** Issues are clustered across notes (bge similarity on summaries, then a judge
  confirmation) into one record each, with a state of open, claimed-fixed, verified or regressed.
  Every transition cites the note and date that caused it. A later session's claim, a `fix:` commit
  touching the named files, a merged PR, or a recurrence after a fix each move the state. Nothing is
  deleted: a fixed issue gets an end date. Output: `<realm>/<collection>/ledger.md`, with stable ids
  `ISSUE-<collection>-NNN`.
- **Why.** Ask 5: "whether it has been fixed, at all, and whether a later session fixed it". The
  closest prior art is Graphiti's validity intervals, which close a fact rather than delete it, and
  Mem0's invalidation ([Graphiti](https://arxiv.org/html/2501.13956),
  [Mem0](https://arxiv.org/html/2504.19413)).
- **Tests.** Unit: state machine transitions; ids stay stable across runs. Pilot: Stack checks ten
  ledger entries against their own recollection and the git log.
- **Done when.** Nine of ten pilot entries are right, and a rerun with no new notes changes nothing.

### R-C4 Status against the plan
- **Requirement.** Requirement ids, phase tables and checkboxes are parsed from `plan_sources` and
  matched to evidence, giving each requirement a state: not started, in progress, claimed done,
  verified (its done-when evidenced), or contradicted. Output: `<realm>/<collection>/status.md`,
  which R-H4 injects.
- **Why.** Ask 5, "status and progress". This file is also what gives a new session its bearings.
- **Tests.** Unit: parsers against this file and `vault-migration-requirements.md`. Pilot: Stack
  reviews `status.md` for `agentic-harness`.
- **Done when.** Stack signs off the pilot status as accurate.

### R-C5 A readable history
- **Requirement.** `<realm>/<collection>/history.md`: a week-by-week narrative in which every claim
  cites the session ids it rests on. It also supplies better session titles for R-N3.
- **Why.** Ask 5's "history of the project" and ask 3's readable layer are the same thing. The pattern
  is Generative Agents' reflections, which keep pointers to the memories they summarise
  ([paper](https://ar5iv.labs.arxiv.org/html/2304.03442)).
- **Tests.** Unit: every citation resolves to a note. Pilot: Stack reads it.
- **Done when.** Every citation resolves, and Stack signs it off.

### R-C6 Scores and proposals, no action
- **Requirement.** Each note gets two scores, stored in `curate` tables rather than in the notes (so
  weekly runs do not churn git):
  - **Impact**, from deterministic features: commits, PRs, decisions, issues found or fixed, later
    citations, R-P retrieval and `used` counts, and children. A judge's 1–10 importance is added only
    where the features disagree.
  - **Relevance**: similarity to the open items in `status.md`, recency with a per-profile half-life,
    and ledger links.

  `<realm>/curation/<date>.md` lists condense candidates (a subagent note fully represented in its
  parent, the ledger and the history) and prune candidates (for example, a scratchpad session with no
  commit, decision or issue). Each candidate has its reasons and a checkbox for Stack.
- **Why.** Ask 5a and 5b need scores first; acting on scores nobody has checked is how a curator
  deletes the one note that mattered.
- **Tests.** Unit: feature extraction and score arithmetic on fixtures. Live: the first report.
- **Done when.** Two weekly reports exist for the pilot collection.

### R-C7 The road to fully automatic
- **Requirement.** Stack's ticks and unticks in each curation report are tallied per action type
  (condense, prune). Promotion rule, fixed now:
  - An action type becomes automatic after **three consecutive runs at ≥ 95% acceptance** in which a
    verifier pass finds no information lost (every issue, decision and requirement reference in the
    removed text is present in what remains).
  - Condense and prune are promoted separately.
  - A rejected automatic action demotes the type back to proposals.

  Applied actions (next sprint) are realm git commits and never delete. Condense writes a summary that
  cites its sources and moves the originals. Prune sets `status: pruned` and `ingest: false` and moves
  the note to `<realm>/_archive/`.
- **Why.** Decision 3: fully automatic is the goal. Earned trust with an automatic demotion is how to
  get there without a silent loss. The archive-not-delete rule matches Hermes' own curator
  ([curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator)).
- **Tests.** Unit: the tally and the promotion and demotion rule.
- **Done when.** The tally is in each curation report.

### Curator safety
- Notes are untrusted input: they contain pasted web text and tool output. The judge has no tools, its
  output is schema-validated, and only the Python stage writes files, and only curator-owned paths.
- Curator-written notes carry `captured_by: curator` and `type: status | ledger | history |
  curation-report`. They are ingested (so `search_context` finds status), but never condensed or pruned.
- The pilot is `agentic-harness`; all realms follow only after R-C2 to R-C5 pass there.

---

## Phase G — the graph at scale (design notes, no requirements yet)

The layers, from the top:
1. the hub;
2. `status`, `ledger` and `history`;
3. main sessions;
4. subagents (282 of the 614 linked notes today).

The levers, each with the trigger that would make it a requirement:

| Lever | Trigger |
| --- | --- |
| Condense subagents into their parent (C, next sprint) | R-C7 promotes condense |
| Colour groups by `type` and path, and a saved "overview" filter (`-path:sessions`) | Any collection over 300 notes |
| Local graph as the default view; hub → history → session drill-down | Stack reports the global graph unusable |
| Front Matter Title plugin | R-N3 adopted |
| Month rollup notes, deferred since PR #5 | `history.md` proves too coarse |

## Open items for Stack

1. `claude-config` private (recommended) or public.
2. Curator cadence: weekly (recommended) or nightly.
3. R-N3 and the Front Matter Title plugin: adopt or skip.
4. The pilot collection: `agentic-harness` (recommended) or another.
