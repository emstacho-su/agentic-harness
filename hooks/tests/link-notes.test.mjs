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
const CR = String.fromCharCode(13);

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

function note({ parent = '', collection = 'agentic-harness', before = [], extra = [] } = {}) {
  return [
    '---',
    ...before,
    `id: 'session-${UUID}'`,
    "title: 'Session 2026-09-15 — agentic-harness'",
    'type: session',
    `collection: '${collection}'`,
    'tags:',
    "  - 'docs'",
    'supersedes: []',
    "resumed_from: ''",
    `parent_session: '${parent}'`,
    ...extra,
    '---',
  ].join('\n') + BODY;
}

const relink = (raw) => relinkNote(raw, 'projects', 'agentic-harness');

test('a session gains its links and nothing else changes', () => {
  const result = relink(note());

  assert.equal(result.error, '');
  assert.equal(result.changed, true);
  assert.deepEqual(result.added, ["up: '[[projects/agentic-harness/index|agentic-harness]]'", 'related: []']);
  assert.deepEqual(result.removed, []);
  assert.ok(result.text.endsWith(BODY), 'the body, handwritten tail and trailing whitespace included, is byte-identical');
});

test('a worker links up to its parent session', () => {
  const result = relink(note({ parent: UUID }));
  assert.ok(result.added.includes(`up: '[[${UUID}]]'`));
});

test('the index linked is the folder the note is in, whatever its collection field says', () => {
  for (const collection of ['misc', '']) {
    const result = relink(note({ collection }));
    assert.equal(result.error, '');
    assert.ok(result.added.includes("up: '[[projects/agentic-harness/index|agentic-harness]]'"), `collection: '${collection}'`);
  }
});

test('a second pass changes nothing', () => {
  const once = relink(note());
  const twice = relink(once.text);
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once.text);
});

test('a key added by hand survives', () => {
  const result = relink(note({ extra: ["mood: 'tired'"] }));
  assert.equal(result.error, '');
  assert.ok(result.text.includes("mood: 'tired'"));
});

test('a stale link written earlier is replaced, not kept', () => {
  const result = relink(note({ extra: ["up: '[[somewhere/else]]'"] }));
  assert.equal(result.error, '');
  assert.deepEqual(result.removed, ["up: '[[somewhere/else]]'"]);
  assert.ok(!result.text.includes('somewhere/else'));
});

test('a note whose other lines would be rewritten is refused, untouched', () => {
  // A hand-typed flow list re-serializes as a block list. Harmless, but this
  // pass promised to add links and nothing else, so it is reported instead.
  const raw = note({ extra: ['cwds_seen: [a, b]'] });
  const result = relink(raw);
  assert.match(result.error, /would also rewrite or move/);
  assert.equal(result.changed, false);
  assert.equal(result.text, raw);
});

test('a note whose keys are in an order of their own is refused, not reordered', () => {
  const raw = note({ before: ["mood: 'tired'"] });
  const result = relink(raw);
  assert.match(result.error, /would also rewrite or move/);
  assert.equal(result.text, raw);
});

test('CRLF frontmatter is refused: the serializer would re-end every line', () => {
  const raw = note().replaceAll('\n', `${CR}\n`);
  const result = relink(raw);
  assert.match(result.error, /frontmatter/);
  assert.equal(result.text, raw);
});

test('a bare carriage return in the block is refused: the parser and the cut could disagree', () => {
  const raw = note({ extra: [`mood: 'a${CR}b'`] });
  const result = relink(raw);
  assert.match(result.error, /carriage return/);
  assert.equal(result.text, raw);
});

test('a note that does not parse is refused, untouched', () => {
  const raw = "---\nid: 'unterminated\n---\nbody\n";
  const result = relink(raw);
  assert.notEqual(result.error, '');
  assert.equal(result.text, raw);
});

test('a note with no frontmatter is refused, untouched', () => {
  const result = relink('just a body\n');
  assert.notEqual(result.error, '');
  assert.equal(result.text, 'just a body\n');
});
