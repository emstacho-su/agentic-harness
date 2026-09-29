/**
 * `~/.harness/machine.env`: the one file that says what this machine is.
 *
 * KEY=value, because that is the one format both tiers already read without a
 * dependency. The process environment always wins, so a value exported for one
 * run overrides the file, exactly as the Python side treats a repo `.env`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GIT_EMAIL_VAR,
  MACHINE_ENV_VAR,
  MACHINE_ENV_SEGMENTS,
  gitEmail,
  loadMachineEnv,
  parseEnvText,
  resolveHarnessConfig,
} from '../lib/machine-env.mjs';
import { parseRealmPolicies } from '../lib/realm-sync.mjs';

function scratchHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-env-'));
  return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('parseEnvText reads KEY=value, export prefixes, quotes and comments', () => {
  const parsed = parseEnvText([
    '# the vault',
    'HARNESS_VAULT=C:/Users/x/vault',
    "export HARNESS_MACHINE='home-pc'",
    'HARNESS_REALMS="projects:push, classes:local"',
    '',
    'EMPTY=',
  ].join('\n'));
  assert.deepEqual(parsed, {
    HARNESS_VAULT: 'C:/Users/x/vault',
    HARNESS_MACHINE: 'home-pc',
    HARNESS_REALMS: 'projects:push, classes:local',
    EMPTY: '',
  });
});

test('a line that is not KEY=value is refused by line number, never dropped', () => {
  assert.throws(() => parseEnvText('GOOD=1\nnot a pair\n'), /line 2/);
  assert.throws(() => parseEnvText('lower-case=1\n'), /line 1/);
});

test('the file fills in what the environment lacks, and never overrides it', () => {
  const { home, cleanup } = scratchHome();
  try {
    const file = path.join(home, ...MACHINE_ENV_SEGMENTS);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'HARNESS_VAULT=from-file\nHARNESS_MACHINE=home-pc\n');
    const merged = loadMachineEnv({ HARNESS_VAULT: 'from-shell' }, home);
    assert.equal(merged.HARNESS_VAULT, 'from-shell');
    assert.equal(merged.HARNESS_MACHINE, 'home-pc');
  } finally {
    cleanup();
  }
});

test('no file means the environment as it was', () => {
  const { home, cleanup } = scratchHome();
  try {
    const env = { HARNESS_VAULT: 'x' };
    assert.deepEqual(loadMachineEnv(env, home), env);
  } finally {
    cleanup();
  }
});

test(`${MACHINE_ENV_VAR} points at a file somewhere else`, () => {
  const { home, cleanup } = scratchHome();
  try {
    const elsewhere = path.join(home, 'elsewhere.env');
    fs.writeFileSync(elsewhere, 'HARNESS_MACHINE=vm\n');
    assert.equal(loadMachineEnv({ [MACHINE_ENV_VAR]: elsewhere }, home).HARNESS_MACHINE, 'vm');
  } finally {
    cleanup();
  }
});

test('a malformed file is reported and the environment is still returned', () => {
  const { home, cleanup } = scratchHome();
  try {
    const file = path.join(home, ...MACHINE_ENV_SEGMENTS);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'garbage\n');
    const problems = [];
    const merged = loadMachineEnv({ A: '1' }, home, (message) => problems.push(message));
    assert.deepEqual(merged, { A: '1' });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /line 1/);
  } finally {
    cleanup();
  }
});

test('machineName accepts a realm-shaped name and nothing else', async () => {
  const { machineName } = await import('../lib/machine-env.mjs');
  assert.equal(machineName({ HARNESS_MACHINE: 'home-pc' }), 'home-pc');
  assert.equal(machineName({ HARNESS_MACHINE: 'Home PC' }), '');
  assert.equal(machineName({ HARNESS_MACHINE: 'DESKTOP-ABC123' }), '', 'a hostname shape is refused');
  assert.equal(machineName({}), '');
});

test(`${GIT_EMAIL_VAR} is the realm commit email when it looks like one, else ''`, () => {
  assert.equal(GIT_EMAIL_VAR, 'HARNESS_GIT_EMAIL');
  assert.equal(gitEmail({ HARNESS_GIT_EMAIL: '  me@example.com ' }), 'me@example.com');
  assert.equal(gitEmail({}), '');
  assert.equal(gitEmail({ HARNESS_GIT_EMAIL: 'not an email' }), '');
  assert.equal(gitEmail({ HARNESS_GIT_EMAIL: 'a@b <x>' }), '');
  assert.equal(gitEmail({ HARNESS_GIT_EMAIL: 'a@b@c' }), '');
});

test('gitEmail reads the machine file, and the process environment wins over it', () => {
  const { home, cleanup } = scratchHome();
  try {
    const file = path.join(home, ...MACHINE_ENV_SEGMENTS);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'HARNESS_GIT_EMAIL=file@example.com\n');
    assert.equal(gitEmail(loadMachineEnv({}, home)), 'file@example.com');
    assert.equal(gitEmail(loadMachineEnv({ HARNESS_GIT_EMAIL: 'shell@example.com' }, home)), 'shell@example.com');
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------ resolveHarnessConfig (H-4)

const NO_MACHINE_FILE = path.join(os.tmpdir(), 'no-such-machine-env-fixture.env');

function homeWithMachineFile(text) {
  const scratch = scratchHome();
  const file = path.join(scratch.home, ...MACHINE_ENV_SEGMENTS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { ...scratch, file };
}

test('resolveHarnessConfig reads the machine file: vault, ingest project, machine and every realm', () => {
  const { home, file, cleanup } = homeWithMachineFile([
    'HARNESS_VAULT=C:/fixture/vault',
    'HARNESS_INGEST_PROJECT=C:/fixture/agentic-harness/ingest',
    'HARNESS_MACHINE=stack-laptop',
    'HARNESS_REALMS=projects:push,classes:push,harness:push',
    'HARNESS_GIT_EMAIL=someone@example.com',
  ].join('\n'));
  try {
    const config = resolveHarnessConfig({ env: {}, home });
    assert.deepEqual(Object.keys(config), ['machineFile', 'machine', 'vault', 'ingestProject', 'realms', 'realmCheck']);
    assert.equal(config.machineFile, file);
    assert.equal(config.machine, 'stack-laptop');
    assert.equal(config.vault, 'C:/fixture/vault');
    assert.equal(config.ingestProject, 'C:/fixture/agentic-harness/ingest');
    assert.deepEqual(config.realms, [
      { name: 'projects', policy: 'push' },
      { name: 'classes', policy: 'push' },
      { name: 'harness', policy: 'push' },
    ]);
    assert.equal(config.realmCheck, null);
    assert.ok(Object.isFrozen(config));
  } finally {
    cleanup();
  }
});

test('resolveHarnessConfig: the shell beats the machine file, and any number of realms is read', () => {
  const { home, cleanup } = homeWithMachineFile('HARNESS_VAULT=C:/from-file\nHARNESS_REALMS=projects:push\n');
  try {
    const config = resolveHarnessConfig({
      env: { HARNESS_VAULT: 'C:/from-shell', HARNESS_REALMS: 'a:local,b:push,c:push,d:local' },
      home,
    });
    assert.equal(config.vault, 'C:/from-shell');
    assert.deepEqual(config.realms.map((realm) => realm.name), ['a', 'b', 'c', 'd']);
  } finally {
    cleanup();
  }
});

test(`resolveHarnessConfig honours ${MACHINE_ENV_VAR} and never falls back to OneDrive`, () => {
  const { home, cleanup } = scratchHome();
  try {
    const elsewhere = path.join(home, 'vm.env');
    fs.writeFileSync(elsewhere, 'HARNESS_INGEST_PROJECT=/srv/ingest\n');
    const config = resolveHarnessConfig({ env: { [MACHINE_ENV_VAR]: elsewhere }, home });
    assert.equal(config.machineFile, elsewhere);
    assert.equal(config.ingestProject, '/srv/ingest');
    assert.equal(config.vault, '', 'no HARNESS_VAULT means no vault, not the OneDrive default');
    assert.deepEqual(config.realms, []);
  } finally {
    cleanup();
  }
});

test('resolveHarnessConfig reports each malformed realm entry and keeps the good ones', () => {
  const problems = [];
  const config = resolveHarnessConfig({
    env: {
      HARNESS_REALMS: 'projects:push, bad entry, classes:sideways, projects:local, harness:local',
      [MACHINE_ENV_VAR]: NO_MACHINE_FILE,
    },
    home: os.tmpdir(),
    report: (line) => problems.push(line),
  });
  assert.deepEqual(config.realms.map((realm) => realm.name), ['projects', 'harness']);
  assert.equal(problems.length, 3, problems.join('\n'));
});

test('its realm parser agrees with the sync on every valid list', () => {
  for (const text of ['projects:push', 'projects:push,classes:local', ' a:push , b-2:local,c:push ', '']) {
    const config = resolveHarnessConfig({ env: { HARNESS_REALMS: text, [MACHINE_ENV_VAR]: NO_MACHINE_FILE }, home: os.tmpdir() });
    assert.deepEqual(config.realms, parseRealmPolicies(text));
  }
});

test('requireRealm: a marker that reads the name passes; another name, none, or a bad name fails and names the path', () => {
  const { home, cleanup } = scratchHome();
  try {
    const vault = path.join(home, 'vault');
    fs.mkdirSync(path.join(vault, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(vault, 'classes'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'projects', '.realm'), 'projects\n');
    fs.writeFileSync(path.join(vault, 'classes', '.realm'), 'projects\n');
    const env = { HARNESS_VAULT: vault, [MACHINE_ENV_VAR]: NO_MACHINE_FILE };

    const good = resolveHarnessConfig({ env, home, requireRealm: 'projects' }).realmCheck;
    assert.deepEqual(good, { realm: 'projects', marker: path.join(vault, 'projects', '.realm'), ok: true, problem: '' });

    const bad = resolveHarnessConfig({ env, home, requireRealm: 'classes' }).realmCheck;
    assert.equal(bad.ok, false);
    assert.equal(bad.marker, path.join(vault, 'classes', '.realm'));
    assert.match(bad.problem, /reads 'projects'/);

    const missing = resolveHarnessConfig({ env, home, requireRealm: 'harness' }).realmCheck;
    assert.equal(missing.ok, false);
    assert.match(missing.problem, /no marker/);

    const unsafe = resolveHarnessConfig({ env, home, requireRealm: '../projects' }).realmCheck;
    assert.equal(unsafe.ok, false);
    assert.match(unsafe.problem, /not a realm name/);
  } finally {
    cleanup();
  }
});
