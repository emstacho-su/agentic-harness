/**
 * How child processes are spawned.
 *
 * One rule, and it is the reason this module exists: `execFileSync('git', …,
 * { cwd })` resolves the program against the child's working directory before
 * `PATH` on Windows. Point that at a repository the user cloned and a file
 * called `git.exe` in the checkout root runs instead — unattended, at session
 * exit, output swallowed, window hidden.
 *
 * So the tests assert the two properties that stop it: the spawn never uses an
 * untrusted directory as its working directory, and the repository travels as
 * an argument instead.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';

import { collectCommits, runGitSync, tailStderr } from '../lib/git-log.mjs';
import { branchContaining, pullRequestsInWindow, runGhSync } from '../lib/backfill.mjs';
import { repoArgs, trustedSpawnOptions } from '../lib/spawn.mjs';

test('the spawn working directory is the home directory, never a caller path', () => {
  const options = trustedSpawnOptions(400, 1024);
  assert.equal(options.cwd, os.homedir());
  assert.equal(options.env.NoDefaultCurrentDirectoryInExePath, '1');
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, 400);
  assert.equal(options.maxBuffer, 1024);
});

test('the environment is inherited, not replaced', () => {
  // Dropping PATH would break `git` resolution entirely; the override adds one
  // variable rather than starting from nothing.
  const options = trustedSpawnOptions(400, 1024);
  for (const name of Object.keys(process.env)) {
    if (name === 'NoDefaultCurrentDirectoryInExePath') continue;
    assert.equal(options.env[name], process.env[name], `${name} was dropped`);
  }
});

test('extra environment is merged in, and the hardening key always wins', () => {
  // The realm sync sets git identity per call; a caller must not be able to
  // switch the search-path hardening back off by passing it in extraEnv.
  const extraEnv = { GIT_AUTHOR_NAME: 'm', NoDefaultCurrentDirectoryInExePath: '0' };
  const snapshot = { ...extraEnv };
  const options = trustedSpawnOptions(1000, 1024, { extraEnv });
  assert.equal(options.env.GIT_AUTHOR_NAME, 'm');
  assert.equal(options.env.NoDefaultCurrentDirectoryInExePath, '1');
  for (const name of Object.keys(process.env)) {
    if (name === 'NoDefaultCurrentDirectoryInExePath' || name === 'GIT_AUTHOR_NAME') continue;
    assert.equal(options.env[name], process.env[name], `${name} was dropped`);
  }
  assert.deepEqual(extraEnv, snapshot, 'the caller object was mutated');
});

test('stderr is piped only when a caller asks for it', () => {
  assert.equal(trustedSpawnOptions(1000, 1024, { captureStderr: true }).stdio[2], 'pipe');
  assert.equal(trustedSpawnOptions(1000, 1024, {}).stdio[2], 'ignore');
  assert.deepEqual(trustedSpawnOptions(1000, 1024), trustedSpawnOptions(1000, 1024, {}));
  assert.deepEqual(trustedSpawnOptions(1000, 1024).stdio, ['ignore', 'pipe', 'ignore']);
});

test('runGitSync hands per-call environment to git', () => {
  const result = runGitSync(['var', 'GIT_AUTHOR_IDENT'], {
    cwd: process.cwd(),
    timeoutMs: 10_000,
    env: { GIT_AUTHOR_NAME: 'm', GIT_AUTHOR_EMAIL: 'm@example.com' },
  });
  assert.equal(result.ok, true, `git failed: ${result.error}`);
  assert.ok(result.stdout.startsWith('m <m@example.com>'), result.stdout);
});

test('a failing git reports its exit status, and stderr only when captured', () => {
  const args = ['rev-parse', '--verify', 'refs/heads/definitely-not-a-branch-xyz'];
  const captured = runGitSync(args, { cwd: process.cwd(), timeoutMs: 10_000, captureStderr: true });
  assert.equal(captured.ok, false);
  assert.equal(captured.status, 128);
  assert.match(captured.stderr, /fatal|needed a single revision/i);

  const silent = runGitSync(args, { cwd: process.cwd(), timeoutMs: 10_000 });
  assert.equal(silent.ok, false);
  assert.equal(silent.status, 128);
  assert.equal(silent.stderr, '');
});

test('tailStderr keeps the last 300 characters, trimmed', () => {
  assert.equal(tailStderr('abc'), 'abc');
  assert.equal(tailStderr('x'.repeat(400)).length, 300);
  assert.equal(tailStderr(`${'a'.repeat(100)}${'b'.repeat(300)}`), 'b'.repeat(300));
  assert.equal(tailStderr('  fatal: bad\n'), 'fatal: bad');
  assert.equal(tailStderr(''), '');
});

test('a repository travels as -C, in argument position', () => {
  assert.deepEqual(repoArgs('C:/Users/estac/projects/bb2dash'), ['-C', 'C:/Users/estac/projects/bb2dash']);
  assert.deepEqual(repoArgs(''), []);
  assert.deepEqual(repoArgs(undefined), []);
});

test('collectCommits passes the repo to git as -C and not as a cwd', () => {
  let captured = null;
  collectCommits({
    repoRoot: 'C:/evil-checkout',
    since: '2026-09-11T14:02:10.000Z',
    runGit: (args, options) => {
      captured = { args, options };
      return { ok: true, stdout: '' };
    },
  });
  // The runner still receives the repo as `cwd` — that is its documented
  // parameter — and it is `runGitSync` that turns it into `-C`. The assertion
  // that matters is one level down, in the next test.
  assert.equal(captured.options.cwd, 'C:/evil-checkout');
  assert.ok(captured.args.includes('log'));
});

test('runGitSync never hands an untrusted path to the spawn as its cwd', () => {
  // Run a real git against a path that does not exist. If the repository were
  // used as the spawn cwd, Node would fail with ENOENT/UNKNOWN spawning the
  // child; instead git itself starts and reports it cannot find the repo, which
  // is only possible when the spawn cwd is somewhere that exists.
  const result = runGitSync(['rev-parse', '--git-dir'], {
    cwd: 'C:/definitely-not-a-directory-95f2b1',
    timeoutMs: 5_000,
  });
  assert.equal(result.ok, false, 'git should refuse the missing repository');
  assert.equal(result.stdout, '');
  assert.notEqual(result.error, 'ENOENT', 'ENOENT here would mean the spawn itself used the bad path');
});

test('a real git invocation still works when the repo is passed as -C', () => {
  const result = runGitSync(['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });
  assert.equal(result.ok, true, `git failed: ${result.error}`);
  assert.ok(result.stdout.trim().length > 0);
});

test('branchContaining and pullRequestsInWindow go through the same runners', () => {
  let gitOptions = null;
  branchContaining({
    repoRoot: 'C:/evil-checkout',
    sha: 'abcdef1',
    runGit: (_args, options) => {
      gitOptions = options;
      return { ok: true, stdout: '' };
    },
  });
  assert.equal(gitOptions.cwd, 'C:/evil-checkout');

  // `gh` takes no cwd at all, so there is nothing for a caller to poison.
  let ghArgs = null;
  pullRequestsInWindow({
    repoFullName: 'emstacho-su/bb2dash',
    startedAt: '2026-09-11T00:00:00.000Z',
    endedAt: '2026-09-12T00:00:00.000Z',
    runGh: (args, options) => {
      ghArgs = { args, options };
      return { ok: true, stdout: '[]' };
    },
  });
  assert.equal(ghArgs.options, undefined, 'gh is called with no options object to carry a cwd');
  assert.equal(ghArgs.args[0], 'pr');
});

test('runGhSync never throws when gh is absent', () => {
  const result = runGhSync(['definitely-not-a-gh-subcommand'], { timeoutMs: 5_000 });
  assert.equal(typeof result.ok, 'boolean');
  assert.equal(result.stdout.length >= 0, true);
});
