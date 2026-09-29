/**
 * `node hooks/resolve-config.mjs [--json] [--require-realm <name>]` (H-4, P-110).
 *
 * The one place a skill asks where this machine's vault and ingest project
 * are. Exit 0 when the vault exists and, with `--require-realm`, the realm's
 * `.realm` reads its name; exit 2 otherwise, naming the path it resolved.
 * Every machine file here is a fixture in a temp folder.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { EXIT_OK, EXIT_UNRESOLVED, run } from '../resolve-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'resolve-config.mjs');
const KEYS = ['machineFile', 'machine', 'vault', 'ingestProject', 'realms', 'realmCheck'];

/** A home with a machine file, and a vault holding the named realm folders (`null` = no marker). */
function fixture({ realms = { projects: 'projects', classes: 'classes' } } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-config-'));
  const vault = path.join(home, 'vault').replace(/\\/g, '/');
  for (const [folder, marker] of Object.entries(realms)) {
    fs.mkdirSync(path.join(vault, folder), { recursive: true });
    if (marker !== null) fs.writeFileSync(path.join(vault, folder, '.realm'), `${marker}\n`);
  }
  const machineFile = path.join(home, '.harness', 'machine.env');
  fs.mkdirSync(path.dirname(machineFile), { recursive: true });
  fs.writeFileSync(machineFile, [
    `HARNESS_VAULT=${vault}`,
    'HARNESS_INGEST_PROJECT=C:/fixture/agentic-harness/ingest',
    'HARNESS_MACHINE=stack-laptop',
    'HARNESS_REALMS=projects:push,classes:push,harness:push',
    'HARNESS_GIT_EMAIL=do-not-print@example.com',
  ].join('\n'));
  return { home, vault, machineFile, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function invoke(argv, { env = {}, home }) {
  const out = [];
  const err = [];
  const code = run(argv, { env, home, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('--json prints exactly the six keys and exits 0 when the vault exists', () => {
  const fx = fixture();
  try {
    const { code, out } = invoke(['--json'], { home: fx.home });
    assert.equal(code, EXIT_OK);
    const printed = JSON.parse(out);
    assert.deepEqual(Object.keys(printed), KEYS);
    assert.equal(printed.machineFile, fx.machineFile);
    assert.equal(printed.vault, fx.vault);
    assert.equal(printed.machine, 'stack-laptop');
    assert.equal(printed.ingestProject, 'C:/fixture/agentic-harness/ingest');
    assert.equal(printed.realms.length, 3);
    assert.equal(printed.realmCheck, null);
    assert.ok(!out.includes('do-not-print'), 'no other key of the machine file is printed');
  } finally {
    fx.cleanup();
  }
});

test('the shell beats the machine file', () => {
  const fx = fixture();
  const other = fixture();
  try {
    const { code, out } = invoke(['--json'], { home: fx.home, env: { HARNESS_VAULT: other.vault } });
    assert.equal(code, EXIT_OK);
    assert.equal(JSON.parse(out).vault, other.vault);
  } finally {
    fx.cleanup();
    other.cleanup();
  }
});

test('--require-realm projects passes when <vault>/projects/.realm reads projects', () => {
  const fx = fixture();
  try {
    const { code, out } = invoke(['--json', '--require-realm', 'projects'], { home: fx.home });
    assert.equal(code, EXIT_OK);
    assert.equal(JSON.parse(out).realmCheck.ok, true);
  } finally {
    fx.cleanup();
  }
});

test('--require-realm projects on a folder whose .realm reads classes exits 2 and names the path', () => {
  const fx = fixture({ realms: { projects: 'classes' } });
  try {
    const { code, err } = invoke(['--require-realm', 'projects'], { home: fx.home });
    assert.equal(code, EXIT_UNRESOLVED);
    assert.ok(err.includes(path.join(fx.vault, 'projects', '.realm')), err);
    assert.match(err, /reads 'classes'/);
  } finally {
    fx.cleanup();
  }
});

test('a missing marker exits 2 and names the path', () => {
  const fx = fixture({ realms: { projects: null } });
  try {
    const { code, err } = invoke(['--require-realm', 'projects'], { home: fx.home });
    assert.equal(code, EXIT_UNRESOLVED);
    assert.ok(err.includes(path.join(fx.vault, 'projects', '.realm')), err);
  } finally {
    fx.cleanup();
  }
});

test('a vault that does not exist exits 2 and names the path', () => {
  const fx = fixture();
  try {
    const gone = `${fx.vault}-missing`;
    const { code, err } = invoke([], { home: fx.home, env: { HARNESS_VAULT: gone } });
    assert.equal(code, EXIT_UNRESOLVED);
    assert.ok(err.includes(gone), err);
  } finally {
    fx.cleanup();
  }
});

test('no HARNESS_VAULT anywhere exits 2 and names the machine file it read; no OneDrive fallback', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-config-empty-'));
  try {
    const { code, out, err } = invoke(['--json'], { home });
    assert.equal(code, EXIT_UNRESOLVED);
    assert.ok(err.includes(path.join(home, '.harness', 'machine.env')), err);
    assert.ok(!`${out}${err}`.includes('OneDrive'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('without --json it prints one key=value line per key', () => {
  const fx = fixture();
  try {
    const { code, out } = invoke(['--require-realm', 'projects'], { home: fx.home });
    assert.equal(code, EXIT_OK);
    assert.deepEqual(out.split('\n').map((line) => line.split('=')[0]), KEYS);
    assert.match(out, /^realms=projects:push,classes:push,harness:push$/m);
    assert.match(out, /^realmCheck=projects ok$/m);
  } finally {
    fx.cleanup();
  }
});

test('bad usage exits 2', () => {
  const fx = fixture();
  try {
    assert.equal(invoke(['--bogus'], { home: fx.home }).code, EXIT_UNRESOLVED);
    assert.equal(invoke(['--require-realm'], { home: fx.home }).code, EXIT_UNRESOLVED);
  } finally {
    fx.cleanup();
  }
});

test('as a process: HARNESS_MACHINE_ENV points it at a fixture, --json parses, exit 0', () => {
  const fx = fixture();
  try {
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? '', HARNESS_MACHINE_ENV: fx.machineFile };
    const stdout = execFileSync(process.execPath, [CLI, '--json', '--require-realm', 'projects'], { env, encoding: 'utf8' });
    assert.equal(JSON.parse(stdout).vault, fx.vault);
  } finally {
    fx.cleanup();
  }
});
