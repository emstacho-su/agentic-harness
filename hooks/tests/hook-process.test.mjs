/**
 * The hook as Claude Code actually runs it: a process, a JSON payload on stdin,
 * an exit code.
 *
 * Everything else here calls `capture()` directly. This file is the check that
 * the wrapper around it holds the three promises that matter at session exit —
 * always exit 0, always log, never hang on a Windows pipe.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createSandbox, installTranscript } from './helpers/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, '..', 'session-capture.mjs');
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

/** Run the hook exactly as settings.json does, but pointed at the sandbox. */
function runHook(sandbox, payload, extraEnv = {}) {
  const logPath = path.join(sandbox.root, 'session-capture.log');
  let status = 0;
  try {
    execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HARNESS_VAULT: sandbox.vaultRoot,
        HARNESS_SESSION_CAPTURE_LOG: logPath,
        ...extraEnv,
      },
    });
  } catch (err) {
    status = typeof err?.status === 'number' ? err.status : 1;
  }
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  return { status, log };
}

test('the hook writes a note, logs the elapsed milliseconds, and exits 0', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installTranscript(sandbox, 'plain-main', SESSION_ID);
    const { status, log } = runHook(sandbox, {
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
      cwd: `${sandbox.root}/repos/bb2dash`,
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    });

    assert.equal(status, 0);
    assert.match(log, /projects\/bb2dash\/sessions\/11111111-1111-4111-8111-111111111111\.md/);
    assert.match(log, / ms=\d+$/m, 'the log must record the elapsed milliseconds');

    const note = path.join(
      sandbox.vaultRoot,
      'projects/bb2dash/sessions',
      `${SESSION_ID}.md`,
    );
    assert.ok(fs.existsSync(note));
    assert.match(fs.readFileSync(note, 'utf8'), /^schema_version: 2$/m);
  } finally {
    sandbox.cleanup();
  }
});

test('malformed stdin exits 0 and says so in the log', () => {
  const sandbox = createSandbox();
  try {
    const logPath = path.join(sandbox.root, 'session-capture.log');
    let status = 0;
    try {
      execFileSync(process.execPath, [HOOK], {
        input: 'this is not json',
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, HARNESS_VAULT: sandbox.vaultRoot, HARNESS_SESSION_CAPTURE_LOG: logPath },
      });
    } catch (err) {
      status = typeof err?.status === 'number' ? err.status : 1;
    }
    assert.equal(status, 0);
    assert.match(fs.readFileSync(logPath, 'utf8'), /stdin was not JSON/);
  } finally {
    sandbox.cleanup();
  }
});

test('the kill switch stops the hook without stopping the session', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installTranscript(sandbox, 'plain-main', SESSION_ID);
    const { status } = runHook(
      sandbox,
      {
        session_id: SESSION_ID,
        transcript_path: transcriptPath,
        cwd: `${sandbox.root}/repos/bb2dash`,
        reason: 'clear',
      },
      { HARNESS_SESSION_CAPTURE: '0' },
    );

    assert.equal(status, 0);
    assert.equal(
      fs.existsSync(path.join(sandbox.vaultRoot, 'projects/bb2dash/sessions', `${SESSION_ID}.md`)),
      false,
    );
  } finally {
    sandbox.cleanup();
  }
});

test('a session with no transcript is a logged skip, not a failure', () => {
  const sandbox = createSandbox();
  try {
    const { status, log } = runHook(sandbox, {
      session_id: '00000000-0000-4000-8000-000000000000',
      transcript_path: `${sandbox.root}/projects/fixture/does-not-exist.jsonl`,
      cwd: `${sandbox.root}/repos/bb2dash`,
      reason: 'logout',
    });
    assert.equal(status, 0);
    assert.match(log, /no transcript found/);
  } finally {
    sandbox.cleanup();
  }
});

test('the W-H2 seam is still a single obvious place in main()', () => {
  // The brief promises W-H2 exactly one call site. If this file is refactored
  // so the seam moves or multiplies, that promise quietly breaks.
  const source = fs.readFileSync(HOOK, 'utf8');
  const marker = /-+ SEAM\n/g;
  assert.equal([...source.matchAll(marker)].length, 1);
  assert.match(source, /enqueueIngest\(\{ notePath: outcome\.notePath, vaultRoot: outcome\.vaultRoot, log \}\);/);
  assert.equal([...source.matchAll(/if \(!outcome\.written\)/g)].length, 1);
});
