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
  `.obsidian/plugins/*/` cache directory; `.obsidian/*.json` settings are tracked in the
  `projects` realm only (the vault root's `.obsidian` moves with it).
- **Why.** `workspace.json` changes on every session and is the top source of spurious
  conflicts ([obsidian-git docs](https://publish.obsidian.md/git-doc/Tips-and-Tricks),
  [maintainer](https://github.com/Vinzent03/obsidian-git/discussions/709)).
- **Tests.** Unit: `git check-ignore` on each path in a scratch repo. Live: after one
  Obsidian session at the new path, `git status --porcelain` in each realm is empty.
- **Done when.** Opening and closing Obsidian produces no diff in either realm.

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
  --no-edit` → push. A merge that conflicts is `git merge --abort`ed and reported (exit 2);
  the local commit stays; nothing is forced. `--pull` alone is the same sequence without push.
- **Why.** git's own docs mark `--autostash` "use with care: the final stash application …
  might result in non-trivial conflicts", leaving a rebased HEAD plus a stash to pop by hand
  ([git-rebase](https://git-scm.com/docs/git-rebase)); obsidian-git's backup order is
  commit-pull-push for this reason. **This replaces what `sync-realms.mjs` does today.**
- **Tests.** Unit: scripted git asserts the exact sequence and that no `rebase`, `--force`
  or `stash` argument ever appears. Real git: A and B both commit to the same file; B's pull
  aborts, B's commit and tree survive, `.git/MERGE_HEAD` is absent afterwards.
- **Done when.** Both tests pass and the nightly log on this machine shows one
  `committed → pulled → pushed` line per realm for three consecutive nights.

### R-B2 Stage explicit paths, never `-A`
- **Requirement.** The commit step stages `-- '*.md' '.obsidian/*.json' attachments/
  .realm .gitignore .gitattributes` and nothing else; deletions of those paths are staged
  too (`git add --all -- <pathspecs>`).
- **Why.** `git add -A` cannot tell whose changes it is taking when Obsidian or the hook
  writes during the run ([write-up](https://picklog.cc/blog/git-auto-commit-cron)); a stray
  file dropped into the vault must not travel.
- **Tests.** Unit: a `.env`-like stray file in the realm is not staged. Real git: the same.
- **Done when.** `git show --stat HEAD` of a nightly commit lists only allowed paths.

### R-B3 One writer at a time per realm
- **Requirement.** `sync-realms.mjs` takes a lock file (`.git/harness-sync.lock` with the PID
  and a timestamp; stale after 30 min) and exits 2 if it is held; the nightly script never
  overlaps with the twice-daily checkpoint collector on the same realm.
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
  exit 2 within 30 s and a clear log line; restore and observe a push.
- **Done when.** The nightly log shows the commit author as `<machine> <email>` and a
  credential-less run terminates in under 30 s.

## Phase C — the relocation itself

### R-C1 Copy, verify by content, only then cut over
- **Requirement.** The vault is copied (never moved) from OneDrive to `~/vault`, then a
  SHA-256 listing of every file on both sides is compared and must be identical; the old
  copy is marked read-only and stays for 21 days; OneDrive stops syncing the folder via
  Settings › Choose folders, not by deleting it.
- **Why.** OneDrive corrupts `.git` in place and Microsoft declined the issue
  ([TechCommunity](https://techcommunity.microsoft.com/discussions/onedriveforbusiness/onedrive-is-corrupting-my-git-repositories/3898283));
  "Always keep on this device" first, because a placeholder copies as zero bytes
  ([Microsoft](https://support.microsoft.com/en-us/onedrive/choose-which-onedrive-folders-you-want-to-sync-on-windows-or-macos)).
- **Tests.** Dry run: `robocopy /L` shows the file count (621 + `.obsidian`). Live: hash
  listings match (script committed as `scripts/verify-copy.ps1`, prints the first mismatch or
  `identical`); `attrib` shows `R` on the old tree.
- **Done when.** `verify-copy.ps1` prints `identical`, the old folder is read-only, the
  folder is unticked in OneDrive, and the rollback note (R-C4) is written.

### R-C2 Realms initialised from the copy, first commit is the whole history baseline
- **Requirement.** `~/vault/projects` and `~/vault/classes` each get `.realm`, R-A1/R-A2
  files, `git init -b main`, one commit, and a **new** private remote
  (`emstacho-su/vault-projects`, `emstacho-su/vault-classes`). `emstacho-su/vault` (May
  2026, old layout) is archived, not reused. Both realms are `push` (decision 3), so both
  remotes are created and pushed in this phase.
- **Why.** Reusing the old repo would mix two histories and two layouts under one name.
- **Tests.** Dry run: `hooks/init-realm.mjs --dry-run` lists the files it would write and
  the commit it would make. Live: `git log --oneline | wc -l` is 1 in each; `gh repo view`
  shows both remotes private; `git fsck` clean.
- **Done when.** Both remotes exist, private, with one commit whose tree equals the copy
  (`git diff --stat HEAD` empty after `git add` of allowed paths).

### R-C3 The machine file and the tools point at the new vault
- **Requirement.** `~/.harness/machine.env` names `HARNESS_VAULT=C:/Users/estac/vault`,
  `HARNESS_REALMS=projects:push,classes:push`, `HARNESS_MACHINE=home-pc`; the hook is
  reinstalled; both scheduled tasks are re-registered; Obsidian opens the new path.
- **Why.** Every tier resolves the vault from the machine file now; the tasks captured the
  old path at registration time.
- **Tests.** `node hooks/doctor.mjs` shows the new vault, both realms on disk and listed,
  no `unlisted`. Obsidian: a known wikilink resolves; graph renders. Tasks: `Get-ScheduledTask`
  actions contain the new path.
- **Done when.** Doctor output is clean, a session ended in a repo writes its note under
  `~/vault/projects/<collection>/sessions/` within a minute, and `claude mcp get rag` still
  shows Connected.

### R-C4 A written rollback, rehearsed once
- **Requirement.** `docs/portable.md` gains a rollback section: exact commands to re-point
  the machine file, tasks and Obsidian at the read-only OneDrive copy, and how long each
  takes. It is rehearsed once on a scratch copy before cutover.
- **Why.** A rollback that exists only in someone's head is not a rollback
  ([rollback planning](https://softwaremodernizationservices.com/insights/data-migration-rollback-planning/)).
- **Tests.** Rehearsal: follow the section verbatim against `C:/tmp/vault-rehearsal`;
  every command runs; total time recorded.
- **Done when.** The section exists with recorded timings and the rehearsal log is linked.

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

### R-F2 The read-only OneDrive copy is deleted only after the window
- **Requirement.** 21 days after R-F1, if no rollback was needed, the OneDrive copy is
  deleted and R-C4's rollback section is marked expired.
- **Done when.** The folder is gone from OneDrive and the doc says so with the date.

---

## Order and gates

| Phase | Blocks | Gate |
| --- | --- | --- |
| A | B | R-A1–A4 done in code and tests, on `main` |
| B | C | R-B1–B4 done; three clean nightly runs on the **current** vault (sync in dry-run mode) |
| C | D | R-C1 identical copy, R-C2 remotes, R-C3 doctor clean, R-C4 rehearsed |
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

Open for Phase C: the one non-markdown file today (`classes/ist466/ethics-case/Group 3
IST466.pptx`, 4.9 MB) is not under `attachments/`; R-A4's guard reports it, and R-B2's
pathspecs would not stage it. Move it to `classes/attachments/` at cutover, or widen the rule.
