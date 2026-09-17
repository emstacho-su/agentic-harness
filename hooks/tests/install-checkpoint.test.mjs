/**
 * `install-checkpoint.mjs`: the skill lands in a repo byte-identical, the
 * scratch file is git-ignored, and a second run changes nothing.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GITIGNORE_LINE, PAYLOAD, SOURCE_DIR, TARGET_RELATIVE, installCheckpoint, parseArgs, run } from '../install-checkpoint.mjs';

function fakeRepo(gitignore = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-checkpoint-'));
  fs.mkdirSync(path.join(root, '.git'));
  if (gitignore !== null) fs.writeFileSync(path.join(root, '.gitignore'), gitignore, 'utf8');
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('installs both payload files byte-identical and appends the gitignore line once', () => {
  const repo = fakeRepo('node_modules/\n');
  try {
    const first = installCheckpoint({ repo: repo.root });
    assert.deepEqual(first.files.map((f) => f.action), ['create', 'create']);
    assert.equal(first.gitignore, 'append');
    for (const name of PAYLOAD) {
      assert.equal(hash(path.join(repo.root, TARGET_RELATIVE, name)), hash(path.join(SOURCE_DIR, name)));
    }
    assert.equal(fs.readFileSync(path.join(repo.root, '.gitignore'), 'utf8'), `node_modules/\n${GITIGNORE_LINE}\n`);

    const second = installCheckpoint({ repo: repo.root });
    assert.deepEqual(second.files.map((f) => f.action), ['unchanged', 'unchanged']);
    assert.equal(second.gitignore, 'unchanged');
  } finally {
    repo.cleanup();
  }
});

test('a stale copy is updated, a dry run touches nothing, and a non-repo is refused', () => {
  const repo = fakeRepo();
  try {
    const target = path.join(repo.root, TARGET_RELATIVE, 'SKILL.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'old\n', 'utf8');

    const dry = installCheckpoint({ repo: repo.root, dryRun: true });
    assert.equal(dry.files.find((f) => f.name === 'SKILL.md').action, 'update');
    assert.equal(fs.readFileSync(target, 'utf8'), 'old\n', 'dry run wrote nothing');
    assert.ok(!fs.existsSync(path.join(repo.root, '.gitignore')));

    installCheckpoint({ repo: repo.root });
    assert.equal(hash(target), hash(path.join(SOURCE_DIR, 'SKILL.md')));
    assert.equal(fs.readFileSync(path.join(repo.root, '.gitignore'), 'utf8'), `${GITIGNORE_LINE}\n`);

    assert.throws(() => installCheckpoint({ repo: path.join(repo.root, 'nope') }), /not a git repository/);
  } finally {
    repo.cleanup();
  }
});

test('this checkout’s own installed copy matches the source, so what Claude loads here is what the tests cover', () => {
  const installed = path.resolve(SOURCE_DIR, '..', '..', TARGET_RELATIVE);
  for (const name of PAYLOAD) {
    assert.equal(
      hash(path.join(installed, name)),
      hash(path.join(SOURCE_DIR, name)),
      `${name} differs between skills/checkpoint and .claude/skills/checkpoint; run node hooks/install-checkpoint.mjs --repo .`,
    );
  }
});

test('argument parsing and exit codes', () => {
  assert.equal(parseArgs([]).ok, false);
  assert.equal(parseArgs(['--repo']).ok, false);
  assert.equal(parseArgs(['--bogus']).ok, false);
  assert.deepEqual(parseArgs(['--repo', 'x', '--dry-run']).options, { repo: 'x', dryRun: true });

  const lines = [];
  assert.equal(run([], { out: () => {}, err: (l) => lines.push(l) }), 2);
  assert.equal(run(['--repo', path.join(os.tmpdir(), 'definitely-not-a-repo')], { out: () => {}, err: (l) => lines.push(l) }), 1);
  assert.ok(lines.some((l) => /not a git repository/.test(l)));
});
