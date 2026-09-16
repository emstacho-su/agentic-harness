# `hooks/` — session capture

One Claude Code session becomes one markdown note in the Obsidian vault, so the
RAG store can answer questions about work that already happened.

The source of truth is this directory. `~/.claude/hooks/` holds a byte-identical
deployed copy, installed by `node hooks/install.mjs`. Edit here, install, never
the other way round.

```
hooks/
├── session-capture.mjs     the SessionEnd hook: stdin in, one note out
├── install.mjs             deploy to ~/.claude/hooks, verified by hash
├── migrate-sessions.mjs    one-time: v1 notes -> schema v2, right collection
├── untagged-sessions.mjs   the weekly `unclassified` review list
├── lib/                    one concern per file, no dependencies
└── tests/                  node --test, fixtures and golden notes
```

## What it writes

Two events, one entry point:

| Event | Note | Named |
| --- | --- | --- |
| `SessionEnd` | the session | `<session_id>.md` |
| `SubagentStop` | one worker | `<session_id>--<agent_id>.md` |

**One note per session**, named by the full session id, rewritten on every
`SessionEnd` — and one note per subagent beside it. The double dash cannot occur
inside either half (a session id is a UUID, an agent id is hex), so the pair is
unambiguous and a worker sorts next to the session that spawned it.

Frontmatter is schema v2 (`schema_version: 2`). The field names are frozen: the
retrieval side filters on them, so renaming one is a breaking change. Every
field is present on every note; a field that could not be derived is the **empty
string or an empty list**, never absent and never guessed.

| Group | Fields |
| --- | --- |
| Identity | `id`, `title`, `type`, `schema_version`, `session_id`, `date` |
| Location | `collection`, `collection_source`, `cwd`, `cwds_seen` |
| Lifecycle | `status`, `concluded_at`, `end_reason`, `supersedes`, `resumed_from` |
| Git | `repo`, `branch`, `worktree`, `repos_touched`, `commits`, `prs` |
| Context | `phase`, `tags`, `parent_session`, `child_sessions` |
| Work | `memory_files`, `plan_file`, `docs_touched`, `artifacts`, `files_modified` |
| Volume | `duration_minutes`, `prompt_count`, `command_count`, `tools_used` |

`id` is `session-<session_id>`, which is the `external_id` ingest keys on. It
never changes, so a note that moves does not strand its row.

## The four rules

1. **Never block session exit.** Budget 1,200 ms inside SessionEnd's ~1.5 s.
   Everything optional checks the deadline first; the elapsed time is logged on
   every run. `tests/budget.test.mjs` holds it to that over 18 MB of transcript.
2. **Never fail loudly.** Every path exits 0. Failures go to
   `~/.claude/hooks/session-capture.log` and nowhere else.
3. **Never write a credential.** Only prompts and tool *inputs* reach the note,
   both through `lib/redact.mjs`. The two narrow exceptions that read tool
   output — a PR number and an artifact URL — are documented at
   `scanToolResults` and keep one capture group each.
4. **Never write an empty note.** No user prompts means nothing to remember.

## Collection: the repository, not the folder

`bb2dash-wt-sl` is a worktree, not a project. The collection is resolved in
three steps:

1. a path segment that names an existing folder under `vault/classes/` →
   `classes/<course id>`, `collection_source: folder`;
2. the git remote of `cwd`, resolved through a worktree to its main repository →
   `projects/<repo slug>`, `collection_source: git`;
3. the folder name, preferring an ancestor that already owns a vault folder →
   `collection_source: folder`.

Step 2 reads `.git/config` and `.git/HEAD` directly rather than shelling out:
`git` costs 50–150 ms per invocation on Windows and can hang on a network path.
The only subprocess is one bounded `git log` for `commits`, and it is skipped
entirely when the clock is short.

That subprocess goes through `lib/spawn.mjs`, which exists for one reason:
`execFileSync('git', …, { cwd: repoRoot })` resolves the program against the
child's working directory **before `PATH`** on Windows, so a `git.exe` sitting
in a checkout root would run at session exit with output swallowed and the
window hidden. The repository is therefore passed as `git -C <path>` and the
process starts in the user's home directory with
`NoDefaultCurrentDirectoryInExePath` set.

