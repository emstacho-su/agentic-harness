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

import { collectCommits, runGitSync } from '../lib/git-log.mjs';
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
