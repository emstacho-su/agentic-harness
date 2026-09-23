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

import { GIT_EMAIL_VAR, MACHINE_ENV_VAR, MACHINE_ENV_SEGMENTS, gitEmail, loadMachineEnv, parseEnvText } from '../lib/machine-env.mjs';

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
