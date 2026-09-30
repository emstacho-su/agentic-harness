/**
 * The weekly "untagged sessions" list (R-27.4).
 *
 * The list is the only thing that stops `unclassified` becoming a silent
 * dumping ground, so it has to find every such note across both vault areas and
 * report — rather than skip — a note it cannot read.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { UNTAGGED_EARLY_TRIGGER, readSessionNotes, run, untaggedSessions } from '../untagged-sessions.mjs';
import { createSandbox, installTranscript } from './helpers/sandbox.mjs';
import { SCENARIOS, runScenario } from './helpers/scenarios.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'untagged-sessions.mjs');

function writeNote(sandbox, area, collection, name, fields, body = '## What I asked for\n\n1. Think about the plan.\n') {
  const dir = path.join(sandbox.vaultRoot, area, collection, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = Object.entries(fields)
    .map(([key, value]) => (Array.isArray(value) ? `${key}: [${value.map((v) => `'${v}'`).join(', ')}]` : `${key}: '${value}'`))
    .join('\n');
  fs.writeFileSync(path.join(dir, name), `---\n${frontmatter}\n---\n\n${body}`, 'utf8');
}

test('the list finds unclassified notes in both areas, newest first', () => {
  const sandbox = createSandbox();
  try {
    writeNote(sandbox, 'projects', 'bb2dash', 'a.md', {
      session_id: 'a', date: '2026-09-10', collection: 'bb2dash', status: 'concluded', tags: ['unclassified'],
    });
    writeNote(sandbox, 'classes', 'ist323', 'b.md', {
      session_id: 'b', date: '2026-09-14', collection: 'ist323', status: 'concluded', tags: ['unclassified'],
    });
    writeNote(sandbox, 'projects', 'bb2dash', 'c.md', {
      session_id: 'c', date: '2026-09-12', collection: 'bb2dash', status: 'concluded', tags: ['db', 'pr'],
    });

    const { notes, problems } = readSessionNotes(sandbox.vaultRoot);
    assert.equal(notes.length, 3);
    assert.deepEqual(problems, []);

    const rows = untaggedSessions(notes);
    assert.deepEqual(rows.map((row) => row.session_id), ['b', 'a']);
    assert.equal(rows[0].first_prompt, 'Think about the plan.');
  } finally {
    sandbox.cleanup();
  }
});

test('--since narrows the window', () => {
  const sandbox = createSandbox();
  try {
    writeNote(sandbox, 'projects', 'bb2dash', 'a.md', {
      session_id: 'a', date: '2026-09-01', collection: 'bb2dash', status: 'concluded', tags: ['unclassified'],
    });
    writeNote(sandbox, 'projects', 'bb2dash', 'b.md', {
      session_id: 'b', date: '2026-09-14', collection: 'bb2dash', status: 'concluded', tags: ['unclassified'],
    });
    const { notes } = readSessionNotes(sandbox.vaultRoot);
    assert.deepEqual(untaggedSessions(notes, '2026-09-08').map((row) => row.session_id), ['b']);
  } finally {
    sandbox.cleanup();
  }
});

test('an unreadable note is reported, not skipped', () => {
  const sandbox = createSandbox();
  try {
    const dir = path.join(sandbox.vaultRoot, 'projects', 'bb2dash', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.md'), '---\ntags: [oops\n---\n\nbody\n', 'utf8');

    const { notes, problems } = readSessionNotes(sandbox.vaultRoot);
    assert.equal(notes.length, 0);
    assert.equal(problems.length, 1);
    assert.match(problems[0].error, /flow sequence/);
  } finally {
    sandbox.cleanup();
  }
});

test('a real captured session that classified cleanly is not on the list', () => {
  const sandbox = createSandbox();
  try {
    const scenario = SCENARIOS.find((candidate) => candidate.name === 'plain-main');
    runScenario(sandbox, scenario);
    const { notes } = readSessionNotes(sandbox.vaultRoot);
    assert.equal(untaggedSessions(notes).length, 0);
  } finally {
    sandbox.cleanup();
  }
});

test('the CLI prints the count and exits 0', () => {
  const sandbox = createSandbox();
  try {
    installTranscript(sandbox, 'class', '77777777-7777-4777-8777-777777777777');
    writeNote(sandbox, 'projects', 'bb2dash', 'a.md', {
      session_id: 'a', date: '2026-09-10', collection: 'bb2dash', status: 'concluded', tags: ['unclassified'],
    });

    // A state file that does not exist, so the real one is never read.
    const state = path.join(sandbox.root, 'state', 'untagged-review.json');
    const output = execFileSync(process.execPath, [SCRIPT, '--vault', sandbox.vaultRoot, '--state', state], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.match(output, /1 unclassified of 1 session notes/);

    const json = JSON.parse(
      execFileSync(process.execPath, [SCRIPT, '--vault', sandbox.vaultRoot, '--json', '--state', state], {
        encoding: 'utf8',
        timeout: 30_000,
      }),
    );
    assert.equal(json.unclassified.length, 1);
    assert.equal(json.unclassified[0].session_id, 'a');
  } finally {
    sandbox.cleanup();
  }
});

// ------------------------------------------------ cadence (H-5, R-103, P-111)

const NOW = new Date('2026-09-29T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** `count` unclassified notes ended at `endedAt`, in the projects area. */
function writeUntagged(sandbox, count, endedAt, extra = {}) {
  for (let i = 0; i < count; i += 1) {
    const id = `${extra.prefix ?? 'n'}${i}`;
    writeNote(sandbox, 'projects', 'bb2dash', `${id}.md`, {
      session_id: id, date: endedAt.slice(0, 10), ended_at: endedAt, collection: 'bb2dash',
      status: 'concluded', tags: ['unclassified'], origin: extra.origin ?? '',
    });
  }
}

