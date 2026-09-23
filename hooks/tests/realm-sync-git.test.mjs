/**
 * Realm sync against real git (R-B1, R-B2, R-B4, and the Phase A guard).
 *
 * Every git call the sync makes goes through the production `runGitSync`.
 * A scratch global config and GIT_CONFIG_NOSYSTEM keep the developer's own
 * ~/.gitconfig (identity, pull.rebase, autocrlf, signing) out of it, so the
 * identity on these commits can only have come from `syncGitEnv`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runGitSync } from '../lib/git-log.mjs';
import { parseRealmPolicies, syncRealms } from '../lib/realm-sync.mjs';

/** Identity for the commits the test makes by hand (the realm's first commit). */
const SETUP_IDENTITY = Object.freeze(['-c', 'user.name=setup', '-c', 'user.email=setup@example.com']);

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'realm-sync-git-'));
  const globalConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  const isolation = Object.freeze({ GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' });
  const git = (args, cwd) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...isolation }, stdio: ['ignore', 'pipe', 'pipe'] });
  /** The production runner, with only the config isolation added to each call's env. */
  const runGit = (args, options) => runGitSync(args, { ...options, env: { ...(options.env ?? {}), ...isolation } });
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { root, git, runGit, cleanup };
}

/**
 * `café.md` in Unicode NFD (e + combining acute), spelled with an escape so
 * no editor can quietly normalise it to NFC.
 */
const NFD_NAME = 'café.md';

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

/**
 * A bare remote and two machines, A and B, each with the realm `projects`
 * cloned under its vault. A makes and pushes the realm's first commit.
 */
function twoMachines(s) {
  const remote = path.join(s.root, 'remote.git');
  s.git(['init', '--bare', '--quiet', '-b', 'main', remote], s.root);
  const clone = (label) => {
    const vault = path.join(s.root, label);
    const dir = path.join(vault, 'projects');
    fs.mkdirSync(vault);
    s.git(['clone', '--quiet', remote, dir], s.root);
    return { vault, dir };
  };
  const a = clone('a');
  s.git(['symbolic-ref', 'HEAD', 'refs/heads/main'], a.dir);
  fs.writeFileSync(path.join(a.dir, '.realm'), 'projects\n');
  s.git(['add', '.realm'], a.dir);
  s.git([...SETUP_IDENTITY, 'commit', '--quiet', '-m', 'init realm'], a.dir);
  s.git(['push', '--quiet', '-u', 'origin', 'main'], a.dir);
  return { remote, a, b: clone('b') };
}

function syncAs(s, machine, vault, { mode = 'push', realms = 'projects:push' } = {}) {
  const [result] = syncRealms({
    vaultRoot: vault,
    policies: parseRealmPolicies(realms),
    mode,
    machine,
    email: `${machine}@example.com`,
    runGit: s.runGit,
  });
  return result;
}

test('real git: A pushes a note, B pulls it', () => {
  const s = scratch();
  try {
    const { a, b } = twoMachines(s);
    fs.writeFileSync(path.join(a.dir, 'note.md'), '# from a\n');
    const pushed = syncAs(s, 'a', a.vault);
    assert.deepEqual([pushed.steps, pushed.outcome], [['committed', 'pulled', 'pushed'], 'ok'], pushed.error);

    const pulled = syncAs(s, 'b', b.vault, { mode: 'pull' });
    assert.deepEqual([pulled.steps, pulled.outcome], [['clean', 'pulled'], 'ok'], pulled.error);
    assert.equal(read(path.join(b.dir, 'note.md')), '# from a\n');
  } finally {
    s.cleanup();
  }
});

test('real git: different files merge, B pushes the merge, and the identity is the machine', () => {
  const s = scratch();
  try {
    const { a, b } = twoMachines(s);
    fs.writeFileSync(path.join(a.dir, 'from-a.md'), '# a\n');
    assert.equal(syncAs(s, 'a', a.vault).outcome, 'ok');
    fs.writeFileSync(path.join(b.dir, 'from-b.md'), '# b\n');
    const merged = syncAs(s, 'b', b.vault);
    assert.deepEqual([merged.steps, merged.outcome], [['committed', 'pulled', 'pushed'], 'ok'], merged.error);

    const parents = s.git(['rev-list', '--parents', '-n1', 'HEAD'], b.dir).trim().split(' ');
    assert.equal(parents.length, 3, 'a merge commit: itself and two parents');
    const idents = s.git(['log', '-2', '--format=%an <%ae>|%cn <%ce>'], b.dir).trim().split('\n');
    assert.deepEqual(idents, ['b <b@example.com>|b <b@example.com>', 'b <b@example.com>|b <b@example.com>']);
    assert.ok(fs.existsSync(path.join(b.dir, 'from-a.md')));
  } finally {
    s.cleanup();
  }
});