## Merge, never rewrite

Stack edits these notes. The hook therefore reads the note back, merges, and
writes:

- **lists grow** — a tag, commit or PR in the note stays in the note;
- **scalars only improve** — a derived value replaces an empty one, never the
  reverse;
- **`status` ratchets** — `active` → `concluded` → `superseded`, one way.

A note whose frontmatter will not parse is **not written**. Refusing is the only
safe answer to "somebody hand-edited this into a shape I do not understand".

### Subagents

A worker launched with the Agent tool does real work but shares its parent's
`session_id` and never fires `SessionEnd`, so its edits used to disappear into
the parent's note as a handful of file paths. `SubagentStop` gives it a note of
its own, with `parent_session` set to the session that spawned it and
`agent_type` recording what kind of worker it was. Collection, branch, tags and
redaction are the session rules applied unchanged.

The link holds whichever order the events arrive in, and both orders really
happen:

- **worker stops first** (the usual case) — the parent's own `SessionEnd`
  back-fills `child_sessions` by reading the `subagents/` directory;
- **worker stops after the parent was captured** — the `SubagentStop` run merges
  the child into the parent note's `child_sessions`.

`child_sessions` holds the **child note ids** (`session-<session_id>--<agent_id>`),
which are the ingest `external_id`s, so a search follows the link straight to the
worker's own note.

A worker is captured when it has a prompt **or** any tool use: some are handed
their task entirely through the parent's `Agent` call, and for those the task
text comes from the `agent-<id>.meta.json` file beside the transcript. A worker
with no transcript on disk is skipped — Claude Code does not persist one for
every agent, and no transcript means no note.

### Resume chains

| What happened | What the hook does |
| --- | --- |
| `SessionEnd` with `reason: resume` | note stays `active` |
| any other reason | note becomes `concluded`, `concluded_at` set |
| a stale `SessionEnd` replayed over a concluded note | **nothing at all** |
| real new activity after the note concluded | a new `<id>-r2.md`, with `resumed_from` and `supersedes`; the earlier note becomes `superseded` |

The chain walks both ways: backwards by following `resumed_from`, forwards by
filtering for the note whose `resumed_from` names this one.

## Tags

`docs/tags.md` is the controlled vocabulary and the only place new terms are
added. At most five hook-applied tags; manual tags are uncapped and never
removed. A session the classifier cannot place gets exactly
`tags: [unclassified]` and shows up in:

```bash
node hooks/untagged-sessions.mjs --vault "C:/Users/estac/OneDrive - Syracuse University/vault"
```

## Running it

```bash
cd hooks && npm test          # node --test, no dependencies
npm run goldens               # regenerate the approval fixtures, then read the diff
node install.mjs --dry-run    # what would change in ~/.claude/hooks
node install.mjs              # copy, then verify every file by SHA-256
```

The installer also registers the hook for `SessionEnd` and `SubagentStop` in
`~/.claude/settings.json`. That file is the user's — permissions, model,
plugins, other tools' hooks — so the write is a read-merge-write that touches
only those two events, keeps an existing entry's own `timeout` and
`statusMessage`, and changes nothing on a second run. It writes through a
temporary file and renames, because a half-written `settings.json` is read by
every session.

It registers `~/.claude/hooks/session-capture.mjs`, never a worktree path:
a worktree gets deleted, and a hook that goes with it takes every future
session's note along. `--target` without a matching `--settings` is refused for
the same reason; `--skip-settings` deploys the files alone.

Environment:

| Variable | Effect |
| --- | --- |
| `HARNESS_VAULT` | vault root; the tests use it to stay out of the real one |
| `HARNESS_SESSION_CAPTURE` | `0`/`off`/`false`/`no` disables the hook |
| `HARNESS_SESSION_CAPTURE_LOG` | log destination |
| `HARNESS_PARENT_SESSION` | records the session that spawned this one |

