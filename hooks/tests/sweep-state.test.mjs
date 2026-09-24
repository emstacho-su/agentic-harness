/**
 * The nightly sweep of ~/.harness/state/session-start (SC-2): old *.json
 * files go, everything else in the folder stays.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sweepState } from '../lib/state-sweep.mjs';
import { EXIT_OK, EXIT_USAGE, parseArgs, run } from '../sweep-state.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-24T03:00:00.000Z');

function tempState(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-sweep-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'session-start');
  fs.mkdirSync(stateDir);
  return { root, stateDir };
}

function put(dir, name, ageDays) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '{}');
  const when = new Date(NOW - ageDays * DAY_MS);
  fs.utimesSync(file, when, when);
  return file;
}

function populate(stateDir) {
  put(stateDir, 'old-1.json', 10);
  put(stateDir, 'old-2.json', 8);
  put(stateDir, 'young.json', 2);
  put(stateDir, 'edge.json', 6.9);
  put(stateDir, 'old-notes.txt', 30);
  put(stateDir, 'old.json.bak', 30);
  const sub = path.join(stateDir, 'nested.json');
  fs.mkdirSync(sub);
  put(sub, 'deep-old.json', 30);
  const when = new Date(NOW - 30 * DAY_MS);
  fs.utimesSync(sub, when, when);
}

function names(dir) {
  return fs.readdirSync(dir).sort();
}

test('old json files are removed; young ones, other names and subdirectories stay', (t) => {
  const { stateDir } = tempState(t);
  populate(stateDir);

  const result = sweepState({ stateDir, maxAgeDays: 7, now: NOW });

  assert.deepEqual([...result.swept].sort(), ['old-1.json', 'old-2.json']);
  assert.equal(result.kept, 2);
  assert.equal(result.missing, false);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(names(stateDir), ['edge.json', 'nested.json', 'old-notes.txt', 'old.json.bak', 'young.json']);
  assert.deepEqual(names(path.join(stateDir, 'nested.json')), ['deep-old.json'], 'never recursive');
});

test('a dry run reports the same files and removes nothing', (t) => {
  const { stateDir } = tempState(t);
  populate(stateDir);
  const before = names(stateDir);

  const result = sweepState({ stateDir, maxAgeDays: 7, now: NOW, dryRun: true });

  assert.deepEqual([...result.swept].sort(), ['old-1.json', 'old-2.json']);
  assert.equal(result.kept, 2);
  assert.deepEqual(names(stateDir), before);
});

test('maxAgeDays moves the line', (t) => {
  const { stateDir } = tempState(t);
  populate(stateDir);
  const result = sweepState({ stateDir, maxAgeDays: 1, now: NOW, dryRun: true });
  assert.deepEqual([...result.swept].sort(), ['edge.json', 'old-1.json', 'old-2.json', 'young.json']);
  assert.equal(result.kept, 0);
});

test('a missing directory is reported, not an error', (t) => {
  const { root } = tempState(t);
  const result = sweepState({ stateDir: path.join(root, 'absent'), now: NOW });
  assert.deepEqual(result, { swept: [], kept: 0, missing: true, errors: [] });
});

test('a symlink named *.json is never removed', (t) => {
  const { root, stateDir } = tempState(t);
  const target = put(root, 'target.json', 30);
  const link = path.join(stateDir, 'link.json');
  try {
    fs.symlinkSync(target, link, 'file');
  } catch (error) {
    t.skip(`cannot create a symlink here (${error.code})`);
    return;
  }
  const when = new Date(NOW - 30 * DAY_MS);
  fs.lutimesSync(link, when, when);

  const result = sweepState({ stateDir, maxAgeDays: 7, now: NOW });

  assert.deepEqual(result.swept, []);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.existsSync(target));
});

test('bad arguments throw a clear error', () => {
  assert.throws(() => sweepState({ stateDir: '' }), /stateDir/);
  assert.throws(() => sweepState({ stateDir: '/x', maxAgeDays: 0 }), /maxAgeDays/);
  assert.throws(() => sweepState({ stateDir: '/x', maxAgeDays: Number.NaN }), /maxAgeDays/);
});

test('a state path that is a file, not a folder, throws', (t) => {
  const { root } = tempState(t);
  const file = put(root, 'plain.json', 0);
  assert.throws(() => sweepState({ stateDir: file, now: NOW }), /ENOTDIR|not a directory/);
});

// ------------------------------------------------------------------- the CLI

function cli(argv, now = NOW) {
  const out = [];
  const err = [];
  const code = run(argv, { env: { HARNESS_MACHINE_ENV: path.join(os.tmpdir(), 'no-such-machine.env') }, out: (l) => out.push(l), err: (l) => err.push(l), now });
  return { code, out, err };
}

test('the CLI prints one summary line and sweeps', (t) => {
  const { stateDir } = tempState(t);
  populate(stateDir);

  const { code, out, err } = cli(['--state-dir', stateDir]);

  assert.equal(code, EXIT_OK);
  assert.deepEqual(err, []);
  assert.deepEqual(out, [`session-start state: swept 2, kept 2 (older than 7 days) dir=${stateDir}`]);
  assert.ok(!fs.existsSync(path.join(stateDir, 'old-1.json')));
});

test('the CLI dry run says what it would sweep and removes nothing', (t) => {
  const { stateDir } = tempState(t);
  populate(stateDir);

  const { code, out } = cli(['--state-dir', stateDir, '--max-age-days', '9', '--dry-run']);

  assert.equal(code, EXIT_OK);
  assert.deepEqual(out, [`session-start state (dry run): would sweep 1, kept 3 (older than 9 days) dir=${stateDir}`]);
  assert.ok(fs.existsSync(path.join(stateDir, 'old-1.json')));
});

test('the CLI reports a missing folder and exits 0', (t) => {
  const { root } = tempState(t);
  const absent = path.join(root, 'absent');
  const { code, out } = cli(['--state-dir', absent]);
  assert.equal(code, EXIT_OK);
  assert.deepEqual(out, [`nothing to sweep: ${absent} does not exist`]);
});

test('the CLI exits 2 on bad arguments', () => {
  for (const argv of [['--max-age-days', '0'], ['--max-age-days', 'x'], ['--max-age-days', '1.5'], ['--max-age-days'], ['--state-dir'], ['--bogus']]) {
    const { code, err } = cli(argv);
    assert.equal(code, EXIT_USAGE, argv.join(' '));
    assert.match(err[0], /^error: /);
  }
});

test('the CLI --help prints usage and exits 0', () => {
  const { code, out } = cli(['--help']);
  assert.equal(code, EXIT_OK);
  assert.match(out[0], /usage: node sweep-state\.mjs/);
});

test('parseArgs defaults to the session-start folder under HARNESS_STATE_DIR', () => {
  const parsed = parseArgs([], { HARNESS_STATE_DIR: '/tmp/st' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.options.stateDir, path.join('/tmp/st', 'session-start'));
  assert.equal(parsed.options.maxAgeDays, 7);
  assert.equal(parsed.options.dryRun, false);
});
