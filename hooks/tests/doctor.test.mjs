import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { diagnose, formatRows, realmsOnDisk } from '../doctor.mjs';

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('realmsOnDisk reads a root marker, or one per top-level folder', () => {
  const { root, cleanup } = scratch();
  try {
    fs.mkdirSync(path.join(root, 'projects'));
    fs.mkdirSync(path.join(root, 'daily'));
    fs.writeFileSync(path.join(root, 'projects', '.realm'), 'projects\n');
    assert.deepEqual(realmsOnDisk(root), [{ folder: 'projects', name: 'projects' }]);
    fs.writeFileSync(path.join(root, '.realm'), 'personal\n');
    assert.deepEqual(realmsOnDisk(root), [{ folder: '.', name: 'personal' }]);
    assert.deepEqual(realmsOnDisk(path.join(root, 'absent')), []);
  } finally {
    cleanup();
  }
});

test('diagnose reports the machine file, an unlisted realm, and never a secret value', () => {
  const { root, cleanup } = scratch();
  try {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, 'work-vm'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'work-vm', '.realm'), 'work-vm\n');
    const machineFile = path.join(root, 'machine.env');
    fs.writeFileSync(machineFile, `HARNESS_VAULT=${vault}\nHARNESS_MACHINE=vm\nHARNESS_REALMS=projects:push\nDATABASE_URL=postgresql://u:hunter2@h/db\n`);

    const rows = Object.fromEntries(diagnose({ HARNESS_MACHINE_ENV: machineFile }, root));
    assert.equal(rows['machine'], 'vm');
    assert.equal(rows['machine file'], machineFile);
    assert.match(rows['realms unlisted'], /work-vm/);
    assert.equal(rows['DATABASE_URL'], 'set');
    assert.ok(!JSON.stringify(rows).includes('hunter2'));
  } finally {
    cleanup();
  }
});

/** A vault under `root` with a machine file naming it; `lines` are extra machine.env lines. */
function vaultWith(root, lines = []) {
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const machineFile = path.join(root, 'machine.env');
  fs.writeFileSync(machineFile, [`HARNESS_VAULT=${vault}`, ...lines, ''].join('\n'));
  return { vault, env: Object.freeze({ HARNESS_MACHINE_ENV: machineFile }) };
}

/** A realm folder `name` under `vault`; `git` is 'directory', 'file' or 'none'. */
function addRealm(vault, name, git = 'directory') {
  const dir = path.join(vault, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.realm'), `${name}\n`);
  if (git === 'directory') fs.mkdirSync(path.join(dir, '.git'));
  if (git === 'file') fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ../elsewhere/.git\n');
  return dir;
}

/**
 * A runGit that answers from `script` (keyed by `<realm folder>|<args>`) and
 * records every call. Anything unscripted fails loudly as an unknown exit.
 */
function scriptedGit(script) {
  const calls = [];
  const runGit = (args, options = {}) => {
    calls.push(Object.freeze({ args, ...options }));
    const reply = script[`${path.basename(options.cwd ?? '')}|${args.join(' ')}`];
    return reply ?? { ok: false, stdout: '', error: 'unscripted', status: null };
  };
  return { runGit, calls };
}

const ORIGIN = 'remote get-url origin';
const COUNT = 'rev-list --count HEAD';
const UNBORN = 'rev-parse --verify --quiet HEAD';
const ok = (stdout) => ({ ok: true, stdout });
const exit = (status) => ({ ok: false, stdout: '', error: `exit ${status}`, status, stderr: '' });

test('git email shows HARNESS_GIT_EMAIL, or says the git config identity applies', () => {
  const { root, cleanup } = scratch();
  try {
    const set = vaultWith(root, ['HARNESS_GIT_EMAIL=vm@example.com']);
    assert.equal(Object.fromEntries(diagnose(set.env, root))['git email'], 'vm@example.com');
    const unset = vaultWith(root);
    assert.equal(
      Object.fromEntries(diagnose(unset.env, root))['git email'],
      '(unset: git config identity applies to realm commits)',
    );
  } finally {
    cleanup();
  }
});

test('realms missing names a listed realm with no folder on disk', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root, ['HARNESS_REALMS=projects:push,classes:push']);
    addRealm(vault, 'projects', 'none');
    const rows = Object.fromEntries(diagnose(env, root));
    assert.equal(rows['realms missing'], 'classes');
    assert.equal(rows['realms unlisted'], 'none');

    addRealm(vault, 'classes', 'none');
    assert.equal(Object.fromEntries(diagnose(env, root))['realms missing'], 'none');
  } finally {
    cleanup();
  }
});

test('the new rows come after realms unlisted, and every existing row keeps its place', () => {
  const { root, cleanup } = scratch();
  try {
    const { env } = vaultWith(root);
    const labels = diagnose(env, root).map(([label]) => label);
    assert.deepEqual(labels.slice(0, 6), [
      'machine file', 'machine', 'vault', 'realms on disk', 'realms listed', 'realms unlisted',
    ]);
    assert.deepEqual(labels.slice(6, 8), ['git email', 'realms missing']);
    assert.equal(labels.at(-1), 'transcripts');
  } finally {
    cleanup();
  }
});