test('real git: a conflict is aborted, B keeps its commit and tree, the remote is untouched', () => {
  const s = scratch();
  try {
    const { remote, a, b } = twoMachines(s);
    fs.writeFileSync(path.join(a.dir, 'note.md'), '# from a\n');
    assert.equal(syncAs(s, 'a', a.vault).outcome, 'ok');
    const remoteHead = s.git(['rev-parse', 'main'], remote).trim();

    fs.writeFileSync(path.join(b.dir, 'note.md'), '# from b\n');
    const result = syncAs(s, 'b', b.vault);
    assert.equal(result.outcome, 'conflict', result.error);
    assert.deepEqual(result.steps, ['committed']);
    assert.match(result.error, /note\.md/);

    assert.equal(read(path.join(b.dir, 'note.md')), '# from b\n');
    assert.match(s.git(['log', '-1', '--format=%s'], b.dir), /^harness: sync from b /);
    assert.ok(!fs.existsSync(path.join(b.dir, '.git', 'MERGE_HEAD')));
    assert.equal(s.git(['status', '--porcelain'], b.dir), '');
    assert.equal(s.git(['rev-parse', 'main'], remote).trim(), remoteHead, "the remote still has A's commit");
  } finally {
    s.cleanup();
  }
});

test('real git: a stray .env stays home, untracked, and is named', () => {
  const s = scratch();
  try {
    const { a } = twoMachines(s);
    fs.writeFileSync(path.join(a.dir, 'note.md'), '# note\n');
    fs.writeFileSync(path.join(a.dir, '.env'), 'SECRET=1\n');
    const result = syncAs(s, 'a', a.vault);
    assert.equal(result.outcome, 'ok', result.error);
    assert.ok(result.notes.includes('not staged: .env'), result.notes.join('\n'));
    assert.equal(s.git(['show', '--name-only', '--format=', 'HEAD'], a.dir).trim(), 'note.md');
    assert.equal(s.git(['status', '--porcelain'], a.dir).trim(), '?? .env');
  } finally {
    s.cleanup();
  }
});

/** A realm with no remote: `git init` in the vault, marker on disk, nothing committed. */
function localRealm(s) {
  const vault = path.join(s.root, 'vault');
  const dir = path.join(vault, 'projects');
  fs.mkdirSync(dir, { recursive: true });
  s.git(['init', '--quiet', '-b', 'main'], dir);
  fs.writeFileSync(path.join(dir, '.realm'), 'projects\n');
  return { vault, dir };
}

test('real git: no attachments/ folder and an ignored .obsidian still commit, and nothing under .obsidian travels', () => {
  const s = scratch();
  try {
    const { vault, dir } = localRealm(s);
    fs.writeFileSync(path.join(dir, '.gitignore'), '.obsidian/\n');
    fs.mkdirSync(path.join(dir, '.obsidian'));
    fs.writeFileSync(path.join(dir, '.obsidian', 'app.json'), '{}\n');
    fs.writeFileSync(path.join(dir, 'note.md'), '# note\n');
    const result = syncAs(s, 'a', vault, { realms: 'projects:local' });
    assert.deepEqual([result.steps, result.outcome], [['committed', 'no-remote', 'no-remote'], 'ok'], result.error);
    assert.deepEqual(s.git(['ls-files'], dir).trim().split('\n'), ['.gitignore', '.realm', 'note.md']);
  } finally {
    s.cleanup();
  }
});

test('real git: a large attachment is committed with a note, an NFD name is refused untouched, deletions travel', () => {
  const s = scratch();
  try {
    const { vault, dir } = localRealm(s);
    fs.mkdirSync(path.join(dir, 'attachments'));
    fs.writeFileSync(path.join(dir, 'attachments', 'deck.pptx'), Buffer.alloc(5 * 1024 * 1024 + 1));
    const opts = { realms: 'projects:local' };

    const noted = syncAs(s, 'a', vault, opts);
    assert.deepEqual(noted.steps, ['committed', 'no-remote', 'no-remote'], noted.error);
    assert.ok(noted.notes.includes('reported: attachments/deck.pptx: 5.0 MiB is over 5 MiB'), noted.notes.join('\n'));
    assert.match(s.git(['show', '--stat', '--oneline', 'HEAD'], dir), /attachments\/deck\.pptx/);

    // NFD on disk: the one bad name every filesystem will actually let us create.
    fs.writeFileSync(path.join(dir, NFD_NAME), '# nfd\n');
    const refused = syncAs(s, 'a', vault, opts);
    assert.equal(refused.outcome, 'refused');
    assert.match(refused.error, /not in Unicode NFC/);
    assert.equal(s.git(['rev-list', '--count', 'HEAD'], dir).trim(), '1', 'no second commit');
    assert.match(s.git(['status', '--porcelain'], dir), /^\?\? /m);

    // unlinkSync, not rmSync: Node 24's rmSync silently leaves a non-NFC name in place on Windows.
    fs.unlinkSync(path.join(dir, NFD_NAME));
    fs.unlinkSync(path.join(dir, 'attachments', 'deck.pptx'));
    const deleted = syncAs(s, 'a', vault, opts);
    assert.equal(deleted.outcome, 'ok', deleted.error);
    assert.equal(s.git(['rev-list', '--count', 'HEAD'], dir).trim(), '2');
    assert.equal(s.git(['ls-files'], dir).trim(), '.realm', 'the deletion travelled');
  } finally {
    s.cleanup();
  }
});
