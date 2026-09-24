/**
 * init-realm: a realm's one baseline commit (R-C2, with R-A1–R-A4 and R-B4).
 *
 * Scripted git proves what is asked of git, in which order, and what a dry run
 * never asks. Real git (the production runner, with the developer's own config
 * kept out as in realm-sync-git.test.mjs) proves the commit that comes out.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { run } from '../init-realm.mjs';
import { runGitSync } from '../lib/git-log.mjs';
import { baselineRealm, IDENTITY_REQUIRED } from '../lib/realm-baseline.mjs';
import { SYNC_PATHSPECS } from '../lib/realm-guard.mjs';

const NOW = new Date('2026-09-23T12:00:00Z');
const SUBJECT = 'init realm projects: baseline from vault 2026-09-23T12:00:00.000Z';
const ABSENT_MACHINE_ENV = path.join(os.tmpdir(), 'init-realm-absent-machine.env');
const IDENTITY_ENV = Object.freeze({ HARNESS_MACHINE_ENV: ABSENT_MACHINE_ENV, HARNESS_MACHINE: 'home-pc', HARNESS_GIT_EMAIL: 'me@example.edu' });
const NO_IDENTITY_ENV = Object.freeze({ HARNESS_MACHINE_ENV: ABSENT_MACHINE_ENV });
/** `café.md` in Unicode NFD, spelled with an escape so no editor can normalise it. */
const NFD_NAME = 'café.md';
const URL = 'https://github.com/emstacho-su/vault-projects.git';

