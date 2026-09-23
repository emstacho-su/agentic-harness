/**
 * One writer at a time per realm (R-B3). The lock is a file under `.git/`,
 * created exclusively; a holder older than the stale window is taken over.
 *
 * Every test writes into a scratch realm with a real `.git/` directory, because
 * the exclusive create and the rename are the whole mechanism and a fake file
 * system could not prove them.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  REALM_LOCK_FILENAME,
  REALM_LOCK_STALE_MS,
  acquireRealmLock,
  describeHolder,
  gitDirKind,
  holderAgeMinutes,
  lockPathFor,
  peekRealmLock,
  putBackOutcome,
  releaseRealmLock,
} from '../lib/realm-lock.mjs';

const MINUTE_MS = 60_000;

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'realm-lock-'));
  const realm = path.join(root, 'realm');
  fs.mkdirSync(path.join(realm, '.git'), { recursive: true });
  const lockPath = path.join(realm, '.git', REALM_LOCK_FILENAME);
  return { root, realm, lockPath, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function writeHolder(lockPath, { pid, owner = 'someone', startedAt, token = 'their-token' }) {
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid, owner, startedAt, token })}\n`);
}

function readLock(lockPath) {
  return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
}

test('the stale window is thirty minutes', () => {
  assert.equal(REALM_LOCK_STALE_MS, 30 * MINUTE_MS);
  assert.equal(REALM_LOCK_FILENAME, 'harness-sync.lock');
});

test('a free realm is locked, and release removes the file', (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const now = new Date('2026-09-23T03:00:00.000Z');
  const got = acquireRealmLock(s.realm, { owner: 'sync --push', pid: 1234, now });
  assert.equal(got.ok, true);
  assert.equal(got.lockPath, s.lockPath);
  assert.equal(got.takenOver, null);
  const body = readLock(s.lockPath);
  assert.deepEqual(Object.keys(body).sort(), ['owner', 'pid', 'startedAt', 'token']);
  assert.equal(body.pid, 1234);
  assert.equal(body.owner, 'sync --push');
  assert.equal(body.startedAt, now.toISOString());
  assert.equal(body.token, got.token);
  assert.deepEqual(releaseRealmLock(got), { ok: true });
  assert.equal(fs.existsSync(s.lockPath), false);
});

test('a 29-minute-old lock is held and left untouched', (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const now = new Date('2026-09-23T03:00:00.000Z');
  writeHolder(s.lockPath, { pid: 777, startedAt: new Date(now.getTime() - 29 * MINUTE_MS).toISOString() });
  const got = acquireRealmLock(s.realm, { owner: 'collector', pid: 1, now });
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'held');
  assert.equal(got.holder.pid, 777);
  assert.equal(got.holder.ageMs, 29 * MINUTE_MS);
  assert.equal(readLock(s.lockPath).token, 'their-token');
});

test('a 31-minute-old lock is taken over and leaves no stale copy', (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const now = new Date('2026-09-23T03:00:00.000Z');
  writeHolder(s.lockPath, { pid: 4242, startedAt: new Date(now.getTime() - 31 * MINUTE_MS).toISOString() });
  const got = acquireRealmLock(s.realm, { owner: 'sync --push', pid: 1, now });
  assert.equal(got.ok, true);
  assert.equal(got.takenOver.pid, 4242);
  assert.equal(readLock(s.lockPath).token, got.token);
  const leftovers = fs.readdirSync(path.join(s.realm, '.git')).filter((n) => n.includes('.stale-'));
  assert.deepEqual(leftovers, []);
});

test('unparseable content falls back to the file mtime', (t) => {
  const s = scratch();
  t.after(s.cleanup);
  fs.writeFileSync(s.lockPath, 'garbage');
  const fresh = acquireRealmLock(s.realm, { owner: 'a', pid: 1, now: new Date() });
  assert.equal(fresh.ok, false);
  assert.equal(fresh.reason, 'held');
  assert.equal(fresh.holder.startedAt, '');

  const old = new Date(Date.now() - 31 * MINUTE_MS);
  fs.utimesSync(s.lockPath, old, old);
  const taken = acquireRealmLock(s.realm, { owner: 'a', pid: 1, now: new Date() });
  assert.equal(taken.ok, true);
  assert.ok(taken.takenOver);
  assert.equal(readLock(s.lockPath).token, taken.token);
});

test('release with a foreign token refuses and keeps the file', (t) => {
  const s = scratch();
  t.after(s.cleanup);
  writeHolder(s.lockPath, { pid: 9, startedAt: new Date().toISOString(), token: 'theirs' });
  assert.deepEqual(releaseRealmLock({ lockPath: s.lockPath, token: 'ours' }), { ok: false, error: 'not ours' });
  assert.equal(fs.existsSync(s.lockPath), true);
});

test('release when the file is already gone is ok', (t) => {
  const s = scratch();
  t.after(s.cleanup);
  assert.deepEqual(releaseRealmLock({ lockPath: s.lockPath, token: 'x' }), { ok: true });
});

test('lockPathFor needs .git to be a directory', (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const bare = path.join(s.root, 'no-git');
  fs.mkdirSync(bare);
  assert.equal(lockPathFor(bare), '');
  const worktree = path.join(s.root, 'worktree');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: elsewhere\n');
  assert.equal(lockPathFor(worktree), '');
  assert.equal(lockPathFor(s.realm), s.lockPath);
  const refused = acquireRealmLock(bare, { owner: 'a' });
  assert.deepEqual({ ...refused }, { ok: false, reason: 'error', error: 'not a git checkout' });
});

test('gitDirKind tells a .git directory from a .git file from nothing', (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const bare = path.join(s.root, 'no-git');
  fs.mkdirSync(bare);
  const worktree = path.join(s.root, 'worktree');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: elsewhere\n');
  assert.equal(gitDirKind(s.realm), 'directory');
  assert.equal(gitDirKind(worktree), 'file');
  assert.equal(gitDirKind(bare), 'none');
  assert.equal(gitDirKind(path.join(s.root, 'missing')), 'none');
});

test('putBackOutcome: a put-back that lost to a third contender keeps the aside copy and says contended', () => {
  const holder = Object.freeze({ pid: 7, owner: 'collector', startedAt: '2026-09-23T03:00:00.000Z', ageMs: 0 });
  const restored = putBackOutcome({ wrote: true, holder });
  assert.equal(restored.keepAside, false, 'the fresh lock is back in place; the copy is redundant');
  assert.deepEqual({ ...restored.result }, { ok: false, reason: 'held', holder });

  const contended = putBackOutcome({ wrote: false, code: 'EEXIST', holder });
  assert.equal(contended.keepAside, true, "the aside file is the only copy of the fresh holder's lock");
  assert.deepEqual({ ...contended.result }, { ok: false, reason: 'error', error: 'lock contended' });

  const broken = putBackOutcome({ wrote: false, code: 'EACCES', holder });
  assert.equal(broken.keepAside, true);
  assert.deepEqual({ ...broken.result }, { ok: false, reason: 'error', error: 'EACCES' });
  for (const outcome of [restored, contended, broken]) assert.ok(Object.isFrozen(outcome) && Object.isFrozen(outcome.result));
});

test('describeHolder and holderAgeMinutes: one wording for a lock holder, unknowns spelled out', () => {
  const known = { pid: 4242, owner: 'sync --push', startedAt: '2026-09-23T02:29:00.000Z', ageMs: 31 * MINUTE_MS - 20_000 };
  assert.equal(describeHolder(known), 'sync --push, pid 4242, since 2026-09-23T02:29:00.000Z');
  assert.equal(describeHolder({ pid: null, owner: '', startedAt: '', ageMs: 0 }), 'unknown owner, pid unknown, since unknown');
  assert.equal(describeHolder(null), 'an unreadable lock file');
  assert.equal(holderAgeMinutes(known), 31, 'rounded, not floored');
});

test('peek reads without writing', (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const now = new Date('2026-09-23T03:00:00.000Z');
  assert.deepEqual({ ...peekRealmLock(s.realm, { now }) }, { held: false, holder: null, stale: false });
  assert.deepEqual(fs.readdirSync(path.join(s.realm, '.git')), []);

  writeHolder(s.lockPath, { pid: 5, startedAt: new Date(now.getTime() - MINUTE_MS).toISOString() });
  const fresh = peekRealmLock(s.realm, { now });
  assert.equal(fresh.held, true);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.holder.pid, 5);

  writeHolder(s.lockPath, { pid: 5, startedAt: new Date(now.getTime() - 31 * MINUTE_MS).toISOString() });
  const stale = peekRealmLock(s.realm, { now });
  assert.equal(stale.held, true);
  assert.equal(stale.stale, true);
  assert.equal(readLock(s.lockPath).token, 'their-token');
});

test('acquire leaves its options alone and returns frozen results', (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const options = Object.freeze({ owner: 'sync', pid: 3, now: new Date() });
  const got = acquireRealmLock(s.realm, options);
  assert.equal(got.ok, true);
  assert.ok(Object.isFrozen(got));
  const second = acquireRealmLock(s.realm, { ...options });
  assert.ok(Object.isFrozen(second));
  assert.ok(Object.isFrozen(second.holder));
  assert.ok(Object.isFrozen(releaseRealmLock(got)));
  assert.ok(Object.isFrozen(peekRealmLock(s.realm)));
});

test('two acquires back to back: the second sees the first as holder', (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const now = new Date();
  const first = acquireRealmLock(s.realm, { owner: 'sync --push', pid: 101, now });
  const second = acquireRealmLock(s.realm, { owner: 'collector', pid: 202, now });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'held');
  assert.equal(second.holder.pid, 101);
  assert.equal(second.holder.owner, 'sync --push');
  assert.deepEqual(Object.keys(second.holder).sort(), ['ageMs', 'owner', 'pid', 'startedAt']);
  assert.equal(readLock(s.lockPath).token, first.token);
});
