import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { diagnose, formatRows, problemRows, realmsOnDisk, runDoctor } from '../doctor.mjs';

const DOCTOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'doctor.mjs');

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

// ------------------------------------------------ problem status, the SessionStart rows, --strict

/**
 * The words bootstrap step 9 used to scan doctor's printed report for, before
 * a problem became a field of the row. Kept here only to prove the field and
 * the text agree on every row that existed then.
 */
const OLD_MARKERS = Object.freeze(['(MISSING', 'ABSENT', '(absent', '(not built', '(not found', 'ingest will refuse']);
const oldScanSaysProblem = ([label, value]) =>
  (label === 'realms missing' && value !== 'none') || OLD_MARKERS.some((marker) => value.includes(marker));
const NEW_ROWS = Object.freeze(['SessionStart hook', 'session-start log']);

test('every row is [label, value, problem], problem a boolean, frozen', () => {
  const { root, cleanup } = scratch();
  try {
    const { env } = vaultWith(root);
    for (const row of diagnose(env, root)) {
      assert.equal(row.length, 3, `row ${row[0]} is not a triple`);
      assert.equal(typeof row[1], 'string');
      assert.equal(typeof row[2], 'boolean', `row ${row[0]} has no problem flag`);
      assert.ok(Object.isFrozen(row));
    }
  } finally {
    cleanup();
  }
});

test('the problem field agrees with the text markers on every older row, in a bad and a good setup', () => {
  const { root, cleanup } = scratch();
  try {
    // Bad: no machine file, no vault, no ingest project, no uv, a CA cert that is not there.
    const bad = {
      HARNESS_MACHINE_ENV: path.join(root, 'absent.env'),
      HARNESS_VAULT: path.join(root, 'no-vault'),
      HARNESS_INGEST_PROJECT: path.join(root, 'no-ingest'),
      HARNESS_UV_BIN: path.join(root, 'no-uv.exe'),
      DATABASE_CA_CERT: path.join(root, 'no-ca.pem'),
    };
    // Good-ish: a machine file and a vault, but a listed realm missing and an unlisted one on disk.
    const { vault, env } = vaultWith(root, ['HARNESS_REALMS=projects:push']);
    addRealm(vault, 'stray', 'none');
    for (const rows of [diagnose(bad, root), diagnose(env, root)]) {
      for (const row of rows.filter(([label]) => !NEW_ROWS.includes(label))) {
        assert.equal(row[2], oldScanSaysProblem(row), `row ${row[0]} = ${row[1]}`);
      }
    }
    const badProblems = problemRows(diagnose(bad, root)).map(([label]) => label);
    for (const label of ['machine file', 'vault', 'ingest project', 'uv', 'DATABASE_CA_CERT']) {
      assert.ok(badProblems.includes(label), `${label} is not flagged`);
    }
    const flags = Object.fromEntries(diagnose(env, root).map(([label, , problem]) => [label, problem]));
    assert.equal(flags['realms missing'], true);
    assert.equal(flags['realms unlisted'], true);
    assert.equal(flags['machine file'], false);
    assert.equal(flags['vault'], false);
  } finally {
    cleanup();
  }
});

/** A settings.json under `<home>/.claude` holding `hooks` (or raw text); returns the hooks folder. */
function settingsWith(home, hooks) {
  const claude = path.join(home, '.claude');
  fs.mkdirSync(path.join(claude, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'settings.json'), typeof hooks === 'string' ? hooks : JSON.stringify({ hooks }));
  return path.join(claude, 'hooks').replace(/\\/g, '/');
}
const startHooks = (command) => ({
  SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command }] }],
});
const sessionStartRow = (env, home) => diagnose(env, home).find(([label]) => label === 'SessionStart hook');

test('SessionStart hook row: missing, not installed, registered, wrong script, unreadable', () => {
  const { root, cleanup } = scratch();
  try {
    const { env } = vaultWith(root);
    assert.deepEqual(sessionStartRow(env, root), [
      'SessionStart hook', '(not registered: node hooks/install.mjs registers it)', true,
    ]);

    const installed = path.join(root, '.claude', 'hooks', 'session-start.mjs');
    const hooksDir = settingsWith(root, startHooks(`"C:/node/node.exe" "${installed}"`));
    const script = `${hooksDir}/session-start.mjs`;
    assert.deepEqual(sessionStartRow(env, root), [
      'SessionStart hook', `registered: ${script} (MISSING: node hooks/install.mjs)`, true,
    ]);

    fs.writeFileSync(installed, '// installed\n');
    assert.deepEqual(sessionStartRow(env, root), ['SessionStart hook', `registered: ${script}`, false]);

    settingsWith(root, startHooks(`node "${hooksDir}/session-capture.mjs"`));
    assert.deepEqual(sessionStartRow(env, root), [
      'SessionStart hook', `(wrong script: ${hooksDir}/session-capture.mjs; expected ${script})`, true,
    ]);

    settingsWith(root, '{ "env": { "TOKEN": "hunter2" }, oops');
    const [, value, problem] = sessionStartRow(env, root);
    assert.equal(problem, true);
    assert.match(value, /settings\.json is not valid JSON/);
    assert.ok(!value.includes('hunter2'), 'no part of settings.json reaches the report');
  } finally {
    cleanup();
  }
});

