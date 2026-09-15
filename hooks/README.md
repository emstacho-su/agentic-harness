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

`vault/<projects|classes>/<collection>/sessions/<session_id>.md` — **one note per
session**, named by the full session id, rewritten on every `SessionEnd`.

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

## Merge, never rewrite

Stack edits these notes. The hook therefore reads the note back, merges, and
writes:

- **lists grow** — a tag, commit or PR in the note stays in the note;
- **scalars only improve** — a derived value replaces an empty one, never the
  reverse;
- **`status` ratchets** — `active` → `concluded` → `superseded`, one way.

A note whose frontmatter will not parse is **not written**. Refusing is the only
safe answer to "somebody hand-edited this into a shape I do not understand".

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

`settings.json` already points at `~/.claude/hooks/session-capture.mjs`, and it
stays that way. Pointing it at a worktree would mean the hook disappears the day
the worktree is deleted.

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

`npm test` runs 107 tests with no dependencies and no network:

| File | What it holds |
| --- | --- |
| `golden.test.mjs` | six fixtures render byte-exact notes; schema field order |
| `resume.test.mjs` | end → stale replay → resume, and the manual tag surviving |
| `redaction.test.mjs` | a credential-seeded fixture, plus each rule |
| `budget.test.mjs` | < 1,200 ms over 18 MB, with the real `git log` |
| `migrate.test.mjs` | the migration, its dry run, and its refusals |
| `tags.test.mjs` | every tag is in `docs/tags.md`, or exactly `unclassified` |
| `hook-process.test.mjs` | the real process: exit 0, a log line, the W-H2 seam |

The golden notes are approval tests. When one changes, read the diff: it is a
change to what `ingest` stores and what retrieval can filter on.
