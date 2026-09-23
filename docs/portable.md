# The harness on more than one machine

The harness used to assume one machine: a vault in OneDrive, one always-reachable
Supabase project, Windows Task Scheduler. It now runs on any machine that can run
Node, `uv` and git, with its own vault and its own Postgres, and moves notes
between machines by git. This page is the model and the runbooks.

## The model

```
realm  = one git repo of notes (projects, classes, work-vm, …). Unit of sync policy.
vault  = a machine's folder holding the realms it is allowed to have, side by side.
store  = that machine's Postgres: Supabase, or a local pgvector container.
hub    = wherever the realm remotes live: private GitHub repos today, a homelab later.
```

- **Only markdown travels.** Chunks and embeddings are derived; every machine rebuilds
  its own store from the notes it holds (one full `ingest`, minutes on CPU).
- **A realm is marked by a committed `.realm` file** holding its name, at the vault root
  (the whole vault is one realm) or in a top-level folder named after it. Notes outside
  every realm are skipped; a folder not named after its marker is refused.
- **Prune is scoped to realms.** A nightly `--prune` deletes only rows of the realms it
  just walked, so two machines sharing a store cannot delete each other's rows. Rows
  from before realms existed are swept only by `--prune-legacy`, on one machine.
- **Machine file.** `~/.harness/machine.env` says what this machine is:

  ```
  HARNESS_MACHINE=home-pc                          # written into every note as machine:
  HARNESS_VAULT=C:/Users/you/vault                 # the folder holding the realms
  HARNESS_REALMS=projects:push,classes:push        # realms this machine may hold, and whether each may leave it
  HARNESS_INGEST_PROJECT=C:/Users/you/agentic-harness/ingest
  DATABASE_URL=postgresql://harness:harness@localhost:5433/harness   # this machine's store
  DATABASE_SSL=disable                             # local Postgres only
  HARNESS_GIT_EMAIL=you@example.edu                # author/committer of unattended realm commits
  ```

  The hook, the sweep, the collector, the nightly scripts and `ingest` all read it; the
  shell always wins; the repo `.env` (secrets) wins over it too. `HARNESS_REALMS` is an
  allowlist: a realm on disk that it does not name stops the run.
- **Nightly:** commit and merge-pull every realm → sweep transcripts → collect
  checkpoints → conclude stale sessions → ingest with realm-scoped prune → commit,
  merge-pull and push the `push` realms. A merge that conflicts is aborted with the local
  commit kept and reported (exit 2). Nothing is ever forced, rebased or stashed; see
  *Sync, lock and schedule*.
- **Redaction** happens at write time on every machine; a `local` realm never leaves
  it; the VM's machine file never carries the Supabase URL.

`node hooks/doctor.mjs` prints what every tier resolved to. Run it before trusting a
new machine to the nightly job.

## Realm repo hygiene

Every realm repo is born with three committed files, written by
`hooks/lib/realm-init.mjs` (`writeRealmFiles(dir, name)`), and the first commit is
preceded by `git add --renormalize .`:

```
.realm            the realm's name; realm-sync keys on it
.gitattributes    * text=auto
                  *.md text eol=lf
.gitignore        .obsidian/workspace.json          (projects only — see below)
                  .obsidian/workspace-mobile.json
                  .obsidian/plugins/*/
                  .trash/
                  .DS_Store
                  Thumbs.db
```

- **Line endings are the repo's policy, not each machine's.** A committed
  `.gitattributes` overrides every contributor's `core.autocrlf`; markdown is LF in the
  index whatever a machine does on checkout. Check: `git ls-files --eol | grep '\.md' |
  grep -v 'i/lf'` prints nothing.
