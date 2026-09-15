# Hooks

Claude Code hook code that belongs to this repo. The files here are the
canonical copies; the running ones live in `~/.claude/hooks/`, which is where
Claude Code loads them from.

| Path | What it is |
| --- | --- |
| `lib/enqueue-ingest.mjs` | Starts a detached `ingest --only` run for one freshly written session note |
| `tests/enqueue-ingest.test.mjs` | `node --test`, no real process ever spawned |
| `session-capture-enqueue.patch` | The two lines that call the enqueue from `session-capture.mjs` |

```bash
node --test "hooks/tests/**/*.test.mjs"
```

The quoted glob is deliberate. Node 24's test runner treats a bare
`hooks/tests/` as a module path and fails with `MODULE_NOT_FOUND`.

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
            └─ detached: uv run ingest --source obsidian --path <vault> --only <note>
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
| `HARNESS_UV_BIN` | `~/.local/bin/uv.exe`, else `uv` on PATH | The `uv` executable |
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
  enqueueIngest({ vaultRoot, notePath: file, log });
```

`session-capture-enqueue.patch` holds the same change as a diff against
version 1.0.0. The import is relative to the hook file, so it resolves both at
the deployed path (`~/.claude/hooks/lib/enqueue-ingest.mjs`) and in this repo
(`hooks/lib/enqueue-ingest.mjs`).

### Deploying

Copy the library next to the hook:

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
