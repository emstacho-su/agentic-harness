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
    // The guard lists what is about to be staged before anything is staged.
    assert.deepEqual(ops(projects), ['status', 'ls-files', 'add', 'commit', 'push']);
    assert.deepEqual(ops(classes), ['status', 'ls-files', 'add', 'commit']);
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

// ------------------------------------------------------------ guard (R-A3/4)

/** NUL-separated, the way `git ls-files -z` answers. */
const listing = (...paths) => ({ ok: true, stdout: paths.map((p) => `${p}\0`).join('') });

test('a name one platform rejects is refused before anything is staged, and a dry run says so', () => {
  const { vault, cleanup } = scratchVault();
  try {
    const dir = realm(vault, 'projects');
    const { runGit, calls } = fakeGit({
      'status --porcelain': { ok: true, stdout: '?? CON.md\n' },
      'ls-files -z': listing('a.md', 'CON.md'),
    });
    const stat = () => 10;
    const [result] = pushRealms({ vaultRoot: vault, policies: parseRealmPolicies('projects:push'), runGit, stat });

    assert.equal(result.action, 'refused');
    assert.match(result.error, /1 path\(s\) refused/);
    assert.match(result.error, /CON\.md.*device name/);
    const ops = calls.filter((c) => c.cwd === dir).map((c) => c.args[0]);
    assert.deepEqual(ops, ['status', 'ls-files'], 'no add, no commit, no push');
    const list = calls.find((c) => c.args[0] === 'ls-files');
    assert.deepEqual(list.args, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);

    const [dry] = pushRealms({ vaultRoot: vault, policies: parseRealmPolicies('projects:push'), runGit, stat, dryRun: true });
    assert.equal(dry.action, 'would-refuse');
  } finally {
    cleanup();
  }
});

test('a file over the ceiling is refused; one over the report line is committed and noted', () => {
  const { vault, cleanup } = scratchVault();
  try {
    realm(vault, 'projects');
    const MIB = 1024 * 1024;
    const answers = { 'status --porcelain': { ok: true, stdout: '?? attachments/deck.pptx\n' }, 'ls-files -z': listing('a.md', 'attachments/deck.pptx') };

    const big = fakeGit(answers);
    const [refused] = pushRealms({ vaultRoot: vault, policies: parseRealmPolicies('projects:local'), runGit: big.runGit, stat: (p) => (p.endsWith('.pptx') ? 25 * MIB + 1 : 10) });
    assert.equal(refused.action, 'refused');
    assert.match(refused.error, /over 25 MiB/);
    assert.ok(!big.calls.some((c) => c.args[0] === 'add'));

    const large = fakeGit(answers);
    const [noted] = pushRealms({ vaultRoot: vault, policies: parseRealmPolicies('projects:local'), runGit: large.runGit, stat: (p) => (p.endsWith('.pptx') ? 5 * MIB + 1 : 10) });
    assert.equal(noted.action, 'committed');
    assert.match(noted.notes, /attachments\/deck\.pptx: 5\.0 MiB is over 5 MiB/);
    assert.ok(large.calls.some((c) => c.args[0] === 'commit'));

    const clean = fakeGit({ 'status --porcelain': { ok: true, stdout: '' } });
    const [untouched] = pushRealms({ vaultRoot: vault, policies: parseRealmPolicies('projects:local'), runGit: clean.runGit });
    assert.equal(untouched.action, 'clean');
    assert.ok(!clean.calls.some((c) => c.args[0] === 'ls-files'), 'nothing to commit, nothing to scan');
  } finally {
    cleanup();
  }
});

