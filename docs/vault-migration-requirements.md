# Vault migration: requirements, tests and definitions of done

**Status:** proposed, 2026-09-22. **Owner:** Stack. **Scope:** moving the home vault out of
OneDrive into git-backed realms, bringing the internship VM up as a second machine, and
keeping the store correct on both. `docs/portable.md` is the model; this is the contract.

Every requirement has an ID, a rationale with its source, tests in the order they are run
(unit → dry run → live), and a definition of done that a person can check without judgement.
A phase is closed only when every requirement in it is done. Nothing in a later phase starts
before that; the gates exist because the failure modes below were all found by people who
skipped one.

Facts this rests on (measured 2026-09-22): the vault is 9.9 MB, 620 notes, one 4.9 MB
`.pptx` attachment, no filenames Windows or git reject, no OneDrive placeholders, no
community plugins. Git Credential Manager is active for this user; `gh` holds a `repo`-scoped
token. `emstacho-su/vault` already exists as a private repo from May 2026 with an older,
unrelated layout.

---

## Phase A — the repo hygiene that has to exist before the first commit

### R-A1 Line endings are the repo's policy, not each machine's
- **Requirement.** Every realm repo carries a committed `.gitattributes` with `* text=auto`
  and `*.md text eol=lf`, and its first commit is preceded by `git add --renormalize .`.