test('realm rows: no .git, a .git file, an origin with its token stripped, no origin', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root);
    addRealm(vault, 'bare', 'none');
    addRealm(vault, 'linked', 'file');
    addRealm(vault, 'pushed');
    addRealm(vault, 'local');
    const { runGit, calls } = scriptedGit({
      [`pushed|${ORIGIN}`]: ok('https://x:token@github.com/o/r.git\n'),
      [`pushed|${COUNT}`]: ok('12\n'),
      [`local|${ORIGIN}`]: exit(2),
      [`local|${COUNT}`]: ok('3\n'),
    });
    const rows = Object.fromEntries(diagnose(env, root, { runGit }));
    assert.equal(rows['realm bare'], 'not a checkout (no .git)');
    assert.equal(rows['realm linked'], '.git is a file (worktree or submodule): not synced');
    assert.equal(rows['realm pushed'], 'git checkout, origin https://github.com/o/r.git, 12 commits');
    assert.equal(rows['realm local'], 'git checkout, no origin remote, 3 commits');
    assert.ok(!JSON.stringify(rows).includes('token'), 'a remote token never reaches the report');
    assert.ok(!rows['realm pushed'].includes('x:'), 'nor does the user part of the url');

    assert.ok(calls.every((call) => ['pushed', 'local'].includes(path.basename(call.cwd))), 'git runs only in real checkouts');
    assert.ok(calls.every((call) => call.timeoutMs === 5000), 'every doctor git call is bounded at 5 s');
  } finally {
    cleanup();
  }
});

const TIMED_OUT = Object.freeze({ ok: false, stdout: '', error: 'ETIMEDOUT', status: null });

test('realm rows: a failing remote lookup, an unborn branch, a count that fails', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root);
    addRealm(vault, 'fresh');
    addRealm(vault, 'broken');
    const { runGit } = scriptedGit({
      [`fresh|${ORIGIN}`]: exit(2),
      [`fresh|${COUNT}`]: exit(128),
      [`fresh|${UNBORN}`]: exit(1),
      [`broken|${ORIGIN}`]: exit(128),
      [`broken|${COUNT}`]: exit(128),
      [`broken|${UNBORN}`]: exit(128),
    });
    const rows = Object.fromEntries(diagnose(env, root, { runGit }));
    assert.equal(rows['realm fresh'], 'git checkout, no origin remote, no commits yet');
    assert.equal(rows['realm broken'], 'git checkout, remote unknown (exit 128), commit count unknown (exit 128)');
  } finally {
    cleanup();
  }
});

test('realm rows: when git does not answer, the second probe is never run', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root);
    addRealm(vault, 'silent');
    addRealm(vault, 'slow');
    const { runGit, calls } = scriptedGit({
      [`silent|${ORIGIN}`]: TIMED_OUT,
      [`slow|${ORIGIN}`]: exit(2),
      [`slow|${COUNT}`]: TIMED_OUT,
    });
    const rows = Object.fromEntries(diagnose(env, root, { runGit }));
    assert.equal(rows['realm silent'], 'git checkout, remote unknown (ETIMEDOUT), commit count skipped (git did not answer)');
    assert.equal(rows['realm slow'], 'git checkout, no origin remote, commit count unknown (ETIMEDOUT)');
    const asked = (realm) => calls.filter((call) => path.basename(call.cwd) === realm).map((call) => call.args.join(' '));
    assert.deepEqual(asked('silent'), [ORIGIN]);
    assert.deepEqual(asked('slow'), [ORIGIN, COUNT]);
  } finally {
    cleanup();
  }
});

test('realm rows name a lock holder, and mark a stale one', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root);
    const writeLock = (dir, startedAt) =>
      fs.writeFileSync(
        path.join(dir, '.git', 'harness-sync.lock'),
        `${JSON.stringify({ pid: 4242, owner: 'sync --push', startedAt, token: 'tok' })}\n`,
      );
    const fresh = new Date().toISOString();
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    writeLock(addRealm(vault, 'busy'), fresh);
    writeLock(addRealm(vault, 'dead'), old);
    const { runGit } = scriptedGit({
      [`busy|${ORIGIN}`]: exit(2),
      [`busy|${COUNT}`]: ok('1\n'),
      [`dead|${ORIGIN}`]: exit(2),
      [`dead|${COUNT}`]: ok('1\n'),
    });
    const rows = Object.fromEntries(diagnose(env, root, { runGit }));
    assert.equal(rows['realm busy'], `git checkout, no origin remote, lock held by sync --push, pid 4242, since ${fresh}, 1 commits`);
    assert.equal(rows['realm dead'], `git checkout, no origin remote, lock held by sync --push, pid 4242, since ${old} (stale), 1 commits`);
  } finally {
    cleanup();
  }
});

test('realm row against real git: unborn, then one commit and a file:// origin', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root);
    const realm = addRealm(vault, 'projects', 'none');
    const git = (...args) => execFileSync('git', ['-C', realm, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', '-b', 'main');
    assert.equal(Object.fromEntries(diagnose(env, root))['realm projects'], 'git checkout, no origin remote, no commits yet');

    git('add', '.realm');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    const origin = pathToFileURL(path.join(root, 'remote.git')).href;
    git('remote', 'add', 'origin', origin);
    assert.equal(Object.fromEntries(diagnose(env, root))['realm projects'], `git checkout, origin ${origin}, 1 commits`);
  } finally {
    cleanup();
  }
});

test('formatRows pads labels into one column, as main prints them', () => {
  assert.equal(formatRows([['a', '1'], ['long', '2']]), 'a     1\nlong  2');
});