test('a listing that fails is an error, not a commit of whatever is there', () => {
  const { vault, cleanup } = scratchVault();
  try {
    realm(vault, 'projects');
    const { runGit, calls } = fakeGit({ 'status --porcelain': { ok: true, stdout: ' M a.md\n' }, 'ls-files -z': { ok: false, error: 'ETIMEDOUT' } });
    const [result] = pushRealms({ vaultRoot: vault, policies: parseRealmPolicies('projects:push'), runGit });
    assert.equal(result.action, 'error');
    assert.match(result.error, /ls-files failed/);
    assert.ok(!calls.some((c) => c.args[0] === 'add'));
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

test('the command exits 2 on a refusal and prints the reported paths on their own line', () => {
  const { vault, cleanup } = scratchVault();
  try {
    const dir = realm(vault, 'projects');
    fs.rmSync(path.join(dir, '.git'), { recursive: true });
    git(['init', '--quiet', '-b', 'main'], dir);
    // NFD on disk: the one bad name every filesystem will actually let us create.
    fs.writeFileSync(path.join(dir, 'café.md'), '# nfd\n');
    const env = { HARNESS_REALMS: 'projects:local', HARNESS_MACHINE_ENV: path.join(os.tmpdir(), 'absent.env') };
    const lines = [];
    const code = run(['--push', '--vault', vault, '--dry-run'], { env, out: (l) => lines.push(l), err: () => {} });
    assert.equal(code, 2);
    assert.match(lines[0], /^projects: would-refuse \(1 path\(s\) refused: .*not in Unicode NFC/);

    const live = run(['--push', '--vault', vault], { env, out: (l) => lines.push(l), err: () => {} });
    assert.equal(live, 2);
    assert.match(git(['status', '--porcelain'], dir), /^\?\? /m, 'still untracked: nothing was staged');
  } finally {
    cleanup();
  }
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
    assert.equal(fs.readFileSync(path.join(b, 'projects', 'note.md'), 'utf8').replace(/\r\n/g, '\n'), '# from a\n');

    // B edits the same file without pulling first: a real conflict, aborted cleanly.
    fs.writeFileSync(path.join(a, 'projects', 'note.md'), '# from a, again\n');
    pushRealms({ vaultRoot: a, policies, machine: 'a', runGit });
    fs.writeFileSync(path.join(b, 'projects', 'note.md'), '# from b\n');
    pushRealms({ vaultRoot: b, policies: parseRealmPolicies('projects:local'), machine: 'b', runGit });
    const conflict = pullRealms({ vaultRoot: b, policies, runGit });
    assert.equal(conflict[0].action, 'conflict');
    assert.equal(fs.readFileSync(path.join(b, 'projects', 'note.md'), 'utf8').replace(/\r\n/g, '\n'), '# from b\n', "B's tree is untouched");
    assert.ok(!fs.existsSync(path.join(b, 'projects', '.git', 'rebase-merge')), 'no rebase left in progress');
  } finally {
    cleanup();
  }
});

test('end to end with real git: a large attachment is committed with a note, an NFD name is refused untouched', () => {
  const { root, cleanup } = scratchVault();
  try {
    const identity = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
    const runGit = (args, { cwd, timeoutMs }) => {
      try {
        const stdout = execFileSync('git', [...identity, ...args], { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true, stdout };
      } catch (err) {
        return { ok: false, stdout: '', error: `${err?.code || err?.message}: ${String(err?.stderr ?? '').trim()}` };
      }
    };
    const vault = path.join(root, 'vault');
    const dir = path.join(vault, 'projects');
    fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
    git(['init', '--quiet', '-b', 'main'], dir);
    fs.writeFileSync(path.join(dir, '.realm'), 'projects\n');
    fs.writeFileSync(path.join(dir, 'attachments', 'deck.pptx'), Buffer.alloc(5 * 1024 * 1024 + 1));
    const policies = parseRealmPolicies('projects:local');

    const [noted] = pushRealms({ vaultRoot: vault, policies, machine: 'a', runGit });
    assert.equal(noted.action, 'committed', noted.error);
    assert.match(noted.notes, /attachments\/deck\.pptx: 5\.0 MiB is over 5 MiB/);
    assert.match(git(['show', '--stat', '--oneline', 'HEAD'], dir), /attachments\/deck\.pptx/);

    fs.writeFileSync(path.join(dir, 'café.md'), '# nfd\n');
    const [refused] = pushRealms({ vaultRoot: vault, policies, machine: 'a', runGit });
    assert.equal(refused.action, 'refused');
    assert.equal(git(['rev-list', '--count', 'HEAD'], dir).trim(), '1', 'no second commit');
    assert.match(git(['status', '--porcelain'], dir), /^\?\? /m);

    // Deleting a tracked file is the ordinary case, not a race: it is staged as a deletion.
    // unlinkSync, not rmSync: Node 24's rmSync silently leaves a non-NFC name in place on Windows.
    fs.unlinkSync(path.join(dir, 'café.md'));
    fs.unlinkSync(path.join(dir, 'attachments', 'deck.pptx'));
    const [deleted] = pushRealms({ vaultRoot: vault, policies, machine: 'a', runGit });
    assert.equal(deleted.action, 'committed', deleted.error);
    assert.equal(git(['rev-list', '--count', 'HEAD'], dir).trim(), '2');
    assert.equal(git(['ls-files'], dir).trim(), '.realm', 'the deletion travelled');
  } finally {
    cleanup();
  }
});
