/**
 * Realm sync: notes travel by git, nothing is ever forced.
 *
 * The unit tests script `runGit` and assert the exact argument arrays. One
 * test runs real git against a scratch bare repo, because "pull --rebase
 * --autostash" and "push" are the whole point and a fake cannot prove them.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseRealmPolicies, pullRealms, pushRealms, realmDir } from '../lib/realm-sync.mjs';
import { parseArgs, run } from '../sync-realms.mjs';

function scratchVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'realm-sync-'));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault);
  return { root, vault, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function realm(vault, name, { checkout = true } = {}) {
  const dir = path.join(vault, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.realm'), `${name}\n`);
  if (checkout) fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

/** A scripted git: `answers` maps the first two args to a result; default ok. */
function fakeGit(answers = {}) {
  const calls = [];
  const runGit = (args, { cwd }) => {
    calls.push({ args, cwd });
    const key = args.slice(0, 2).join(' ');
    return answers[key] ?? { ok: true, stdout: '' };
  };
  return { runGit, calls };
}

// ------------------------------------------------------------------ policies

test('parseRealmPolicies mirrors the Python side', () => {
  assert.deepEqual(parseRealmPolicies('projects:push, classes:local'), [
    { name: 'projects', policy: 'push' },
    { name: 'classes', policy: 'local' },
  ]);
  assert.deepEqual(parseRealmPolicies(''), []);
  for (const bad of ['projects', 'projects:sync', 'Projects:push', 'a:push,a:local']) {
    assert.throws(() => parseRealmPolicies(bad), /HARNESS_REALMS/);
  }
});