/** Every file and folder under `dir`, with a hash of each file: equal snapshots mean nothing was written. */
function snapshot(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .sort()
    .map((relPath) => {
      const full = path.join(dir, relPath);
      if (!fs.lstatSync(full).isFile()) return `${relPath}/`;
      return `${relPath} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
    });
}

function write(dir, relPath, content) {
  const file = path.join(dir, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// ---------------------------------------------------------------- scripted git

const ok = (stdout = '') => ({ ok: true, stdout });
const fail = (status, stderr = '') => ({ ok: false, stdout: '', error: `exit ${status}`, status, stderr });
const zero = (paths) => paths.map((relPath) => `${relPath}\0`).join('');

const LISTED = Object.freeze(['.gitattributes', '.gitignore', '.realm', 'a.md']);

/** A first run on a folder with one note and a stray `.env`. */
const DEFAULT_ANSWERS = Object.freeze({
  'init -q': (args, options) => {
    fs.mkdirSync(path.join(options.cwd, '.git'), { recursive: true });
    return ok();
  },
  'ls-files -z': (args) => ok(zero(args.includes('--cached') ? LISTED : ['.env', ...LISTED])),
  'diff --cached': ok(zero(LISTED)),
  'rev-list --count': fail(128, "fatal: ambiguous argument 'HEAD': unknown revision"),
  'remote get-url': fail(2, "error: No such remote 'origin'"),
});

const INIT = ['init', '-q', '-b', 'main'];
const LIST = ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SYNC_PATHSPECS];
const UNTRACKED = ['ls-files', '-z', '--others', '--exclude-standard'];
const ADD = ['add', '--all', '--', ':(glob)**/*.md', '.realm', '.gitignore', '.gitattributes'];
const RENORMALIZE = ['add', '--renormalize', '.'];
const STAGED = ['diff', '--cached', '--name-only', '-z'];
const COMMIT = ['commit', '--quiet', '-m', SUBJECT];
const REMOTE_ADD = ['remote', 'add', 'origin', URL];
const GET_URL = ['remote', 'get-url', 'origin'];
const REV_LIST = ['rev-list', '--count', 'HEAD'];
/** Commands that change a repository or reach a remote. */
const WRITES = new Set(['add', 'commit', 'remote', 'push', 'fetch', 'pull']);

function fakeGit(answers = {}) {
  const calls = [];
  const table = { ...DEFAULT_ANSWERS, ...answers };
  const runGit = (args, options) => {
    calls.push({ args, options });
    const answer = table[args.slice(0, 2).join(' ')];
    return typeof answer === 'function' ? answer(args, options) : (answer ?? ok());
  };
  return { runGit, calls };
}

/** A scratch vault holding `projects/a.md`; `.git` is absent, or an empty directory with `git: 'dir'`. */
function withScratch(fn, { git = 'none' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'init-realm-'));
  const vault = path.join(root, 'vault');
  const dir = path.join(vault, 'projects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.md'), '# a\n');
  if (git === 'dir') fs.mkdirSync(path.join(dir, '.git'));
  try {
    return fn({ root, vault, dir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function scripted(s, argv, { answers, env = IDENTITY_ENV } = {}) {
  const { runGit, calls } = fakeGit(answers);
  const lines = [];
  const say = (line) => lines.push(line);
  const code = run(['--vault', s.vault, '--realm', 'projects', ...argv], { env, out: say, err: say, runGit, stat: () => 10, clock: () => NOW, pid: 4242 });
  return { code, lines, calls, argv: calls.map((call) => call.args) };
}

test('R-C2: a first run inits, lists twice, stages the live specs, renormalises, checks, commits, then names origin', () =>
  withScratch((s) => {
    const r = scripted(s, ['--remote', URL]);
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.deepEqual(r.argv, [INIT, LIST, UNTRACKED, ADD, RENORMALIZE, STAGED, COMMIT, REMOTE_ADD]);
    for (const { options } of r.calls) {
      assert.equal(options.cwd, s.dir);
      assert.equal(options.captureStderr, true);
      assert.equal(options.env.GIT_AUTHOR_NAME, 'home-pc');
      assert.equal(options.env.GIT_COMMITTER_EMAIL, 'me@example.edu');
      assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    }
    assert.deepEqual(r.lines, [
      '.realm: written',
      '.gitattributes: written',
      '.gitignore: written',
      'init: git init -b main',
      'staged: 4 paths (.gitattributes, .gitignore, .realm, a.md)',
      'not staged: .env',
      `commit: ${SUBJECT}`,
      `remote: origin ${URL} added`,
    ]);
    assert.equal(fs.readFileSync(path.join(s.dir, '.realm'), 'utf8'), 'projects\n');
    assert.ok(!fs.existsSync(path.join(s.dir, '.git', 'harness-sync.lock')), 'the lock was given back');
  }));

test('R-C2: a dry run writes nothing in the realm and only lists, through a throwaway git dir it removes', () =>
  withScratch((s) => {
    const before = snapshot(s.vault);
    const r = scripted(s, ['--remote', URL, '--dry-run']);
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.deepEqual(snapshot(s.vault), before);
    assert.ok(!r.argv.some((args) => WRITES.has(args[0])), r.argv.map((args) => args.join(' ')).join('\n'));
    const inits = r.calls.filter((call) => call.args[0] === 'init');
    assert.equal(inits.length, 1);
    assert.notEqual(inits[0].options.cwd, s.dir);
    assert.ok(!fs.existsSync(inits[0].options.cwd), 'the throwaway git dir is removed');
    const lists = r.calls.filter((call) => call.args[0] === 'ls-files');
    assert.equal(lists.length, 2);
    for (const { args, options } of lists) {
      assert.equal(options.env.GIT_DIR, path.join(inits[0].options.cwd, '.git'));
      assert.equal(options.env.GIT_WORK_TREE, s.dir);
      assert.ok(args.includes('--exclude=.obsidian/workspace.json'), args.join(' '));
    }
    assert.deepEqual(r.lines, [
      '.realm: would-write',
      '.gitattributes: would-write',
      '.gitignore: would-write',
      'init: would-init',
      'staged: 4 paths (.gitattributes, .gitignore, .realm, a.md)',
      'not staged: .env',
      `would-commit: ${SUBJECT}`,
      `remote: origin ${URL} would-add`,
    ]);
  }));

test('R-B4: without an identity nothing is written and no git runs past the .git check', () => {
  withScratch((s) => {
    const before = snapshot(s.vault);
    const r = scripted(s, [], { env: NO_IDENTITY_ENV });
    assert.equal(r.code, 2);
    assert.deepEqual(r.argv, []);
    assert.deepEqual(r.lines, [`error: ${IDENTITY_REQUIRED}`]);
    assert.deepEqual(snapshot(s.vault), before);
  });
  withScratch(
    (s) => {
      const r = scripted(s, ['--dry-run'], { env: { ...NO_IDENTITY_ENV, HARNESS_MACHINE: 'home-pc' } });
      assert.equal(r.code, 2);
      assert.deepEqual(r.argv, [REV_LIST]);
    },
    { git: 'dir' },
  );
});

test('R-A3: a refused name stops the baseline with nothing staged', () =>
  withScratch((s) => {
    const r = scripted(s, [], { answers: { 'ls-files -z': ok(zero([...LISTED, NFD_NAME])) } });
    assert.equal(r.code, 2);
    assert.deepEqual(r.argv, [INIT, LIST, UNTRACKED]);
    assert.match(r.lines.at(-1), /^refused: 1 path\(s\) refused: café\.md: .*not in Unicode NFC/);
  }));

test('R-C2: a realm with a commit on HEAD is already initialised and left alone', () =>
  withScratch(
    (s) => {
      const before = snapshot(s.vault);
      const r = scripted(s, ['--remote', URL], { answers: { 'rev-list --count': ok('2\n') } });
      assert.equal(r.code, 2);
      assert.deepEqual(r.argv, [REV_LIST]);
      assert.deepEqual(r.lines, ['already initialised (2 commits)']);
      assert.deepEqual(snapshot(s.vault), before);
    },
    { git: 'dir' },
  ));

test('--remote: a different origin is an error before anything is written; the same one is left alone', () => {
  withScratch(
    (s) => {
      const r = scripted(s, ['--remote', URL], { answers: { 'remote get-url': ok('https://example.invalid/other.git\n') } });
      assert.equal(r.code, 2);
      assert.deepEqual(r.argv, [REV_LIST, GET_URL]);
      assert.match(r.lines.at(-1), /^error: origin is already https:\/\/example\.invalid\/other\.git, not /);
      assert.ok(!fs.existsSync(path.join(s.dir, '.realm')));
    },
    { git: 'dir' },
  );
  withScratch(
    (s) => {
      const r = scripted(s, ['--remote', URL], { answers: { 'remote get-url': ok(`${URL}\n`) } });
      assert.equal(r.code, 0, r.lines.join('\n'));
      assert.deepEqual(r.argv, [REV_LIST, GET_URL, LIST, UNTRACKED, ADD, RENORMALIZE, STAGED, COMMIT]);
      assert.ok(r.lines.includes('init: already a checkout'));
      assert.equal(r.lines.at(-1), `remote: origin ${URL} unchanged`);
    },
    { git: 'dir' },
  );
});

test('an index holding a path the guard never saw is an error, and nothing is committed', () =>
  withScratch((s) => {
    const r = scripted(s, [], { answers: { 'diff --cached': ok(zero([...LISTED, '.env'])) } });
    assert.equal(r.code, 2);
    assert.ok(!r.argv.some((args) => args[0] === 'commit'));
    assert.match(r.lines.at(-1), /^error: \.env staged but never scanned/);
  }));

test('a missing folder, a .git file, or a vault root that is itself a realm is an error', () =>
  withScratch((s) => {
    const run1 = (name) => baselineRealm({ vaultRoot: s.vault, name, machine: 'home-pc', email: 'me@example.edu', runGit: fakeGit().runGit, clock: () => NOW });
    assert.match(run1('classes').error, /is not a folder/);
    fs.writeFileSync(path.join(s.dir, '.git'), 'gitdir: elsewhere\n');
    assert.match(run1('projects').error, /\.git is a file/);
    fs.writeFileSync(path.join(s.vault, '.realm'), 'personal\n');
    assert.match(run1('projects').error, /is itself a realm/);
  }));

test('baselineRealm returns a frozen result of the documented shape', () =>
  withScratch((s) => {
    const result = baselineRealm({ vaultRoot: s.vault, name: 'projects', machine: 'home-pc', email: 'me@example.edu', runGit: fakeGit().runGit, stat: () => 10, clock: () => NOW, baseEnv: {} });
    assert.deepEqual(Object.keys(result).sort(), ['commit', 'dir', 'dryRun', 'error', 'files', 'init', 'name', 'notStaged', 'notes', 'outcome', 'remote', 'staged']);
    assert.deepEqual([result.outcome, result.dir, result.commit, result.error, result.remote], ['ok', s.dir, SUBJECT, '', null]);
    assert.deepEqual(result.staged, { count: 4, sample: [...LISTED] });
    for (const part of [result, result.files, result.files[0], result.staged, result.staged.sample, result.notStaged, result.notes]) assert.ok(Object.isFrozen(part));
  }));

test('usage errors exit 1 and run no git', () =>
  withScratch((s) => {
    const cases = [[], ['--realm'], ['--realm', 'Projects'], ['--realm', 'projects', '--realm', 'classes'], ['--realm', 'projects', 'constructor'], ['--realm', 'projects', '--remote', '-uoops'], ['--realm', 'projects', '--source', 'two\nlines']];
    for (const argv of cases) {
      const { runGit, calls } = fakeGit();
      const errors = [];
      const code = run(['--vault', s.vault, ...argv], { env: IDENTITY_ENV, out: () => {}, err: (line) => errors.push(line), runGit });
      assert.equal(code, 1, `${argv.join(' ')}: ${errors.join('\n')}`);
      assert.match(errors.join('\n'), /usage: node hooks\/init-realm\.mjs/);
      assert.deepEqual(calls, []);
    }
  }));

// ------------------------------------------------------------------- real git

function realScratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'init-realm-git-'));
  const globalConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  const isolation = Object.freeze({ GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' });
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...isolation }, stdio: ['ignore', 'pipe', 'pipe'] });
  /** The production runner, with only the config isolation added to each call's env. */
  const runGit = (args, options) => runGitSync(args, { ...options, env: { ...(options.env ?? {}), ...isolation } });
  const vault = path.join(root, 'vault');
  const dir = path.join(vault, 'projects');
  fs.mkdirSync(dir, { recursive: true });
  return { root, vault, dir, git, runGit, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function initAs(s, argv) {
  const lines = [];
  const say = (line) => lines.push(line);
  const code = run(['--vault', s.vault, '--realm', 'projects', ...argv], { env: IDENTITY_ENV, out: say, err: say, runGit: s.runGit, clock: () => NOW });
  return { code, lines };
}

const COMMITTED = Object.freeze(['.gitattributes', '.gitignore', '.obsidian/app.json', '.realm', 'a/crlf.md', 'attachments/deck.pptx', 'b/lf.md']);
const STAGED_LINE = `staged: 7 paths (${COMMITTED.join(', ')})`;
const NOT_STAGED_LINE = 'not staged: .env; c/talk.pptx; stray.bin';

test('real git: the dry run changes nothing; the run makes one LF baseline as the machine; a rerun is refused', () => {
  const s = realScratch();
  try {
    write(s.dir, 'a/crlf.md', '# crlf\r\nline two\r\n');
    write(s.dir, 'b/lf.md', '# lf\n');
    write(s.dir, '.env', 'SECRET=1\n');
    write(s.dir, 'stray.bin', Buffer.from([0, 1, 2, 3]));
    write(s.dir, '.obsidian/app.json', '{}\n');
    write(s.dir, '.obsidian/workspace.json', '{"open":[]}\n');
    write(s.dir, 'attachments/deck.pptx', Buffer.alloc(1024));
    write(s.dir, 'c/talk.pptx', Buffer.alloc(1024));

    const before = snapshot(s.vault);
    const dry = initAs(s, ['--dry-run']);
    assert.equal(dry.code, 0, dry.lines.join('\n'));
    assert.deepEqual(snapshot(s.vault), before, 'the dry run wrote nothing');
    const policy = (verb) => [`.realm: ${verb}`, `.gitattributes: ${verb}`, `.gitignore: ${verb}`];
    assert.deepEqual(dry.lines, [...policy('would-write'), 'init: would-init', STAGED_LINE, NOT_STAGED_LINE, `would-commit: ${SUBJECT}`]);

    const real = initAs(s, []);
    assert.equal(real.code, 0, real.lines.join('\n'));
    assert.deepEqual(real.lines, [...policy('written'), 'init: git init -b main', STAGED_LINE, NOT_STAGED_LINE, `commit: ${SUBJECT}`]);
    assert.equal(s.git(['rev-list', '--count', 'main'], s.dir).trim(), '1');
    assert.equal(s.git(['symbolic-ref', '--short', 'HEAD'], s.dir).trim(), 'main');
    assert.deepEqual(s.git(['ls-tree', '-r', '--name-only', 'HEAD'], s.dir).trim().split('\n'), COMMITTED);
    const eol = s.git(['ls-files', '--eol'], s.dir).trim().split('\n').filter((line) => line.endsWith('.md'));
    assert.equal(eol.length, 2);
    for (const line of eol) assert.match(line, /^i\/lf\s/, line);
    assert.equal(s.git(['status', '--porcelain', '--', ...SYNC_PATHSPECS], s.dir), '', 'the tree equals the copy on the sync paths');
    const untracked = s.git(['status', '--porcelain', '--untracked-files=all'], s.dir).trim().split('\n').sort();
    assert.deepEqual(untracked, ['?? .env', '?? c/talk.pptx', '?? stray.bin']);
    assert.equal(s.git(['log', '-1', '--format=%an <%ae>|%cn <%ce>|%s'], s.dir).trim(), `home-pc <me@example.edu>|home-pc <me@example.edu>|${SUBJECT}`);

    const again = initAs(s, []);
    assert.equal(again.code, 2);
    assert.deepEqual(again.lines, ['already initialised (1 commits)']);
  } finally {
    s.cleanup();
  }
});

test('real git: --remote names origin and nothing is pushed or fetched', () => {
  const s = realScratch();
  try {
    write(s.dir, 'b/lf.md', '# lf\n');
    const remote = path.join(s.root, 'remote.git');
    s.git(['init', '--bare', '--quiet', '-b', 'main', remote], s.root);
    const url = pathToFileURL(remote).href;
    const r = initAs(s, ['--remote', url]);
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.equal(r.lines.at(-1), `remote: origin ${url} added`);
    assert.equal(s.git(['remote', 'get-url', 'origin'], s.dir).trim(), url);
    assert.equal(s.git(['for-each-ref'], remote).trim(), '', 'the remote has no refs: nothing was pushed');
    assert.equal(s.git(['for-each-ref', 'refs/remotes'], s.dir).trim(), '', 'nothing was fetched');
  } finally {
    s.cleanup();
  }
});

test('real git: an NFD name is refused with no commit; once it is gone the baseline goes in', () => {
  const s = realScratch();
  try {
    write(s.dir, 'b/lf.md', '# lf\n');
    fs.writeFileSync(path.join(s.dir, NFD_NAME), '# nfd\n');
    const refused = initAs(s, []);
    assert.equal(refused.code, 2);
    assert.match(refused.lines.at(-1), /^refused: 1 path\(s\) refused: .*not in Unicode NFC/);
    assert.throws(() => s.git(['rev-parse', '-q', '--verify', 'HEAD'], s.dir), 'no commit was made');
    assert.equal(s.git(['ls-files'], s.dir), '', 'nothing was staged');

    // unlinkSync, not rmSync: Node 24's rmSync silently leaves a non-NFC name in place on Windows.
    fs.unlinkSync(path.join(s.dir, NFD_NAME));
    const retried = initAs(s, []);
    assert.equal(retried.code, 0, retried.lines.join('\n'));
    assert.ok(retried.lines.includes('.realm: unchanged') && retried.lines.includes('init: already a checkout'), retried.lines.join('\n'));
    assert.equal(s.git(['rev-list', '--count', 'HEAD'], s.dir).trim(), '1');
  } finally {
    s.cleanup();
  }
});
