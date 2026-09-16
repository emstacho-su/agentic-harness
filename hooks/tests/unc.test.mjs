/**
 * The hook never touches a path that resolves onto another host.
 *
 * On Windows, `\\host\share\x` is resolved by connecting to `host` over SMB and
 * authenticating as the logged-in user — handing that host a Net-NTLMv2
 * exchange. This matters here because the hook stats and reads paths that came
 * out of a transcript, and a tool input naming `//attacker/share/x` is recorded
 * even when the write was **denied**. The hook then runs unattended at session
 * exit with nobody watching it.
 *
 * So: a UNC path is not a path this package touches, at any of the four places
 * data reaches the filesystem.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { classifyPaths, isNoisePath, makeRepoResolver } from '../lib/paths.mjs';
import { resolveRepo } from '../lib/repo.mjs';
import { isLocalPath } from '../lib/text.mjs';
import { resolveTranscript } from '../lib/transcript.mjs';
import { createSandbox } from './helpers/sandbox.mjs';

const UNC = ['//evil.example/share/x', '\\\\evil.example\\share\\x', '//evil.example/share'];
const LOCAL = ['C:/Users/estac/projects/bb2dash', 'C:\\Users\\estac', '/c/Users/estac', 'relative/path'];

test('a UNC path is not a local path, in either slash flavour', () => {
  for (const candidate of UNC) assert.equal(isLocalPath(candidate), false, candidate);
  for (const candidate of LOCAL) assert.equal(isLocalPath(candidate), true, candidate);
  assert.equal(isLocalPath(''), false);
  assert.equal(isLocalPath(null), false);
  // A single leading slash is a root, not a host.
  assert.equal(isLocalPath('/usr/local'), true);
});

test('resolveRepo refuses a UNC cwd without touching the filesystem', () => {
  for (const candidate of UNC) {
    const repo = resolveRepo(candidate);
    assert.equal(repo.repoRoot, '', candidate);
    assert.equal(repo.repoFullName, '');
  }
});

test('a `.git` file pointing at another host resolves to nothing', () => {
  const sandbox = createSandbox();
  try {
    const worktree = path.join(sandbox.root, 'repos', 'poisoned');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: //evil.example/share/g\n', 'utf8');

    const repo = resolveRepo(worktree);
    assert.equal(repo.gitDir, '', 'the pointer must not be followed');
    assert.equal(repo.repoFullName, '');
    // And nothing downstream inherits the host either.
    assert.equal(repo.mainRoot, '');
  } finally {
    sandbox.cleanup();
  }
});

test('a commondir pointing at another host is ignored', () => {
  const sandbox = createSandbox();
  try {
    const gitDir = path.join(sandbox.root, 'repos', 'bb2dash', '.git', 'worktrees', 'bb2dash-wt-sl');
    fs.writeFileSync(path.join(gitDir, 'commondir'), '//evil.example/share/g\n', 'utf8');

    // It falls back to the path split, which stays local, rather than following
    // the pointer off-host.
    const repo = resolveRepo(path.join(sandbox.root, 'repos', 'bb2dash-wt-sl'));
    assert.ok(isLocalPath(repo.commonDir), repo.commonDir);
    assert.equal(repo.repoFullName, 'emstacho-su/bb2dash');
  } finally {
    sandbox.cleanup();
  }
});

test('a declared transcript path on another host is not read', () => {
  const resolved = resolveTranscript({
    declaredPath: '//evil.example/share/session.jsonl',
    sessionId: '',
    cwd: '',
    projectsRoot: '',
    deadlineAt: Date.now() + 1000,
  });
  assert.equal(resolved, '');
});

test('a UNC file path from a tool input is noise, and resolves no repository', () => {
  // The realistic route: a prompt injection persuades the session to *attempt*
  // a Write to `//attacker/share/x`. The attempt is recorded whether or not it
  // was permitted, and the capture used to stat it at session end.
  assert.equal(isNoisePath('//evil.example/share/loot/x.txt'), true);
  assert.equal(isNoisePath('\\\\evil.example\\share\\loot\\x.txt'), true);

  const repoFor = makeRepoResolver();
  assert.equal(repoFor('//evil.example/share/loot/x.txt'), null);

  const result = classifyPaths(
    [
      ['//evil.example/share/loot/x.txt', 3],
      ['C:/Users/estac/projects/bb2dash/db/a.sql', 1],
    ],
    { repoFor, maxFiles: 10, maxDocs: 10, maxMemory: 10, maxRepos: 10 },
  );
  assert.ok(
    result.files.every((file) => isLocalPath(file.path)),
    'a UNC path reached files_modified',
  );
});