`HARNESS_PARENT_SESSION` exists because Agent-tool subagents share their
parent's `session_id` and never fire `SessionEnd` of their own. A worker run as
a separate `claude` process is the only kind that gets its own note, and this is
how it says who spawned it. When the transcript itself lives under
`<parent>/subagents/`, `parent_session` is derived from the path instead.

## The one-time migration

```bash
node hooks/migrate-sessions.mjs --vault "<a copy of the vault>" --dry-run   # rehearse
node hooks/migrate-sessions.mjs --vault "<the vault>" --backup "<scratch>"  # then run
```

Moves every v1 note to `<session_id>.md` in the collection its `cwd` resolves
to, back-fills `branch` / `commits` / `prs` / `phase` from `git log` and
`gh pr list` over the session's window, and retires the folders in
`COLLECTION_OVERRIDES` once they are empty. A move that would overwrite is
refused. It never runs `ingest`.

Checkouts that no longer exist are handled by an explicit table in
`lib/migrate.mjs` — `bb2dash-retrieval → bb2dash` — because nothing on disk can
resolve them and inferring a project from a folder name is exactly the bug this
stream exists to fix.

## Tests

`npm test` runs 163 tests with no dependencies and no network:

| File | What it holds |
| --- | --- |
| `golden.test.mjs` | six fixtures render byte-exact notes; schema field order |
| `resume.test.mjs` | end → stale replay → resume, and the manual tag surviving |
| `redaction.test.mjs` | a credential-seeded fixture, plus each rule |
| `budget.test.mjs` | < 1,200 ms over 18 MB, with the real `git log` |
| `migrate.test.mjs` | the migration, its dry run, and its refusals |
| `tags.test.mjs` | every tag is in `docs/tags.md`, or exactly `unclassified` |
| `hook-process.test.mjs` | the real process: exit 0, a log line, the W-H2 seam |
| `spawn.test.mjs` | `git` and `gh` never resolve against a directory a repository controls |
| `subagent.test.mjs` | a worker's note, and the parent link in both event orders |
| `settings.test.mjs` | the settings merge keeps every key and hook it does not own |
| `unc.test.mjs` | no path that resolves onto another host is ever touched |
| `install.test.mjs` | the deploy payload is exactly the hook's transitive imports |
| `enqueue-ingest.test.mjs` | the detached `ingest --only` start: argv array, absolute `uv`, kill switch, never throws |

The golden notes are approval tests. When one changes, read the diff: it is a
change to what `ingest` stores and what retrieval can filter on.

---

## Ingest on capture

`SessionEnd` hooks share a ~1.5 s budget, and `session-capture.mjs` keeps
itself inside 1,200 ms of it. A vault ingest loads a 130 MB ONNX model and
opens a TLS connection to Postgres — seconds of work. So the hook does not run
the ingest. It starts one and returns.

```
SessionEnd
  └─ session-capture.mjs writes vault/projects/<c>/sessions/<id>.md
       └─ enqueueIngest()  ~10 ms
            └─ detached: uv --directory <project> run ingest
                          --source obsidian --path <vault> --only <note>
                 └─ stdout + stderr -> ~/.claude/hooks/ingest-on-capture.log
```

Three properties make that safe to do on session exit:

- **Detached and unreferenced.** `spawn(..., { detached: true })` followed by
  `child.unref()` lets Node exit while the child keeps running. Its output goes
  to a log file rather than a pipe, because an unread pipe buffer would tie the
  parent's lifetime back to the child.
- **An argument array, never a shell string.** The note path is derived from the
  session's working directory and can contain anything. It is passed as one
  element of an `argv` array with `shell: false`, so no quoting rule can turn a
  filename into a command. There is a test that enqueues a note literally named
  ``a b & rm -rf $(x) `y`.md``.