- **Per-device Obsidian state never enters git.** `workspace.json` changes every session
  and is the top source of spurious conflicts. `projects` is the one realm that tracks
  `.obsidian/*.json` settings (the vault root's `.obsidian` moves with it); every other
  realm ignores `.obsidian/` wholesale. Opening and closing Obsidian must leave
  `git status --porcelain` empty in every realm.
- **Names one platform rejects are refused before they are committed.** Before anything
  is staged, `sync-realms.mjs` (either mode) lists what `git add` would take and
  refuses the realm (exit 2, nothing staged, the path named) if any path contains
  `< > : " | ? *`, a backslash or a control character, has a segment ending in a space
  or a period, is a Windows device name (`CON`, `NUL`, `COM0`-`COM9`, `LPT0`-`LPT9`,
  with or without an extension), is not in Unicode NFC, or differs only by case from
  another path in the realm (one file on Windows and macOS, two on Linux).
  Git for Windows refuses such paths at checkout, which blocks the whole pull on the
  other machine; an NFD name committed from a Mac can only be fixed by removing and
  re-adding. A case-only rename is two steps, because Windows and macOS do not see the
  change: `git mv note.md note.tmp.md && git mv note.tmp.md Note.md`.
- **Attachments have a size ceiling and a home.** A file over 25 MiB is refused the same
  way: GitHub rejects over 100 MB and one such commit blocks every later push until
  history is rewritten. Anything over 5 MiB is reported on a `reported:` line but still
  committed; so is a path over 200 characters, which a default Git for Windows fails to
  check out once the vault prefix is added. Any non-markdown outside
  `<realm>/attachments/` other than the three policy files and `.obsidian/*.json` is not
  staged and is named on a `not staged:` line; move it into `attachments/` if it should
  travel. The rules live in `hooks/lib/realm-guard.mjs`. Deleting a note is an ordinary
  edit: it is staged as a deletion, never refused.

## Sync, lock and schedule

`hooks/sync-realms.mjs --pull` and `--push` run the same sequence per realm; `--pull`
stops before the push:

1. take the realm's lock, `<realm>/.git/harness-sync.lock`;
2. refuse if a merge or rebase is already in progress;
3. `git status --porcelain=v1 -z`, then the guard above over
   `git ls-files … -- <pathspecs>`;
4. `git add --all -- <pathspecs>`, then
   `git commit -m "harness: sync from <machine> <iso>"`;
5. `git pull --no-rebase --ff --no-autostash --no-edit`;
6. push mode and a `push` realm only: `git push origin HEAD:refs/heads/<branch>`.

The pathspecs are exactly `:(glob)**/*.md`, `:(glob).obsidian/*.json`, `attachments/`,
`.realm`, `.gitignore` and `.gitattributes`. Only the ones that match something are
passed, because `git add` exits 128 on a pathspec that matches nothing. Anything else in
the realm (a stray `.env`, a `.pptx` outside `attachments/`) is never staged and is named
on a `not staged:` line; a file someone staged by hand outside that set makes the sync
refuse the realm (exit 2) rather than commit it. A merge that conflicts is
`git merge --abort`ed and reported; the local commit stays, and nothing is forced,
rebased or stashed.

One line per realm, then one line per note:

```
projects: committed -> pulled -> pushed
classes: clean -> pulled -> up-to-date
projects: committed -> conflict (merge with origin/main conflicts in note.md; aborted, local commit kept)
projects: locked (held by sync --push, pid 4242, since 2026-09-23T03:00:05.000Z)
projects: reported: …
projects: not staged: …
projects: lock: taken over from pid …
projects: identity: git config (set HARNESS_MACHINE and HARNESS_GIT_EMAIL)
```

Exit 2 on a conflict, an error, a refusal or a held lock.

- **One writer per realm.** The lock file holds `{pid, owner, startedAt, token}`. The
  sync holds it for the whole sequence; the checkpoint collector holds it per realm while
  it writes notes there. A held lock makes the sync exit 2 and makes the collector defer
  that realm's notes to its next run (`deferred=N` in its summary, exit 0). A lock older
  than 30 minutes, more than three times the worst-case sync hold, is taken over and
  logged. A realm that is not a git checkout has no lock and is not synced.
- **Schedule.** 03:00 nightly (the sync runs at the start as `--pull` and at the end as
  `--push`); the collector at 12:00 and 18:00. `StartWhenAvailable` catch-up runs can
  land on top of each other, which happened on 2026-09-23; that is why the lock exists.
- **Identity and credentials.** `GIT_AUTHOR_*` and `GIT_COMMITTER_*` come from
  `HARNESS_MACHINE` and `HARNESS_GIT_EMAIL`; if either is unset, git's own config applies
  and the `identity:` note says so. Every git call runs with `GCM_INTERACTIVE=never` and
  `GIT_TERMINAL_PROMPT=0`, so a missing or expired credential is an exit-2 line
  containing the word `credential`, never a prompt nobody sees.

## Runbook: a second machine (the Windows dev VM)

1. Install per-user: Node 22+, `uv`, git, Claude Code, Docker Desktop.
2. Clone `agentic-harness` to `~/agentic-harness`; `uv sync` in `ingest/`,
   `npm ci && npm run build` in `mcp-server/`.
3. The store: `cd db && docker compose up -d`, then in `ingest/`
   `uv run ingest db migrate` with `DATABASE_URL` and `DATABASE_SSL=disable` in the
   machine file. `--dry-run` first: a fresh store shows 6 pending.
4. The vault: `mkdir ~/vault`, then clone the realms this machine may hold into it,
   e.g. `git clone <private remote>/work-vm ~/vault/work-vm` and, if permitted, a
   read-only clone of `projects`. Each clone already carries its `.realm`.
   A new realm: `mkdir ~/vault/work-vm && echo work-vm > ~/vault/work-vm/.realm`,
   `git init`, commit, add the private remote.
5. Write `~/.harness/machine.env` (above), including `HARNESS_GIT_EMAIL` so unattended
   realm commits carry this machine's name and your address. `node hooks/doctor.mjs`.
6. `node hooks/install.mjs --register-mcp` — copies the hook, registers it in
   `settings.json`, and registers the `rag` MCP server. The registration carries only
   the *path* to the repo `.env` (`HARNESS_ENV_FILE`); the server reads the secret
   itself at start. `claude mcp get` prints a server's env block in clear text, so a
   connection string must never be put there.
7. Register the nightly job: `powershell -File scripts/register-nightly-ingest.ps1`
   (reads the machine file). On Linux/macOS: cron or launchd running
   `scripts/nightly-ingest.sh`.
8. The push credential: create a fine-grained GitHub PAT scoped to the realm repos only
   (Contents: read and write) with an expiry, and store it once with
   `printf 'protocol=https\nhost=github.com\nusername=<user>\npassword=<PAT>\n' | git credential approve`.
   Put the expiry in the calendar: when it lapses the nightly log shows the `credential`
   line and nothing hangs, because the sync never lets git prompt.
9. The embedding model (130 MB) downloads on first use. On a machine without that
   egress, copy `~/.cache/fastembed` (Python) and `mcp-server/.fastembed-cache` (Node)
   from a machine that has them; the two layouts differ and both are needed.
10. Names to scrub beyond the built-in rules: see `hooks/lib/redact.mjs`; a per-machine
   extra-rules file is on the roadmap, not built yet.

## Runbook: migrating the home vault into realms

The home vault today: `OneDrive - Syracuse University/vault/{projects,classes,daily,templates}`,
no git. Git and OneDrive on the same folder corrupt each other (`CONTEXT.md`), so the
realms move out of OneDrive; the git remotes become the backup.

1. Stop the scheduled tasks for the duration (`Unregister` flag on both register scripts,
   or disable them in Task Scheduler).
2. `mkdir ~/vault`; move `projects/` and `classes/` there (`.obsidian/` too, so Obsidian
   keeps its settings); `daily/` and `templates/` stay wherever you like — they are
   outside every realm and are not ingested.
3. In each of `~/vault/projects` and `~/vault/classes`: the three policy files
   (`writeRealmFiles`, see *Realm repo hygiene*), `git init -b main`, `git add .`,
   `git add --renormalize .`, commit, `git remote add origin <private GitHub repo>`,
   `git push -u origin main`. Phase C of `vault-migration-requirements.md` scripts this.
   The nightly sync stages with the pathspecs in *Sync, lock and schedule*, not
   `git add .`, so this first hand-made `git add .` belongs after the policy files are in
   place (the `.gitignore` is what keeps workspace state out). A `.pptx` outside
   `attachments/` shows as `not staged:` on every later sync until it is moved there.
4. Write `~/.harness/machine.env` with `HARNESS_VAULT=C:/Users/<you>/vault`,
   `HARNESS_REALMS=projects:push,classes:push`, `HARNESS_MACHINE=home-pc`.
   `DATABASE_URL` stays in the repo `.env`.
5. Open the new folder in Obsidian.
6. `uv run ingest --source obsidian --path C:/Users/<you>/vault --dry-run`: every note
   should show `metadata changed` (it gained `_ingest.realm`) and nothing `would-update`.
   Then the real run; then `--dry-run --prune-legacy` and inspect: it lists exactly the
   rows for notes that no longer exist on disk. Then `--prune-legacy` for real, once.
7. `node hooks/install.mjs` (the hook reads the machine file now), re-register the
   scheduled tasks. `node hooks/doctor.mjs` should show both realms listed and on disk.

## Homelab, later

Host bare realm repos and a pgvector Postgres on the MacBook. On each machine, point the
realm remotes at it (`git remote set-url origin …`) and `DATABASE_URL` in the machine
file. Nothing in the code changes.

## Out of scope, on purpose

A second search implementation (SQLite): the same `rag.search` runs on every Postgres.
Syncing embeddings: cheaper to rebuild than to move. A dev-container image: the VM
replaces that need.
