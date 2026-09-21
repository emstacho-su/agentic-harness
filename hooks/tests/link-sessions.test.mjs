/**
 * The link backfill, end to end against a scratch vault.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { linkSessions } from '../link-sessions.mjs';

const PARENT = '11111111-1111-4111-8111-111111111111';
const WORKER = `${PARENT}--a0283f0fe443b2b69`;

function noteText(stem, parent) {
  return [
    '---',
    `id: 'session-${stem}'`,
    'type: session',
    "collection: 'bb2dash'",
    'supersedes: []',
    "resumed_from: ''",
    `parent_session: '${parent}'`,
    '---',
    '',
    `# ${stem}`,
    '',
  ].join('\n');
}

function scratchVault(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'link-sessions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  const sessions = path.join(vault, 'projects', 'bb2dash', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, `${PARENT}.md`), noteText(PARENT, ''), 'utf8');
  fs.writeFileSync(path.join(sessions, `${WORKER}.md`), noteText(WORKER, PARENT), 'utf8');
  fs.writeFileSync(path.join(sessions, 'broken.md'), "---\nid: 'unterminated\n---\n", 'utf8');
  return { vault, sessions, backup: path.join(root, 'backup') };
}

test('a dry run reports the plan and writes nothing', (t) => {
  const { vault, sessions } = scratchVault(t);
  const before = fs.readFileSync(path.join(sessions, `${PARENT}.md`), 'utf8');

  const report = linkSessions({ vault, dryRun: true, ensureIndexes: true });

  assert.equal(report.total, 3);
  assert.equal(report.linked.length, 2);
  assert.equal(report.refused.length, 1);
  assert.deepEqual(report.indexes, ['projects/bb2dash']);
  assert.equal(fs.readFileSync(path.join(sessions, `${PARENT}.md`), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(vault, 'projects', 'bb2dash', 'index.md')));
});

test('a real run links, backs up the originals, and leaves the broken note alone', (t) => {
  const { vault, sessions, backup } = scratchVault(t);
  const original = fs.readFileSync(path.join(sessions, `${WORKER}.md`), 'utf8');
  const broken = fs.readFileSync(path.join(sessions, 'broken.md'), 'utf8');

  const report = linkSessions({ vault, backup, ensureIndexes: true });

  assert.equal(report.linked.length, 2);
  assert.match(fs.readFileSync(path.join(sessions, `${PARENT}.md`), 'utf8'), /^up: '\[\[projects\/bb2dash\/index\|bb2dash\]\]'$/m);
  assert.ok(fs.readFileSync(path.join(sessions, `${WORKER}.md`), 'utf8').includes(`\nup: '[[${PARENT}]]'\n`));
  assert.equal(fs.readFileSync(path.join(backup, 'projects', 'bb2dash', 'sessions', `${WORKER}.md`), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(sessions, 'broken.md'), 'utf8'), broken);
  assert.ok(fs.existsSync(path.join(vault, 'projects', 'bb2dash', 'index.md')));
});

test('a backup already in place is the original, and is never replaced', (t) => {
  const { vault, sessions, backup } = scratchVault(t);
  const original = fs.readFileSync(path.join(sessions, `${PARENT}.md`), 'utf8');
  linkSessions({ vault, backup });

  // The note changes again, and a second real run reuses the directory.
  const notePath = path.join(sessions, `${PARENT}.md`);
  fs.writeFileSync(notePath, fs.readFileSync(notePath, 'utf8').replace(/^up: .*$/m, "up: '[[stale]]'"), 'utf8');
  const again = linkSessions({ vault, backup });

  assert.equal(again.linked.length, 1);
  assert.equal(fs.readFileSync(path.join(backup, 'projects', 'bb2dash', 'sessions', `${PARENT}.md`), 'utf8'), original);
});

test('a second run changes nothing', (t) => {
  const { vault, backup } = scratchVault(t);
  linkSessions({ vault, backup, ensureIndexes: true });

  const again = linkSessions({ vault, backup, ensureIndexes: true });

  assert.equal(again.linked.length, 0);
  assert.equal(again.unchanged, 2);
  assert.deepEqual(again.indexes, []);
});
