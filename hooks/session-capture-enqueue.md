# Wiring the enqueue into `session-capture.mjs`

W-H1 left a marked seam in `hooks/session-capture.mjs` for exactly this. The
change is two lines and touches nothing else.

**1. With the other imports** (after `createLogger`, keeping them alphabetical):

```js
import { enqueueIngest } from './lib/enqueue-ingest.mjs';
```

**2. Inside `main()`, in the `SEAM` block**, after the `if (!outcome.written)`
early return and immediately before the final `log(...)`:

```js
  enqueueIngest({ notePath: outcome.notePath, vaultRoot: outcome.vaultRoot, log });
```

That satisfies the seam's three conditions: it does not await (the call is
synchronous and returns in 9–16 ms), it cannot throw (every path returns a
result object), and it leaves `log(...)` as the last statement in `main()`.

Resulting order in `main()`:

```js
  if (!outcome.written) {
    log(`${outcome.action} ${input.sessionId}: ${outcome.skip} ms=${ms}`);
    return;
  }

  // ------------------------------------------------------------------ SEAM
  // ...
  // ----------------------------------------------------------------------

  enqueueIngest({ notePath: outcome.notePath, vaultRoot: outcome.vaultRoot, log });

  log(`${outcome.action} ${outcome.detail} ms=${ms}`);
}
```

## Why this is not applied here

This branch is based on `feat/vault-materials-export`, which predates W-H1's
move of the hook into `hooks/`. There is no `hooks/session-capture.mjs` on this
branch to edit, and editing the deployed copy at
`~/.claude/hooks/session-capture.mjs` was refused by the harness permission
classifier as a self-modification. So the change is written down rather than
made, for the PM to apply once both branches are merged.

The import path is relative to the hook file, so it resolves both in the repo
(`hooks/lib/enqueue-ingest.mjs`) and at the deployed path
(`~/.claude/hooks/lib/enqueue-ingest.mjs`) that `node hooks/install.mjs` writes.

## Verifying it after the merge

```bash
# End a session, then:
tail -5 ~/.claude/hooks/session-capture.log      # "ingest-enqueue started for <note>"
tail -20 ~/.claude/hooks/ingest-on-capture.log   # the detached run's own report
```
