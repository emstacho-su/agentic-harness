/**
 * The one-shot link backfill, as units.
 *
 * The promise it has to keep: the frontmatter gains `up` and `related`, and not
 * one other byte of the note changes. `ingest` hashes the body, so a body that
 * moved would re-embed every note in the vault.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { relinkNote } from '../lib/link-notes.mjs';
import { HANDWRITTEN_MARKER } from '../lib/note.mjs';

const UUID = '422db168-8894-4b80-ac32-384e765cad3c';

const BODY = [
  '',
  '# Session 2026-09-15 — agentic-harness',
  '',
  '## Session facts',
  '',
  '| Field | Value |',
  '| --- | --- |',
  '',
  HANDWRITTEN_MARKER,
  '',
  'A paragraph typed by hand, with a [[link of my own]].   ',
  '',
  '',
].join('\n');

function note({ parent = '', extra = [] } = {}) {
  return [
    '---',
    `id: 'session-${UUID}'`,
    "title: 'Session 2026-09-15 — agentic-harness'",
    'type: session',
    "collection: 'agentic-harness'",
    'supersedes: []',
    "resumed_from: ''",
    `parent_session: '${parent}'`,
    'tags:',
    "  - 'docs'",
    ...extra,
    '---',
  ].join('\n') + BODY;
}

test('a session gains its links and nothing else changes', () => {
  const raw = note();
  const result = relinkNote(raw, 'projects');

  assert.equal(result.error, '');
  assert.equal(result.changed, true);
  assert.deepEqual(result.added, ["up: '[[projects/agentic-harness/index|agentic-harness]]'", 'related: []']);
  assert.deepEqual(result.removed, []);
  assert.ok(result.text.endsWith(BODY), 'the body, handwritten tail and trailing whitespace included, is byte-identical');
});

test('a worker links up to its parent session', () => {
  const result = relinkNote(note({ parent: UUID }), 'projects');
  assert.ok(result.added.includes(`up: '[[${UUID}]]'`));
});

test('a second pass changes nothing', () => {
  const once = relinkNote(note(), 'projects');
  const twice = relinkNote(once.text, 'projects');
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once.text);
});

test('a key added by hand survives', () => {
  const result = relinkNote(note({ extra: ["mood: 'tired'"] }), 'projects');
  assert.equal(result.error, '');
  assert.ok(result.text.includes("mood: 'tired'"));
});

test('a stale link written earlier is replaced, not kept', () => {
  const result = relinkNote(note({ extra: ["up: '[[somewhere/else]]'"] }), 'projects');
  assert.equal(result.error, '');
  assert.deepEqual(result.removed, ["up: '[[somewhere/else]]'"]);
  assert.ok(!result.text.includes('somewhere/else'));
});

test('a note whose other lines would be rewritten is refused, untouched', () => {
  // A hand-typed flow list re-serializes as a block list. Harmless, but this
  // pass promised to add links and nothing else, so it is reported instead.
  const raw = note({ extra: ['cwds_seen: [a, b]'] });
  const result = relinkNote(raw, 'projects');
  assert.match(result.error, /would also rewrite/);
  assert.equal(result.changed, false);
  assert.equal(result.text, raw);
});

test('a note that does not parse is refused, untouched', () => {
  const raw = "---\nid: 'unterminated\n---\nbody\n";
  const result = relinkNote(raw, 'projects');
  assert.notEqual(result.error, '');
  assert.equal(result.text, raw);
});

test('a note with no frontmatter is refused, untouched', () => {
  const result = relinkNote('just a body\n', 'projects');
  assert.notEqual(result.error, '');
  assert.equal(result.text, 'just a body\n');
});