test('session-start log row: none yet, then the age of the last line, and never a problem', () => {
  const { root, cleanup } = scratch();
  try {
    const log = path.join(root, 'logs', 'start.log');
    const { env } = vaultWith(root, [`HARNESS_SESSION_START_LOG=${log}`]);
    const now = () => Date.parse('2026-09-27T12:00:00.000Z');
    const logRow = () => diagnose(env, root, { now }).find(([label]) => label === 'session-start log');

    assert.deepEqual(logRow(), ['session-start log', `${log} (none yet: no session has started since install)`, false]);

    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, [
      '2026-09-25T12:00:00.000Z debug input-keys: cwd,session_id',
      '2026-09-27T11:55:00.000Z start abc projects/harness source=status rule=x ids=0 tokens=12 ms=40',
      '',
    ].join('\n'));
    assert.deepEqual(logRow(), ['session-start log', `${log}, last line 5m ago`, false]);

    fs.appendFileSync(log, 'garbage without a date\n');
    assert.deepEqual(logRow(), ['session-start log', `${log}, last line undated`, false]);
  } finally {
    cleanup();
  }
});

test('the new rows sit just before transcripts', () => {
  const { root, cleanup } = scratch();
  try {
    const { env } = vaultWith(root);
    const labels = diagnose(env, root).map(([label]) => label);
    assert.deepEqual(labels.slice(-3), ['SessionStart hook', 'session-start log', 'transcripts']);
  } finally {
    cleanup();
  }
});

const ROWS = Object.freeze([
  Object.freeze(['vault', '/v', false]),
  Object.freeze(['uv', '(not found: ~/.local/bin or PATH)', true]),
  Object.freeze(['SessionStart hook', '(not registered: node hooks/install.mjs registers it)', true]),
]);

test('runDoctor without --strict prints exactly the report and exits 0 whatever it finds', () => {
  const lines = [];
  const code = runDoctor([], { rows: () => ROWS, write: (text) => lines.push(text) });
  assert.equal(code, 0);
  assert.deepEqual(lines, [formatRows(ROWS)]);
});

test('runDoctor --strict exits 1 and names each problem row; 0 when there is none', () => {
  const lines = [];
  assert.equal(runDoctor(['--strict'], { rows: () => ROWS, write: (text) => lines.push(text) }), 1);
  assert.equal(lines[0], formatRows(ROWS));
  assert.deepEqual(lines.slice(1), ['doctor --strict: 2 problems', '  problem: uv', '  problem: SessionStart hook']);

  const clean = [];
  assert.equal(runDoctor(['--strict'], { rows: () => ROWS.slice(0, 1), write: (text) => clean.push(text) }), 0);
  assert.deepEqual(clean.slice(1), ['doctor --strict: no problems']);
});

test('runDoctor refuses an unknown argument with exit 2 and builds no report', () => {
  const lines = [];
  let built = false;
  const rows = () => {
    built = true;
    return ROWS;
  };
  assert.equal(runDoctor(['--strcit'], { rows, write: (text) => lines.push(text) }), 2);
  assert.equal(built, false);
  assert.match(lines.join('\n'), /unknown argument: --strcit/);
});

test('the CLI: --strict exits 1 on a bare machine, the plain run exits 0 with the same report', () => {
  const { root, cleanup } = scratch();
  try {
    const env = {
      ...process.env,
      USERPROFILE: root,
      HOME: root,
      HARNESS_MACHINE_ENV: path.join(root, 'absent.env'),
      HARNESS_VAULT: path.join(root, 'no-vault'),
    };
    const strict = spawnSync(process.execPath, [DOCTOR, '--strict'], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(strict.status, 1, strict.stderr);
    assert.match(strict.stdout, /doctor --strict: \d+ problems/);
    assert.match(strict.stdout, /problem: vault/);
    const plain = spawnSync(process.execPath, [DOCTOR], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(!plain.stdout.includes('doctor --strict'), 'the plain report is unchanged');
    assert.ok(strict.stdout.startsWith(plain.stdout.trimEnd()), 'strict prints the same report first');
  } finally {
    cleanup();
  }
});
