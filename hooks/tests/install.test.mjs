/**
 * The installer's payload is the whole hook, or the deployed copy is broken.
 *
 * `PAYLOAD` is a hand-maintained list, and a hand-maintained list of files is a
 * list that goes stale the first time someone adds a module. The failure is
 * quiet and total: the deployed `session-capture.mjs` throws `ERR_MODULE_NOT_FOUND`
 * on import, the hook writes nothing, and the only evidence is a line in a log
 * nobody reads. This test is the tripwire — it walks `lib/` on disk rather than
 * trusting the list.
 *
 * (It happened once already: `lib/spawn.mjs` was added and not listed.)
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = path.resolve(HERE, '..');
const INSTALLER = path.join(HOOKS_DIR, 'install.mjs');

/** The `PAYLOAD` array, read out of the installer's source. */
function payloadPaths() {
  const source = fs.readFileSync(INSTALLER, 'utf8');
  const block = source.match(/const PAYLOAD = \[([\s\S]*?)\];/);
  assert.ok(block, 'install.mjs no longer declares a PAYLOAD array');
  return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

const RELATIVE_IMPORT = /(?:^|\n)\s*import\s+(?:[\s\S]*?\sfrom\s+)?['"](\.[^'"]+)['"]/g;

/**
 * Every module `session-capture.mjs` reaches, transitively.
 *
 * This — not "every file in lib/" — is what the deployed copy needs. The
 * migration and back-fill modules live in `lib/` too but run from the repo, so
 * listing them would deploy code the hook never loads.
 */
function runtimeClosure(entry = 'session-capture.mjs') {
  const seen = new Set();
  const queue = [entry];

  while (queue.length) {
    const relative = queue.shift();
    if (seen.has(relative)) continue;
    seen.add(relative);

    const source = fs.readFileSync(path.join(HOOKS_DIR, relative), 'utf8');
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const resolved = path
        .relative(HOOKS_DIR, path.resolve(path.dirname(path.join(HOOKS_DIR, relative)), match[1]))
        .replace(/\\/g, '/');
      queue.push(resolved);
    }
  }
  return [...seen].sort();
}

test('the payload is exactly what the entry point imports, transitively', () => {
  const payload = payloadPaths();
  assert.ok(payload.includes('session-capture.mjs'), 'the entry point is not in the payload');
  assert.deepEqual(
    payload.slice().sort(),
    runtimeClosure(),
    "install.mjs PAYLOAD and the hook's actual import graph disagree",
  );
});

test('the payload deploys no module the hook does not load', () => {
  // `lib/migrate.mjs` and `lib/backfill.mjs` are repo tools: they belong in the
  // checkout, not in ~/.claude/hooks.
  const payload = new Set(payloadPaths());
  for (const name of ['lib/migrate.mjs', 'lib/backfill.mjs']) {
    assert.ok(!payload.has(name), `${name} is a repo tool and should not be deployed`);
  }
});

test('the payload names only files that exist', () => {
  for (const relative of payloadPaths()) {
    assert.ok(fs.existsSync(path.join(HOOKS_DIR, relative)), `payload names a missing file: ${relative}`);
  }
});

test('a dry-run install into an empty directory reports the whole payload', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-install-'));
  try {
    const output = execFileSync(process.execPath, [INSTALLER, '--dry-run', '--target', target, '--skip-settings'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    const expected = payloadPaths().length;
    assert.match(output, new RegExp(`${expected} file\\(s\\) would change`));
    assert.equal(fs.readdirSync(target).length, 0, 'a dry run must not write');
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('a real install into a scratch target copies and verifies every file', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-install-'));
  try {
    // --skip-settings is not optional here: without it the test registers a
    // hook pointing at this temp directory in the real ~/.claude/settings.json,
    // and every run leaves another one behind. It did, thirteen times.
    const output = execFileSync(process.execPath, [INSTALLER, '--target', target, '--skip-settings'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.match(output, /verified byte-identical/);

    for (const relative of payloadPaths()) {
      const installed = path.join(target, relative);
      assert.ok(fs.existsSync(installed), `not installed: ${relative}`);
      assert.equal(
        fs.readFileSync(installed, 'utf8'),
        fs.readFileSync(path.join(HOOKS_DIR, relative), 'utf8'),
        `not byte-identical: ${relative}`,
      );
    }

    // The point of the payload: the installed copy imports cleanly on its own.
    execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(
      `file:///${path.join(target, 'lib', 'capture.mjs').replace(/\\/g, '/')}`,
    )})`], { timeout: 60_000 });
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});