test('realmDir finds a folder realm or a root realm, and refuses a mismatch', () => {
  const { vault, cleanup } = scratchVault();
  try {
    const dir = realm(vault, 'projects');
    assert.equal(realmDir(vault, 'projects'), dir);
    assert.equal(realmDir(vault, 'classes'), '');
    fs.writeFileSync(path.join(vault, '.realm'), 'personal\n');
    assert.equal(realmDir(vault, 'personal'), vault);
    assert.equal(realmDir(vault, 'projects'), '', 'a root marker makes the whole vault one realm');
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------------ pull

test('pull rebases with autostash, and a failed rebase is aborted and reported', () => {
  const { vault, cleanup } = scratchVault();
  try {
    const dir = realm(vault, 'projects');
    realm(vault, 'classes');
    const { runGit, calls } = fakeGit({ 'pull --rebase': { ok: false, error: 'CONFLICT' } });
    const results = pullRealms({ vaultRoot: vault, policies: parseRealmPolicies('projects:push,classes:local,work-vm:push'), runGit });

    assert.deepEqual(results.map((r) => [r.name, r.action]), [['projects', 'conflict'], ['classes', 'conflict'], ['work-vm', 'skip']]);
    const forProjects = calls.filter((c) => c.cwd === dir).map((c) => c.args);
    assert.deepEqual(forProjects, [
      ['remote', 'get-url', 'origin'],
      ['pull', '--rebase', '--autostash', '--quiet'],
      ['rebase', '--abort'],
    ]);
    assert.ok(!calls.some((c) => c.args.includes('--force') || c.args.includes('-f')));
  } finally {
    cleanup();
  }
});

test('pull skips a realm without a remote or without a checkout, and a dry run pulls nothing', () => {
  const { vault, cleanup } = scratchVault();
  try {
    realm(vault, 'projects');
    realm(vault, 'classes', { checkout: false });
    const { runGit, calls } = fakeGit({ 'remote get-url': { ok: false, error: 'no origin' } });
    const results = pullRealms({ vaultRoot: vault, policies: parseRealmPolicies('projects:push,classes:local'), runGit });
    assert.deepEqual(results.map((r) => [r.name, r.action]), [['projects', 'skip'], ['classes', 'skip']]);

    const dry = fakeGit();
    const planned = pullRealms({ vaultRoot: vault, policies: parseRealmPolicies('projects:push'), runGit: dry.runGit, dryRun: true });
    assert.equal(planned[0].action, 'would-pull');
    assert.ok(!dry.calls.some((c) => c.args[0] === 'pull'));
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------------ push

test('push commits every dirty realm but pushes only the push realms', () => {
  const { vault, cleanup } = scratchVault();
  try {
    const projects = realm(vault, 'projects');
    const classes = realm(vault, 'classes');
    const { runGit, calls } = fakeGit({ 'status --porcelain': { ok: true, stdout: ' M a.md\n' } });
    const results = pushRealms({
      vaultRoot: vault,
      policies: parseRealmPolicies('projects:push,classes:local'),
      machine: 'home-pc',
      runGit,
      now: new Date('2026-09-22T03:00:00Z'),
    });
    assert.deepEqual(results.map((r) => [r.name, r.action]), [['projects', 'committed-and-pushed'], ['classes', 'committed']]);

    const ops = (dir) => calls.filter((c) => c.cwd === dir).map((c) => c.args[0]);
    assert.deepEqual(ops(projects), ['status', 'add', 'commit', 'push']);
    assert.deepEqual(ops(classes), ['status', 'add', 'commit']);
    const commit = calls.find((c) => c.args[0] === 'commit');
    assert.equal(commit.args.at(-1), 'harness: sync from home-pc 2026-09-22T03:00:00.000Z');
  } finally {
    cleanup();
  }
});

test('a clean push realm still pushes (commits made by hand), and a failed push is reported', () => {
  const { vault, cleanup } = scratchVault();
  try {
    realm(vault, 'projects');
    const { runGit } = fakeGit({ 'push --quiet': { ok: false, error: 'rejected' } });
    const [result] = pushRealms({ vaultRoot: vault, policies: parseRealmPolicies('projects:push'), runGit });
    assert.equal(result.action, 'error');
    assert.match(result.error, /push failed/);
  } finally {
    cleanup();
  }
});

// -------------------------------------------------------------- command line

test('the command needs exactly one of --pull and --push, and no realms means nothing to do', () => {
  assert.equal(parseArgs([]).ok, false);
  assert.equal(parseArgs(['--pull', '--push']).ok, false);
  assert.equal(parseArgs(['--push', '--dry-run'], { HARNESS_VAULT: 'v' }).options.dryRun, true);

  const lines = [];
  const code = run(['--pull'], { env: { HARNESS_REALMS: '', HARNESS_MACHINE_ENV: path.join(os.tmpdir(), 'absent.env') }, out: (l) => lines.push(l), err: () => {} });
  assert.equal(code, 0);
  assert.match(lines[0], /nothing to sync/);
});

// ----------------------------------------------------------------- real git

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('end to end with real git: machine A pushes a note, machine B pulls it', () => {
  const { root, cleanup } = scratchVault();
  try {
    const remote = path.join(root, 'remote.git');
    git(['init', '--bare', '--quiet', '-b', 'main', remote], root);
    const identity = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];

    const makeVault = (label) => {
      const vault = path.join(root, label);
      fs.mkdirSync(vault);
      git(['clone', '--quiet', remote, path.join(vault, 'projects')], root);
      return vault;
    };
    // The marker is committed once, in the realm's first commit; every clone gets it.
    const a = makeVault('a');
    fs.writeFileSync(path.join(a, 'projects', '.realm'), 'projects\n');
    git(['add', '-A'], path.join(a, 'projects'));
    git([...identity, 'commit', '--quiet', '-m', 'init realm'], path.join(a, 'projects'));
    git(['push', '--quiet', '-u', 'origin', 'main'], path.join(a, 'projects'));
    const b = makeVault('b');
    assert.equal(fs.readFileSync(path.join(b, 'projects', '.realm'), 'utf8').trim(), 'projects');

    // The tests must not depend on the machine's git identity.
    const runGit = (args, { cwd, timeoutMs }) => {
      try {
        const stdout = execFileSync('git', [...identity, ...args], { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true, stdout };
      } catch (err) {
        return { ok: false, stdout: '', error: `${err?.code || err?.message}: ${String(err?.stderr ?? '').trim()}` };
      }
    };
    const policies = parseRealmPolicies('projects:push');

    fs.writeFileSync(path.join(a, 'projects', 'note.md'), '# from a\n');
    const pushed = pushRealms({ vaultRoot: a, policies, machine: 'a', runGit });
    assert.equal(pushed[0].action, 'committed-and-pushed', pushed[0].error);

    const pulled = pullRealms({ vaultRoot: b, policies, runGit });
    assert.equal(pulled[0].action, 'pulled', pulled[0].error);
    assert.equal(fs.readFileSync(path.join(b, 'projects', 'note.md'), 'utf8').replace(/\r\n/g, '\n').replace(/
/g, '
'), '# from a\n');

    // B edits the same file without pulling first: a real conflict, aborted cleanly.
    fs.writeFileSync(path.join(a, 'projects', 'note.md'), '# from a, again\n');
    pushRealms({ vaultRoot: a, policies, machine: 'a', runGit });
    fs.writeFileSync(path.join(b, 'projects', 'note.md'), '# from b\n');
    pushRealms({ vaultRoot: b, policies: parseRealmPolicies('projects:local'), machine: 'b', runGit });
    const conflict = pullRealms({ vaultRoot: b, policies, runGit });
    assert.equal(conflict[0].action, 'conflict');
    assert.equal(fs.readFileSync(path.join(b, 'projects', 'note.md'), 'utf8').replace(/\r\n/g, '\n').replace(/
/g, '
'), '# from b\n', "B's tree is untouched");
    assert.ok(!fs.existsSync(path.join(b, 'projects', '.git', 'rebase-merge')), 'no rebase left in progress');
  } finally {
    cleanup();
  }
});