- **`uv` is always an absolute path, and the child is given no `cwd`.** On
  Windows, libuv resolves a command name with no directory separator against the
  child's working directory *before* it looks at `PATH` — so spawning a bare
  `uv` with `cwd` set to the project directory would let a `uv.exe` dropped in
  there win over the real one, and `shell: false` does not help (it stops the
  shell re-parsing arguments, which is a different problem). `resolveUv` returns
  the standalone install, else an explicit `PATH` search, else **null** and a
  `NO_UV` refusal; the project is passed with `uv --directory` instead. There is
  an `isAbsolute` check immediately before the spawn so the invariant cannot be
  lost in a later edit.
- **It cannot throw.** Every path returns a result object and logs the reason.
  A capture hook that raises on session exit is worse than no capture hook.

The enqueue refuses, and says so in `session-capture.log`, when the note is
outside the vault, is not markdown, or when the ingest project directory does
not exist. `ingest --only` re-validates all of it on the other side.

### What it costs

Measured on this machine, calling `enqueueIngest` against the live vault:

| | ms |
| --- | ---: |
| Warm (`uv.exe` already in the OS image cache) | 9 – 16 |
| First spawn after a reboot | ~2,800 |

The warm number is the one that matters and it is comfortably inside the hook's
1,200 ms deadline. The cold number is Windows validating `uv.exe` on
`CreateProcess`, which is charged to the caller — so the first session ended
after a reboot can see a noticeably slower exit. If that ever becomes annoying,
`HARNESS_INGEST_ON_CAPTURE=0` turns the enqueue off and the nightly reconcile
picks the note up instead.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HARNESS_INGEST_ON_CAPTURE` | on | `0`, `false`, `off` or `no` disables the enqueue |
| `HARNESS_INGEST_PROJECT` | `~/agentic-harness/ingest` | The uv project to run `ingest` from |
| `HARNESS_UV_BIN` | `~/.local/bin/uv.exe`, else the first `uv` on `PATH` | The `uv` executable; never a bare name |
| `HARNESS_INGEST_LOG` | `~/.claude/hooks/ingest-on-capture.log` | Where the detached run's output lands |

The default project directory is the **main checkout**, never a worktree:
worktrees are deleted when their branch merges, and a hook pointing into a
deleted one would fail quietly every night.

The child is spawned with `HARNESS_INGEST_ON_CAPTURE=0` in its own environment,
so a hook firing inside the ingest process can never start a second one.

### Wiring it to the hook

`session-capture.mjs` changes in exactly two places — an import and one call
placed immediately after the note is written successfully:

```js
import { enqueueIngest } from './lib/enqueue-ingest.mjs';
```

```js
  enqueueIngest({ notePath: outcome.notePath, vaultRoot: outcome.vaultRoot, log });
```

They go in the `SEAM` block W-H1 marked for exactly this, after the
`if (!outcome.written)` early return and before the final `log(...)`. The call
satisfies the seam's three conditions: it does not await, it cannot throw, and
it leaves `log(...)` as the last statement in `main()`.

[session-capture-enqueue.md](./session-capture-enqueue.md) has the exact
placement and why it is written down rather than applied on this branch. The
import is relative to the hook file, so it resolves both in this repo
(`hooks/lib/enqueue-ingest.mjs`) and at the deployed path
(`~/.claude/hooks/lib/enqueue-ingest.mjs`).

### Deploying

`node hooks/install.mjs` (W-H1's installer) copies the whole `hooks/` tree to
`~/.claude/hooks/`, this library included. To place just this file:

```bash
mkdir -p "C:/Users/estac/.claude/hooks/lib"
cp hooks/lib/enqueue-ingest.mjs "C:/Users/estac/.claude/hooks/lib/enqueue-ingest.mjs"
```

### Reading the logs

```bash
tail -20 ~/.claude/hooks/session-capture.log      # the hook: note written, enqueue started
tail -40 ~/.claude/hooks/ingest-on-capture.log    # the detached run: what it embedded
```

`session-capture.log` records one `ingest-enqueue started for <note>` line per
session, or the reason it did not. `ingest-on-capture.log` holds the ingest
run's own report — the document count, the chunks written, and any failure. It
rotates once to `.1` past 256 KB.
