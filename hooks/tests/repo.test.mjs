/**
 * Repository identity and collection resolution (R-27.1).
 *
 * The whole reason this stream exists: `bb2dash-wt-sl` is not a project, it is
 * a worktree of one, and the note has to say so.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { deriveCollection } from '../lib/collection.mjs';
import { parseRepoFullName, resolveRepo } from '../lib/repo.mjs';
import { createSandbox } from './helpers/sandbox.mjs';

test('a main checkout resolves to its remote identity', () => {
  const sandbox = createSandbox();
  try {
    const repo = resolveRepo(path.join(sandbox.root, 'repos', 'bb2dash'));
    assert.equal(repo.repoFullName, 'emstacho-su/bb2dash');
    assert.equal(repo.repoSlug, 'bb2dash');
    assert.equal(repo.branch, 'feat/phase7-retrieval');
    assert.equal(repo.worktree, '');
  } finally {
    sandbox.cleanup();
  }
});

test('a worktree resolves to the main repository, and names itself', () => {
  const sandbox = createSandbox();
  try {
    const repo = resolveRepo(path.join(sandbox.root, 'repos', 'bb2dash-wt-sl'));
    assert.equal(repo.repoFullName, 'emstacho-su/bb2dash');
    assert.equal(repo.worktree, 'bb2dash-wt-sl');
    assert.equal(repo.branch, 'feat/sync-loop', 'the worktree has its own HEAD');
    assert.equal(repo.mainRoot, `${sandbox.root}/repos/bb2dash`);
  } finally {
    sandbox.cleanup();
  }
});

test('a subdirectory resolves to the repository above it', () => {
  const sandbox = createSandbox();
  try {
    const repo = resolveRepo(path.join(sandbox.root, 'repos', 'agentic-harness', 'ingest', 'src'));
    assert.equal(repo.repoSlug, 'agentic-harness');
    assert.equal(repo.branch, 'feat/session-context');
  } finally {
    sandbox.cleanup();
  }
});

test('a folder with no git yields empty strings, never a guess', () => {
  const sandbox = createSandbox();
  try {
    const repo = resolveRepo(path.join(sandbox.root, 'onedrive', '.fall2026', 'ist323'));
    assert.equal(repo.repoFullName, '');
    assert.equal(repo.branch, '');
  } finally {
    sandbox.cleanup();
  }
});

test('an unreadable HEAD does not stop the rest of the identity', () => {
  const sandbox = createSandbox();
  try {
    fs.rmSync(path.join(sandbox.root, 'repos', 'agentic-harness', '.git', 'HEAD'));
    const repo = resolveRepo(path.join(sandbox.root, 'repos', 'agentic-harness'));
    assert.equal(repo.repoSlug, 'agentic-harness');
    assert.equal(repo.branch, '');
  } finally {
    sandbox.cleanup();
  }
});

test('parseRepoFullName handles every remote shape git accepts', () => {
  const cases = [
    ['https://github.com/emstacho-su/bb2dash.git', 'emstacho-su/bb2dash'],
    ['https://github.com/emstacho-su/bb2dash', 'emstacho-su/bb2dash'],
    ['git@github.com:emstacho-su/agentic-harness.git', 'emstacho-su/agentic-harness'],
    ['ssh://git@github.com/emstacho-su/agentic-harness.git', 'emstacho-su/agentic-harness'],
    ['https://user:secret@github.com/emstacho-su/bb2dash.git', 'emstacho-su/bb2dash'],
    ['C:/Users/estac/projects/bb2dash', 'projects/bb2dash'],
    ['', ''],
    [null, ''],
  ];
  for (const [url, expected] of cases) {
    assert.equal(parseRepoFullName(url), expected, `for ${url}`);
  }
});

test('the collection is the repo, the worktree, and the class folder in turn', () => {
  const sandbox = createSandbox();
  try {
    const at = (relative) => {
      const cwd = path.join(sandbox.root, relative);
      return deriveCollection({ cwd, vaultRoot: sandbox.vaultRoot, repo: resolveRepo(cwd) });
    };

    assert.deepEqual(at('repos/bb2dash'), {
      area: 'projects',
      collection: 'bb2dash',
      collectionSource: 'git',
    });
    assert.deepEqual(at('repos/bb2dash-wt-sl'), {
      area: 'projects',
      collection: 'bb2dash',
      collectionSource: 'git',
    });
    assert.deepEqual(at('onedrive/.fall2026/ist323'), {
      area: 'classes',
      collection: 'ist323',
      collectionSource: 'folder',
    });
    // No git, no class folder: the folder name, and the note says it guessed.
    assert.deepEqual(at('repos/plain-folder/src'), {
      area: 'projects',
      collection: 'src',
      collectionSource: 'folder',
    });
  } finally {
    sandbox.cleanup();
  }
});

test('the folder fallback prefers an ancestor that already owns a vault folder', () => {
  const sandbox = createSandbox();
  try {
    // A vault folder named after an ancestor beats the immediate basename, so a
    // session in `agentic-harness/ingest` is not filed under `ingest`.
    fs.mkdirSync(path.join(sandbox.vaultRoot, 'projects', 'plain-folder'), { recursive: true });
    const cwd = path.join(sandbox.root, 'repos', 'plain-folder', 'src');
    const result = deriveCollection({ cwd, vaultRoot: sandbox.vaultRoot, repo: resolveRepo(cwd) });
    assert.equal(result.collection, 'plain-folder');
    assert.equal(result.collectionSource, 'folder');
  } finally {
    sandbox.cleanup();
  }
});
