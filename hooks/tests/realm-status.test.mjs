/**
 * Reading `git status --porcelain=v1 -z` (R-B2 support): what changed, which
 * of it travels, and whether someone staged something outside the sync set by
 * hand — the sync must refuse that rather than commit it.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isSyncPath } from '../lib/realm-guard.mjs';
import { parsePorcelainZ, splitBySyncPath, stagedOutsideSync } from '../lib/realm-status.mjs';

const SAMPLE = '?? .env\0 M a.md\0R  new.md\0old.md\0A  .env2\0';

test('parsePorcelainZ reads XY and path, and a rename carries its original path', () => {
  const records = parsePorcelainZ(SAMPLE);
  assert.deepEqual(records, [
    { x: '?', y: '?', path: '.env', from: '' },
    { x: ' ', y: 'M', path: 'a.md', from: '' },
    { x: 'R', y: ' ', path: 'new.md', from: 'old.md' },
    { x: 'A', y: ' ', path: '.env2', from: '' },
  ]);
  assert.ok(Object.isFrozen(records));
  for (const record of records) assert.ok(Object.isFrozen(record));
});

test('a copy carries its original path too', () => {
  assert.deepEqual(parsePorcelainZ('C  b.md\0a.md\0'), [{ x: 'C', y: ' ', path: 'b.md', from: 'a.md' }]);
});

test('empty or whitespace output is no changes', () => {
  assert.deepEqual(parsePorcelainZ(''), []);
  assert.deepEqual(parsePorcelainZ('  \n'), []);
  assert.deepEqual(parsePorcelainZ(undefined), []);
});

test('a malformed record is refused by index, never skipped', () => {
  assert.throws(() => parsePorcelainZ(' M a.md\0XY\0'), /record 1/);
  assert.throws(() => parsePorcelainZ('MMxa.md\0'), /record 0/);
  assert.throws(() => parsePorcelainZ('R  new.md\0'), /record 0.*original path/);
});

test('splitBySyncPath: a rename counts by its new path; strays are leftover', () => {
  const split = splitBySyncPath(parsePorcelainZ(SAMPLE), isSyncPath);
  assert.deepEqual(split.sync.map((r) => r.path), ['a.md', 'new.md']);
  assert.deepEqual(split.leftover.map((r) => r.path), ['.env', '.env2']);
  assert.ok(Object.isFrozen(split) && Object.isFrozen(split.sync) && Object.isFrozen(split.leftover));
});

test('stagedOutsideSync returns only leftover records someone staged', () => {
  const staged = stagedOutsideSync(parsePorcelainZ(SAMPLE), isSyncPath);
  assert.deepEqual(staged.map((r) => r.path), ['.env2']);
  assert.equal(staged[0].x, 'A');
  assert.ok(Object.isFrozen(staged));
});

test('real git: untracked, modified and hand-staged files parse as expected', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'realm-status-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  try {
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.md'), 'one\n');
    git('add', 'a.md');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(repo, 'a.md'), 'two\n');
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.writeFileSync(path.join(repo, 'sub', 'new.md'), 'x\n');
    fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
    git('add', '.env');

    const records = parsePorcelainZ(git('status', '--porcelain=v1', '-z', '--untracked-files=all'));
    const byPath = [...records].sort((a, b) => (a.path < b.path ? -1 : 1));
    assert.deepEqual(byPath, [
      { x: 'A', y: ' ', path: '.env', from: '' },
      { x: ' ', y: 'M', path: 'a.md', from: '' },
      { x: '?', y: '?', path: 'sub/new.md', from: '' },
    ]);
    assert.deepEqual(stagedOutsideSync(records, isSyncPath).map((r) => r.path), ['.env']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a worktree rename (Y = R, after git add -N) carries its original path too', () => {
  assert.deepEqual(parsePorcelainZ(' R new.md\0old.md\0?? x.md\0'), [
    { x: ' ', y: 'R', path: 'new.md', from: 'old.md' },
    { x: '?', y: '?', path: 'x.md', from: '' },
  ]);
});
