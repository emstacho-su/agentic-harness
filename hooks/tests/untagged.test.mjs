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

import { readSessionNotes, untaggedSessions } from '../untagged-sessions.mjs';
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

    const output = execFileSync(process.execPath, [SCRIPT, '--vault', sandbox.vaultRoot], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.match(output, /1 unclassified of 1 session notes/);

    const json = JSON.parse(
      execFileSync(process.execPath, [SCRIPT, '--vault', sandbox.vaultRoot, '--json'], {
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