- **Why.** A committed `.gitattributes` overrides every contributor's `core.autocrlf`; a
  per-machine setting drifts the first time a machine is set up differently, and the ingest
  hash already has to forgive CRLF because OneDrive round-trips flipped it
  ([GitHub docs](https://docs.github.com/en/get-started/git-basics/configuring-git-to-handle-line-endings)).
- **Tests.** Unit: a `hooks/lib/realm-init.mjs` helper writes the file byte-exactly; test
  asserts content. Dry run: `git ls-files --eol` on the initialised repo shows `i/lf` for
  every `.md`. Live: same command on the real realm after its first commit.
- **Done when.** `git ls-files --eol | grep -v 'i/lf' | grep '\.md'` prints nothing in both
  realms, and the `.gitattributes` is in the first commit of each.

### R-A2 Per-device Obsidian state never enters git
- **Requirement.** Each realm's `.gitignore` excludes `.obsidian/workspace.json`,
  `.obsidian/workspace-mobile.json`, `.trash/`, `.DS_Store`, `Thumbs.db`, and every
  `.obsidian/plugins/*/` cache directory. `.obsidian` itself stays at the vault root,
  outside every realm, and is not tracked (decision 5): Obsidian opens the vault as one
  folder with the realms side by side, and what travels between machines is the notes,
  not Obsidian's settings. The per-device ignore rules stay in every realm's `.gitignore`
  (`classes` ignores `.obsidian/` wholesale), so a realm that ever holds an `.obsidian`
  still keeps its session state out.
- **Why.** `workspace.json` changes on every session and is the top source of spurious
  conflicts ([obsidian-git docs](https://publish.obsidian.md/git-doc/Tips-and-Tricks),
  [maintainer](https://github.com/Vinzent03/obsidian-git/discussions/709)).
- **Tests.** Unit: `git check-ignore` on each path in a scratch repo. Live: after one
  Obsidian session at the new path, `git status --porcelain` in each realm is empty
  (runbook step 10).
- **Done when.** Opening and closing Obsidian produces no diff in either realm (true by
  construction once `.obsidian` is outside both; the live check confirms it).

### R-A3 Names that one platform rejects are refused before they are committed
- **Requirement.** The sync commit step refuses (and reports) any path containing
  `< > : " | ? *`, ending in a space or period, matching a Windows device name (`CON`,
  `NUL`, `COM1`…, with or without extension), or not in Unicode NFC. Case-only renames are
  documented as a two-step `git mv`.
- **Why.** Git for Windows refuses such paths at checkout (`core.protectNTFS`), which blocks
  the whole pull on the other machine; NFD names committed from macOS "can only be fixed by
  removing and re-adding" ([Microsoft](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file),
  [makandra](https://makandracards.com/makandra/17827-git-mac-working-unicode-filenames)).
  The homelab is a MacBook, so this will happen.
- **Tests.** Unit: a table of bad names → refused with the reason; good names including
  accented NFC pass. Live: the scan over both realms reports zero today (measured).
- **Done when.** The scan is part of `sync-realms.mjs --push`, exit 2 on a hit, and the
  rule is in `docs/portable.md`.

### R-A4 Attachments have a size ceiling and a home
- **Requirement.** A file over 25 MB is refused by the commit step; anything over 5 MB is
  reported. Attachments live under `<realm>/attachments/` and nothing else non-markdown is
  committed except `.obsidian` settings and the markers.
- **Why.** GitHub rejects >100 MB and one such commit blocks every later push until history
  is rewritten ([obsidian-git #248](https://github.com/denolehov/obsidian-git/issues/248)).
  The vault holds one 4.9 MB `.pptx` today.
- **Tests.** Unit: refusal at 25 MB + 1 byte, report at 5 MB + 1. Live: the existing
  `.pptx` is reported, not refused, on the first push.
- **Done when.** `git ls-files -z | xargs -0 du -b | sort -rn | head -1` is under 25 MB in
  both realms and the ceiling is enforced in code.

## Phase B — unattended sync that cannot make a mess

### R-B1 Commit first, then merge-pull, then push; never rebase, never autostash
- **Requirement.** `sync-realms.mjs` runs, per realm: stage → commit → `git pull --no-rebase
  --ff --no-autostash --no-edit` → push. A merge that conflicts is `git merge --abort`ed and reported (exit 2);
  the local commit stays; nothing is forced. `--pull` alone is the same sequence without push.
- **Why.** git's own docs mark `--autostash` "use with care: the final stash application …
  might result in non-trivial conflicts", leaving a rebased HEAD plus a stash to pop by hand
  ([git-rebase](https://git-scm.com/docs/git-rebase)); obsidian-git's backup order is
  commit-pull-push for this reason. **This replaces what `sync-realms.mjs` does today.**
- **Tests.** Unit: scripted git asserts the exact sequence and that no `rebase`, `--force`
  or `stash` argument ever appears. Real git: A and B both commit to the same file; B's pull
  aborts, B's commit and tree survive, `.git/MERGE_HEAD` is absent afterwards.
- **Done when.** Both tests pass. The nightly check, one `committed -> pulled -> pushed`
  line per realm in this machine's log for three consecutive nights, is made after R-C3 and
  before Phase D (decision 4). The arrow is ASCII because the PowerShell job decodes node's
  output as the OEM code page.

### R-B2 Stage explicit paths, never `-A`
- **Requirement.** The commit step stages `-- ':(glob)**/*.md' ':(glob).obsidian/*.json'
  attachments/ .realm .gitignore .gitattributes` and nothing else; deletions of those paths
  are staged too (`git add --all -- <pathspecs>`). `:(glob)` keeps `.obsidian/*.json` from
  reaching `.obsidian/plugins/x/data.json`. Only the pathspecs that match at least one path
  are passed, because `git add` exits 128 and stages nothing when any pathspec matches
  nothing (a realm without `attachments/`, say).
- **Why.** `git add -A` cannot tell whose changes it is taking when Obsidian or the hook
  writes during the run ([write-up](https://picklog.cc/blog/git-auto-commit-cron)); a stray
  file dropped into the vault must not travel.
- **Tests.** Unit: a `.env`-like stray file in the realm is not staged. Real git: the same.
- **Done when.** `git show --stat HEAD` of a nightly commit lists only allowed paths.

### R-B3 One writer at a time per realm
- **Requirement.** `sync-realms.mjs` takes a lock file (`.git/harness-sync.lock` with the PID
  and a timestamp; stale after 30 min) and exits 2 if it is held; the nightly script never
  overlaps with the twice-daily checkpoint collector on the same realm. The checkpoint
  collector takes the same lock per realm and defers that realm's notes when it is held.
- **Why.** Overlapping scheduled runs interleave stage/commit and corrupt the index
  ([git-dirsync design](https://github.com/deweysasser/git-dirsync)).
- **Tests.** Unit: second invocation with a fresh lock exits 2; a 31-minute-old lock is taken
  over and logged. Live: run the sync twice concurrently by hand; one refuses.
- **Done when.** Both tests pass and the schedule (03:00 nightly; 12:00/18:00 collector) is
  recorded with the lock rule in `docs/portable.md`.

### R-B4 Identity and credentials come from the job, not from luck
- **Requirement.** The nightly job sets `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL`
  from `HARNESS_MACHINE` and a configured email, sets `GCM_INTERACTIVE=never`, and fails
  closed (exit 2, logged) when a push needs a credential it cannot get.
- **Why.** Task Scheduler and SDK workers run with a different HOME and die with "Committer
  identity unknown" ([discussion](https://github.com/orgs/community/discussions/50235)); GCM's
  Windows store is per-user and hangs on a prompt nobody sees
  ([GCM env](https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/environment.md)).
  On the VM: a fine-grained PAT scoped to the two realm repos with an expiry, not a deploy key.
- **Tests.** Unit: the spawn env passed to git carries the four variables and
  `GCM_INTERACTIVE`. Live: unregister the machine's stored credential, run `--push`, observe
  exit 2 within 30 s and a clear log line; restore and observe a push. The live test moves
  with the nightly check, after R-C3 and before Phase D (decision 4).
- **Done when.** The nightly log shows the commit author as `<machine> <email>` and a
  credential-less run terminates in under 30 s.

## Phase C — the relocation itself

### R-C1 Copy, verify by content, only then cut over
- **Requirement.** The vault leaves OneDrive entirely (decision 5). It is copied (never
  moved) from OneDrive twice: to `~/vault` (`C:\Users\estac\vault`, the new working
  vault) and to a read-only local archive outside OneDrive,
  `C:\Users\estac\vault-archive-2026-09-23`. Each copy is compared with the source by a
  SHA-256 listing of every file and must be identical. Only then is the OneDrive folder
  unticked in Settings › Account › Choose folders, which removes the local OneDrive copy
  and keeps the cloud copy until R-F2. The 21-day safety copy is the local archive, not
  the OneDrive folder. Nothing under OneDrive is written or deleted by the runbook; the
  untick is the only OneDrive action, and Stack does it.
- **Why.** OneDrive corrupts `.git` in place and Microsoft declined the issue
  ([TechCommunity](https://techcommunity.microsoft.com/discussions/onedriveforbusiness/onedrive-is-corrupting-my-git-repositories/3898283));
  "Always keep on this device" first, because a placeholder copies as zero bytes, and an
  unticked folder is removed from the device while it stays available online
  ([Microsoft](https://support.microsoft.com/en-us/onedrive/choose-which-onedrive-folders-you-want-to-sync-on-windows-or-macos)).
  That removal is why the safety copy has to be a separate local archive: once the folder
  is unticked there is no OneDrive copy on this PC to fall back to.
- **Tests.** Dry run: `robocopy /L` shows 762 files, for each destination. (This doc first
  said 621 + `.obsidian`; the vault grew between 2026-09-22 and the 2026-09-23
  measurement: 762 files, 66 folders, 8.9 MB, 754 `.md`, 7 under `.obsidian`.) Live:
  `scripts/verify-copy.ps1 -Source <OneDrive vault> -Destination <copy>`, run once for
  `C:\Users\estac\vault` and once for the archive, hashes every file on both sides with
  SHA-256 (`.git` excluded by default, so it can be re-run after the realms exist) and
  prints the first mismatch (`missing in destination:`, `hash differs:`,
  `extra in destination:`, exit 1) or `identical (<n> files, <bytes> bytes, SHA256, <s> s)`
  (exit 0); exit 2 on a bad argument. It is proved on the rehearsal copy first, including
  one deliberately altered byte. `attrib` shows `R` on the archive. After the untick,
  `Test-Path` on the OneDrive vault is `False`, or finds only an empty folder stub.
- **Done when.** Two `identical (762 files, …)` lines (working vault, archive), `attrib`
  shows `R` on the archive, the folder is unticked in OneDrive, and the rollback section
  (R-C4) exists. Runbook steps 2-3 in `docs/portable.md`.

### R-C2 Realms initialised from the copy, first commit is the whole history baseline
- **Requirement.** `~/vault/projects` and `~/vault/classes` each get `.realm`, R-A1/R-A2
  files, `git init -b main`, one commit, and a **new** private remote
  (`emstacho-su/vault-projects`, `emstacho-su/vault-classes`). `emstacho-su/vault` (May
  2026, old layout) is archived, not reused. Both realms are `push` (decision 3), so both
  remotes are created and pushed in this phase. Before the baseline, the one non-markdown
  file is moved to `classes/attachments/ist466/Group 3 IST466.pptx` (decision 5), so the
  first commit already carries it where the sync will keep staging it.
- **Why.** Reusing the old repo would mix two histories and two layouts under one name.
- **Tests.** Unit and real git: `hooks/init-realm.mjs` (dry run writes nothing; one commit;
  every `.md` `i/lf`; a stray `.env` untracked and named; an NFD name refused with no
  commit; `.gitattributes` in the first commit; a second run refused; `--remote` sets
  origin without pushing). Dry run: `node hooks/init-realm.mjs --vault <dir> --realm <name>
  --dry-run` lists the three policy files it would write, the staged path count with a
  sample, any `not staged:` lines, and the commit it would make. Live: `git log --oneline
  | wc -l` is 1 in each; `gh repo view` shows both remotes private; `git fsck` clean.
- **Done when.** Both remotes exist, private, with one commit whose tree equals the copy
  (`git diff --stat HEAD` empty), and `emstacho-su/vault` is archived. Runbook steps 4-6.

### R-C3 The machine file and the tools point at the new vault
- **Requirement.** `~/.harness/machine.env` names `HARNESS_VAULT=C:/Users/estac/vault`,
  `HARNESS_REALMS=projects:push,classes:push`, `HARNESS_MACHINE=home-pc`,
  `HARNESS_GIT_EMAIL=emstacho@syr.edu` and `HARNESS_INGEST_PROJECT`; `DATABASE_URL` stays
  in the repo `.env`. The hook is reinstalled; both scheduled tasks are re-registered, the
  nightly one first with `-RealmSync DryRun` and, after one clean night, with
  `-RealmSync Apply`; Obsidian opens the new path.
- **Why.** Every tier resolves the vault from the machine file now; the tasks captured the
  old path at registration time. A dry-run first night means the first unattended sync
  against real remotes changes nothing until its log has been read.
- **Tests.** `node hooks/doctor.mjs` is the evidence: the new vault, both realms on disk and
  listed, `realms unlisted` and `realms missing` none, `git email` set, and a
  `realm <name>` row per realm showing a git checkout with its origin, the commit count
  and no lock held. Obsidian: a known wikilink resolves; graph renders. Tasks:
  `Get-ScheduledTask` actions contain the new path (and `-RealmSync DryRun` on the first
  registration).
- **Done when.** Doctor output is clean, a session ended in a repo writes its note under
  `~/vault/projects/<collection>/sessions/` within a minute, and `claude mcp get rag` still
  shows Connected.

### R-C4 A written rollback, rehearsed once
- **Requirement.** `docs/portable.md` gains a rollback section: exact commands to re-point
  the machine file, tasks and Obsidian at the read-only local archive
  (`C:\Users\estac\vault-archive-2026-09-23`, R-C1), and how long each takes. It is rehearsed once on a scratch copy before cutover.
- **Why.** A rollback that exists only in someone's head is not a rollback
  ([rollback planning](https://softwaremodernizationservices.com/insights/data-migration-rollback-planning/)).
- **Tests.** Rehearsal (runbook step 0): follow the section verbatim against
  `C:\tmp\vault-rehearsal` with the paths swapped as the section lists (scratch machine
  file via `HARNESS_MACHINE_ENV`, throwaway task names), before cutover; every command
  runs; each step's time and the total recorded.
- **Done when.** The *Rollback* section in `docs/portable.md` exists with its timing table
  filled in from the rehearsal, and the rehearsal log
  (`~/.claude/hooks/rollback-rehearsal.log`) is linked.

## Phase D — the store stays correct

### R-D1 Every row gains its realm; the legacy sweep runs once, here, and never again
- **Requirement.** After R-C3 a full ingest tags every note (`metadata-updated` for all,
  `would-update` for none), then `--prune-legacy --dry-run` is inspected and run for real
  exactly once on this machine; afterwards `--prune-legacy` is not in any scheduled job.
- **Why.** The legacy bucket is unscoped; only the machine that owned the store before realms
  may sweep it (see `cli.py --prune-legacy`).
- **Tests.** Dry run first, both steps. Live: `select count(*) from rag.documents where
  source='obsidian' and not (metadata->'_ingest' ? 'realm')` is 0 afterwards; the note
  count equals the on-disk count of ingestable notes.
- **Done when.** That query returns 0, the eval still reads hit@3 ≥ 0.95 / negatives 5/5,
  and `--prune-legacy` appears in no task or script argument list.

### R-D2 Rebuilt embeddings are checked, not assumed
- **Requirement.** `ingest embed-check`: ten fixed texts with their reference vectors
  committed in `ingest/eval/embeddings.json`; the command embeds them on the current machine
  and asserts cosine ≥ 0.999 against each reference, exit 1 otherwise. Run once on every new
  machine before its first ingest; fastembed and onnxruntime stay pinned in `uv.lock`.
- **Why.** Same model, different CPU: `-1.8208287954330444` vs `-1.8208290338516235`
  ([ORT #5667](https://github.com/microsoft/onnxruntime/issues/5667)); the fastembed model is
  int8-quantized and dynamic quantization has produced inconsistent results across Xeon
  generations ([ORT #14642](https://github.com/microsoft/onnxruntime/issues/14642)). Last-digit
  drift is harmless for cosine ranking; a saturating kernel is not, and only a check tells
  them apart.
- **Tests.** Unit: scoring with a `FakeEmbedder` that returns the references passes, one
  perturbed by 0.05 fails. Live: passes on this machine; passes on the VM before R-E2.
- **Done when.** The command exists with tests, the reference file is committed from this
  machine, and both machines have a logged pass.

### R-D3 The local store is pinned, backed up by dump, and sized for HNSW
- **Requirement.** `db/docker-compose.yml` pins `pgvector/pgvector:0.8.6-pg17` (exact tag, the newest 0.8.x on Docker Hub today;
  not `pg17`), keeps the named volume (never a bind mount on a Windows drive), sets
  `maintenance_work_mem=512MB` and `shm_size: 1g`, and `scripts/backup-store.sh|ps1` runs
  `pg_dump -Fc` via `docker exec` to a path outside the Docker VHDX.
- **Why.** Bind mounts on NTFS fail Postgres' ownership checks and break on upgrades
  ([docker/for-win #445](https://github.com/docker/for-win/issues/445)); HNSW builds fall out
  of the 64 MB default and slow 4× ([pgvector README](https://github.com/pgvector/pgvector/blob/master/README.md));
  a volume copy is only consistent stopped, a dump is portable across majors.
- **Tests.** `docker compose config` shows the pinned tag and settings. Live on the VM:
  `db migrate` from empty shows 6 applied; a full ingest then `pg_dump`; restore into a
  second container and `select count(*)` matches.
- **Done when.** Dump-and-restore round-trips the count on the VM and the backup script is
  in the VM's schedule.

## Phase E — the second machine

### R-E1 Bring-up follows the runbook without improvisation
- **Requirement.** `docs/portable.md` "second machine" is followed on the VM as written;
  every deviation is recorded as a doc fix in the same PR.
- **Tests.** `node hooks/doctor.mjs` clean; `ingest db migrate --dry-run` → 0 pending after
  the first run; `ingest embed-check` passes (R-D2).
- **Done when.** Doctor, migrate and embed-check are all green on the VM and the runbook
  needed no un-recorded step.

### R-E2 The VM's realm reaches the hub and personal context reaches the VM
- **Requirement.** `work-vm` (policy `push`) exists on `emstacho-su/vault-work-vm`, private;
  `projects` is cloned read-only (policy `local`) if the supervisor allows; a note captured
  on the VM appears on the home PC after the next two nightly runs (VM push, home pull).
- **Tests.** Live: capture a session on the VM; next morning `ls ~/vault/work-vm/…` on
  the home PC shows it, and `search_context` at home finds its outcome.
- **Done when.** One note has made the round trip and the supervisor's answer on the
  `projects` clone is recorded in `docs/portable.md`.

### R-E3 Names the employer needs scrubbed never leave the VM
- **Requirement.** `HARNESS_REDACT_EXTRA` names a per-machine JSON file of extra patterns;
  the hook loads it, applies it after the built-in rules, and the redaction tests cover it.
  The file is listed in the VM's machine file and never committed.
- **Tests.** Unit: a pattern from the file redacts in prompts, commands and the Outcome
  section; a malformed file is logged and ignored. Live on the VM: a session mentioning a
  listed name produces a note with `[REDACTED]` in its place.
- **Done when.** The feature is merged with tests and the VM's file exists with the
  categories the supervisor named.

## Phase F — cutover smoke test, then the old copy goes

### R-F1 A scripted smoke test passes on the migrated home PC
- **Requirement.** `scripts/smoke.ps1`: doctor clean; one nightly run by hand exits 0 with
  all six step codes 0; `git log -1` on each realm is today's sync commit; `select count(*)`
  by realm matches on-disk notes; three `search_context` queries return the same top-3 ids
  as recorded before migration (`ingest eval --json` before/after, diff empty on `returned`).
- **Done when.** The script exits 0 and its output is attached to the migration PR.

### R-F2 The old copies are deleted only after the window
- **Requirement.** 21 days after R-F1, if no rollback was needed, both old copies are
  deleted: the vault folder in OneDrive online (web: Files › vault › Delete, then again
  from the Recycle bin, which otherwise keeps it) and the local archive
  `C:\Users\estac\vault-archive-2026-09-23` (R-C1). R-C4's rollback section is marked
  expired, because it re-points at that archive.
- **Done when.** The vault folder is gone from OneDrive online (Recycle bin included) and
  the local archive is gone from disk, and this doc and `docs/portable.md` say so with
  the date.

---

## Order and gates

| Phase | Blocks | Gate |
| --- | --- | --- |
| A | B | R-A1–A4 done in code and tests, on `main` |
| B | C | R-B1–B4 done in code, unit and real-git tests, on `main`; the three-night nightly check moves after Phase C (decision 4, 2026-09-23) |
| C | D | R-C1 identical copy, R-C2 remotes, R-C3 doctor clean, R-C4 rehearsed; then, before D, the checks Phase B deferred: three `committed -> pulled -> pushed` nights (R-B1) and the credential-less push test (R-B4) |
| D | E | R-D1 query returns 0, eval unchanged, R-D2 references committed |
| E | F | R-E1 green on the VM, R-E2 round trip |
| F | — | R-F1 script exit 0; R-F2 after 21 days |

## What this changes in code already on `main`
- `hooks/lib/realm-sync.mjs`: commit → merge-pull → push, explicit pathspecs, lock, name and
  size checks, identity env (R-A3, R-A4, R-B1–B4). The real-git test extends to cover each.
- `db/docker-compose.yml`: exact image tag, `maintenance_work_mem`, `shm_size` (R-D3).
- New: `hooks/init-realm.mjs`, `scripts/verify-copy.ps1`, `scripts/smoke.ps1`,
  `scripts/backup-store.*`, `ingest embed-check`, `HARNESS_REDACT_EXTRA` (R-C2, R-C1, R-F1,
  R-D3, R-D2, R-E3).

## Decisions (Stack, 2026-09-22)
1. `emstacho-su/vault` is **archived** in Phase C, not reused.
2. Unattended commits are stamped `<machine> <emstacho@syr.edu>` (the local git identity).
3. `classes` is a **push** realm, backed up to `emstacho-su/vault-classes`; classes and
   courses are the same thing, and the realm keeps the name `classes`.
   `HARNESS_REALMS=projects:push,classes:push` wherever this document said `classes:local`.
4. (2026-09-23) The Phase B gate is code, unit and real-git tests only: the current vault
   has no realms and no machine file, so a nightly run has nothing to sync. The three-night
   nightly check (R-B1 "done when") and R-B4's live credential test move to after Phase C,
   before Phase D. The sync and the checkpoint collector share one lock per realm, because
   the two tasks overlapped on a catch-up run on 2026-09-23 and the collector writes notes
   into realm folders. The commit email is the machine-file variable `HARNESS_GIT_EMAIL`
   (`emstacho@syr.edu` on the home PC).
5. (2026-09-23) `.obsidian` stays at the vault root, untracked, outside every realm.
   Obsidian keeps opening `C:\Users\estac\vault` as one vault (`projects/`, `classes/`,
   `daily/`, `templates/` side by side); what travels between machines is the notes in
   the two realms plus the store each machine rebuilds, and Obsidian settings play no part
   in that. R-A2 is amended to match; the `projects` `.gitignore` keeps its narrower rules,
   which are harmless. The `.pptx` moves to `classes/attachments/ist466/Group 3 IST466.pptx`
   at cutover, a plain file move before the baseline commit (runbook step 4). The vault
   leaves OneDrive entirely: the folder is unticked once both copies verify (unticking
   removes the local OneDrive copy, as Microsoft documents), and the 21-day safety copy is
   the read-only local archive `C:\Users\estac\vault-archive-2026-09-23`, not the OneDrive
   folder. At R-F2 both the OneDrive folder (online) and the archive are deleted. Phase C's
   code, tests and docs are built on Opus 5.5 subagents, one per commit, reviewed and
   committed in one PR.

Follow-ups, not in Phase B:
- `session-capture.mjs` and `sweep-transcripts.mjs` write into realms without taking the
  lock.
- `commit.gpgsign` is not overridden by the sync; a machine that signs commits needs its
  key usable without a prompt.

Decided for Phase C (was open): the one non-markdown file today (`classes/ist466/ethics-case/Group 3
IST466.pptx`, 4.9 MB) is not under `attachments/`, and R-B2's pathspecs would not stage
it. It moves to `classes/attachments/` at cutover (decision 5); the rule is not widened.