/** Run the CLI in-process with a fixture machine file naming the sandbox vault. */
function cli(sandbox, argv) {
  const machineFile = path.join(sandbox.root, 'machine.env');
  fs.writeFileSync(machineFile, `HARNESS_VAULT=${sandbox.vaultRoot.replace(/\\/g, '/')}\n`, 'utf8');
  const out = [];
  const err = [];
  const code = run(argv, {
    env: { HARNESS_MACHINE_ENV: machineFile },
    home: sandbox.root,
    now: () => NOW,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function statePath(sandbox) {
  return path.join(sandbox.root, '.harness', 'state', 'untagged-review.json');
}

function writeState(sandbox, reviewedAt) {
  fs.mkdirSync(path.dirname(statePath(sandbox)), { recursive: true });
  fs.writeFileSync(statePath(sandbox), JSON.stringify({ reviewed_at: reviewedAt }), 'utf8');
}

test('the early trigger is 25 and exported from this file', () => {
  assert.equal(UNTAGGED_EARLY_TRIGGER, 25);
});

test('the vault comes from the machine file, not the OneDrive default', () => {
  const sandbox = createSandbox();
  try {
    writeUntagged(sandbox, 2, '2026-09-28T10:00:00.000Z');
    writeState(sandbox, '2026-09-27T00:00:00.000Z');
    const { code, out } = cli(sandbox, ['--json']);
    assert.equal(code, 0);
    const json = JSON.parse(out);
    assert.equal(json.vault, sandbox.vaultRoot.replace(/\\/g, '/'));
    assert.equal(json.unclassified.length, 2);
    const source = fs.readFileSync(SCRIPT, 'utf8');
    assert.equal((source.match(/DEFAULT_VAULT_SEGMENTS/g) ?? []).length, 0);
  } finally {
    sandbox.cleanup();
  }
});

test('no vault anywhere is an error, exit 2', () => {
  const sandbox = createSandbox();
  try {
    const code = run(['--json'], {
      env: { HARNESS_MACHINE_ENV: path.join(sandbox.root, 'none.env') },
      home: sandbox.root,
      now: () => NOW,
      out: () => {},
      err: () => {},
    });
    assert.equal(code, 2);
  } finally {
    sandbox.cleanup();
  }
});

test('SDK sessions are left out unless --include-sdk', () => {
  const sandbox = createSandbox();
  try {
    writeUntagged(sandbox, 1, '2026-09-28T10:00:00.000Z', { prefix: 'mine' });
    writeUntagged(sandbox, 2, '2026-09-28T10:00:00.000Z', { prefix: 'sdk', origin: 'sdk-cli' });
    writeState(sandbox, '2026-09-27T00:00:00.000Z');
    assert.equal(JSON.parse(cli(sandbox, ['--json']).out).unclassified.length, 1);
    assert.equal(JSON.parse(cli(sandbox, ['--json', '--include-sdk']).out).unclassified.length, 3);
  } finally {
    sandbox.cleanup();
  }
});

test('--since defaults to the last review, and an explicit --since overrides it', () => {
  const sandbox = createSandbox();
  try {
    writeUntagged(sandbox, 1, '2026-09-20T10:00:00.000Z', { prefix: 'old' });
    writeUntagged(sandbox, 1, '2026-09-28T10:00:00.000Z', { prefix: 'new' });
    writeState(sandbox, '2026-09-25T00:00:00.000Z');
    assert.deepEqual(JSON.parse(cli(sandbox, ['--json']).out).unclassified.map((row) => row.session_id), ['new0']);
    assert.equal(JSON.parse(cli(sandbox, ['--json', '--since', '2026-09-01']).out).unclassified.length, 2);
  } finally {
    sandbox.cleanup();
  }
});

test('--due exits 3 when there is no state file', () => {
  const sandbox = createSandbox();
  try {
    const { code, out } = cli(sandbox, ['--due']);
    assert.equal(code, 3);
    assert.match(out, /due/);
  } finally {
    sandbox.cleanup();
  }
});

test('--due exits 3 when the last review is 7 days old, 0 when it is younger', () => {
  const sandbox = createSandbox();
  try {
    writeState(sandbox, new Date(NOW.getTime() - 7 * DAY_MS).toISOString());
    assert.equal(cli(sandbox, ['--due']).code, 3);
    writeState(sandbox, new Date(NOW.getTime() - 7 * DAY_MS + 60_000).toISOString());
    assert.equal(cli(sandbox, ['--due']).code, 0);
  } finally {
    sandbox.cleanup();
  }
});

test('--due exits 3 at 25 untagged notes since the review, 0 at 24; --threshold moves it', () => {
  const sandbox = createSandbox();
  try {
    writeState(sandbox, '2026-09-28T00:00:00.000Z');
    writeUntagged(sandbox, 24, '2026-09-28T10:00:00.000Z', { prefix: 'a' });
    writeUntagged(sandbox, 3, '2026-09-27T10:00:00.000Z', { prefix: 'before' });
    assert.equal(cli(sandbox, ['--due']).code, 0, 'notes before the review do not count');
    assert.equal(cli(sandbox, ['--due', '--threshold', '24']).code, 3);
    writeUntagged(sandbox, 1, '2026-09-29T09:00:00.000Z', { prefix: 'b' });
    assert.equal(cli(sandbox, ['--due']).code, 3);
  } finally {
    sandbox.cleanup();
  }
});

test('a state file that will not parse is reported and counts as no review', () => {
  const sandbox = createSandbox();
  try {
    fs.mkdirSync(path.dirname(statePath(sandbox)), { recursive: true });
    fs.writeFileSync(statePath(sandbox), '{ not json', 'utf8');
    const { code, err } = cli(sandbox, ['--due']);
    assert.equal(code, 3);
    assert.match(err, /untagged-review\.json/);
  } finally {
    sandbox.cleanup();
  }
});

test('--mark-reviewed creates the state folder and writes reviewed_at; --due is then 0', () => {
  const sandbox = createSandbox();
  try {
    assert.equal(fs.existsSync(path.dirname(statePath(sandbox))), false);
    writeUntagged(sandbox, 2, '2026-09-28T10:00:00.000Z');
    assert.equal(cli(sandbox, ['--mark-reviewed']).code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath(sandbox), 'utf8')), { reviewed_at: NOW.toISOString() });
    assert.equal(cli(sandbox, ['--due']).code, 0);
    assert.equal(JSON.parse(cli(sandbox, ['--json']).out).unclassified.length, 0);
  } finally {
    sandbox.cleanup();
  }
});

test('--state points the review record somewhere else', () => {
  const sandbox = createSandbox();
  try {
    const elsewhere = path.join(sandbox.root, 'other', 'review.json');
    assert.equal(cli(sandbox, ['--mark-reviewed', '--state', elsewhere]).code, 0);
    assert.ok(fs.existsSync(elsewhere));
    assert.equal(fs.existsSync(statePath(sandbox)), false);
    assert.equal(cli(sandbox, ['--due', '--state', elsewhere]).code, 0);
  } finally {
    sandbox.cleanup();
  }
});

test('bad usage exits 2', () => {
  const sandbox = createSandbox();
  try {
    assert.equal(cli(sandbox, ['--threshold', '0']).code, 2);
    assert.equal(cli(sandbox, ['--threshold', 'x']).code, 2);
    assert.equal(cli(sandbox, ['--since']).code, 2);
    assert.equal(cli(sandbox, ['--bogus']).code, 2);
  } finally {
    sandbox.cleanup();
  }
});
