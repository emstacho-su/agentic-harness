/**
 * The one-time Outcome backfill: notes written before the hook captured the
 * closing message get it from the transcript their own fact table names.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { backfillOutcomes } from '../backfill-outcome.mjs';
import { insertOutcome, transcriptPathFrom } from '../lib/outcome-backfill.mjs';
import { HANDWRITTEN_MARKER } from '../lib/note.mjs';

const FRONTMATTER = '---\nid: session-abc\ntype: session\n---\n';

function noteWith(transcriptPath, { subagent = false, extra = '' } = {}) {
  return (
    `${FRONTMATTER}\n# Session 2026-09-15 — demo\n\n## What I asked for\n\n1. Do the thing.\n\n` +
    `## Session facts\n\n| Field | Value |\n| --- | --- |\n| Session id | \`abc\` |\n` +
    `| Transcript | \`${transcriptPath}\` |\n\n${HANDWRITTEN_MARKER}\n${extra}` +
    (subagent ? '' : '')
  );
}

function transcript(lines) {
  return lines.map((line) => JSON.stringify(line)).join('\n');
}

const USER = { type: 'user', message: { content: [{ type: 'text', text: 'Do the thing with postgresql://u:Sup3rSecretPassw0rd@host/db' }] } };
const CLOSING = { type: 'assistant', message: { content: [{ type: 'text', text: 'Done. The password Sup3rSecretPassw0rd should be rotated.' }] } };

function scratchVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-backfill-'));
  const sessions = path.join(root, 'vault', 'projects', 'demo', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  return { root, vault: path.join(root, 'vault'), sessions, backup: path.join(root, 'backup') };
}

// ------------------------------------------------------------------ pure parts

test('the transcript path is read from the fact table', () => {
  assert.equal(transcriptPathFrom(noteWith('C:/Users/x/.claude/projects/p/abc.jsonl')), 'C:/Users/x/.claude/projects/p/abc.jsonl');
  assert.equal(transcriptPathFrom('no table here'), '');
});

test('the section goes directly above the session facts', () => {
  const result = insertOutcome(noteWith('t.jsonl'), ['## Outcome', '', '> Done.', '']);
  assert.equal(result.changed, true);
  assert.ok(result.text.indexOf('## Outcome') < result.text.indexOf('## Session facts'));
  assert.ok(result.text.indexOf('## What I asked for') < result.text.indexOf('## Outcome'));
  assert.ok(result.text.startsWith(FRONTMATTER), 'frontmatter is untouched');
});

test('a note that already has an outcome is left alone', () => {
  const once = insertOutcome(noteWith('t.jsonl'), ['## Outcome', '', '> Done.', '']).text;
  assert.equal(insertOutcome(once, ['## Outcome', '', '> Again.', '']).changed, false);
});

test('a note with no session facts heading is refused, not guessed at', () => {
  const result = insertOutcome(`${FRONTMATTER}\njust prose\n`, ['## Outcome', '', '> Done.', '']);
  assert.equal(result.changed, false);
  assert.match(result.error, /Session facts/);
});

// ------------------------------------------------------------------ whole run

test('a real run adds the outcome, redacts it, keeps hand-written text and backs up the original', () => {
  const { root, vault, sessions, backup } = scratchVault();
  try {
    const transcriptPath = path.join(root, 'abc.jsonl').replace(/\\/g, '/');
    fs.writeFileSync(transcriptPath, transcript([USER, CLOSING]));
    const notePath = path.join(sessions, 'abc.md');
    const original = noteWith(transcriptPath, { extra: '\nMy own notes stay.\n' });
    fs.writeFileSync(notePath, original);

    const report = backfillOutcomes({ vault, backup });
    const written = fs.readFileSync(notePath, 'utf8');

    assert.deepEqual(report.added, [notePath]);
    assert.ok(written.includes('> Done. The password [REDACTED] should be rotated.'));
    assert.ok(!written.includes('Sup3rSecretPassw0rd'));
    assert.ok(written.endsWith('My own notes stay.\n'));
    assert.equal(fs.readFileSync(path.join(backup, 'projects', 'demo', 'sessions', 'abc.md'), 'utf8'), original);

    const again = backfillOutcomes({ vault, backup });
    assert.deepEqual(again.added, []);
    assert.equal(again.alreadyPresent, 1);
    assert.equal(fs.readFileSync(path.join(backup, 'projects', 'demo', 'sessions', 'abc.md'), 'utf8'), original, 'the backup still holds the original');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a dry run changes nothing and needs no backup directory', () => {
  const { root, vault, sessions } = scratchVault();
  try {
    const transcriptPath = path.join(root, 'abc.jsonl').replace(/\\/g, '/');
    fs.writeFileSync(transcriptPath, transcript([USER, CLOSING]));
    const notePath = path.join(sessions, 'abc.md');
    const original = noteWith(transcriptPath);
    fs.writeFileSync(notePath, original);

    const report = backfillOutcomes({ vault, dryRun: true });
    assert.deepEqual(report.added, [notePath]);
    assert.equal(fs.readFileSync(notePath, 'utf8'), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing transcript and a session with no closing message are counted, not errors', () => {
  const { root, vault, sessions, backup } = scratchVault();
  try {
    fs.writeFileSync(path.join(sessions, 'gone.md'), noteWith(path.join(root, 'gone.jsonl').replace(/\\/g, '/')));
    const silentPath = path.join(root, 'silent.jsonl').replace(/\\/g, '/');
    fs.writeFileSync(silentPath, transcript([USER]));
    fs.writeFileSync(path.join(sessions, 'silent.md'), noteWith(silentPath));

    const report = backfillOutcomes({ vault, backup });
    assert.equal(report.transcriptGone, 1);
    assert.equal(report.noOutcome, 1);
    assert.deepEqual(report.added, []);
    assert.deepEqual(report.refused, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a subagent's note reads its all-sidechain transcript", () => {
  const { root, vault, sessions, backup } = scratchVault();
  try {
    const transcriptPath = path.join(root, 'agent-a1.jsonl').replace(/\\/g, '/');
    fs.writeFileSync(transcriptPath, transcript([{ ...USER, isSidechain: true }, { ...CLOSING, isSidechain: true }]));
    const notePath = path.join(sessions, 'abc--a1.md');
    fs.writeFileSync(notePath, noteWith(transcriptPath));

    assert.deepEqual(backfillOutcomes({ vault, backup }).added, [notePath]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
