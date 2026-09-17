/**
 * The derived Obsidian links, as units.
 *
 * Obsidian draws a graph edge only for a `[[wikilink]]`, and the relational
 * fields hold raw ids because the RAG store filters on them. These rules are
 * the projection from one to the other.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { indexLink, noteStem, sessionLink, withLinks } from '../lib/links.mjs';

const UUID = '422db168-8894-4b80-ac32-384e765cad3c';

const BASE = Object.freeze({
  id: `session-${UUID}`,
  collection: 'agentic-harness',
  parent_session: '',
  resumed_from: '',
  supersedes: [],
  up: '',
  related: [],
});

test('noteStem: a note id loses its prefix, in all three filename shapes', () => {
  assert.equal(noteStem(`session-${UUID}`), UUID);
  assert.equal(noteStem(`session-${UUID}-r2`), `${UUID}-r2`);
  assert.equal(noteStem(`session-${UUID}--a0283f0fe443b2b69`), `${UUID}--a0283f0fe443b2b69`);
});

test('noteStem: parent_session is already a bare session id', () => {
  assert.equal(noteStem(UUID), UUID);
});

test('noteStem: anything that could break out of a wikilink is refused', () => {
  for (const hostile of ['a]]b', 'a|b', 'a#b', 'a/b', '../x', 'a b', '', null, undefined, 'session-']) {
    assert.equal(noteStem(hostile), '', `accepted ${JSON.stringify(hostile)}`);
  }
});

test('sessionLink: the short form, because a UUID stem is unique vault-wide', () => {
  assert.equal(sessionLink(`session-${UUID}`), `[[${UUID}]]`);
  assert.equal(sessionLink('a]]b'), '');
});

test('indexLink: the full path, because every collection has a note called index', () => {
  assert.equal(indexLink('projects', 'bb2dash'), '[[projects/bb2dash/index|bb2dash]]');
  assert.equal(indexLink('classes', 'ist323'), '[[classes/ist323/index|ist323]]');
});

test('indexLink: an unknown area or an unsafe collection yields no link', () => {
  assert.equal(indexLink('elsewhere', 'bb2dash'), '');
  assert.equal(indexLink('projects', 'a|b'), '');
  assert.equal(indexLink('projects', ''), '');
  assert.equal(indexLink('', 'bb2dash'), '');
});

test('withLinks: a top-level session links up to its collection index', () => {
  const linked = withLinks(BASE, 'projects');
  assert.equal(linked.up, '[[projects/agentic-harness/index|agentic-harness]]');
  assert.deepEqual(linked.related, []);
});

test('withLinks: a worker links up to its parent session, not the index', () => {
  const linked = withLinks({ ...BASE, parent_session: UUID }, 'projects');
  assert.equal(linked.up, `[[${UUID}]]`);
});

test('withLinks: a hostile parent id falls back to the index', () => {
  const linked = withLinks({ ...BASE, parent_session: 'x]]|[[evil' }, 'projects');
  assert.equal(linked.up, '[[projects/agentic-harness/index|agentic-harness]]');
});

test('withLinks: a parent that is filename-safe but not a session id is not followed', () => {
  // A checkpoint note arrives through git. `README` would otherwise make any
  // note in the vault this note's parent.
  for (const parent of ['README', 'index', `${UUID}-r2`, `session-${UUID}`]) {
    const linked = withLinks({ ...BASE, parent_session: parent }, 'projects');
    assert.equal(linked.up, '[[projects/agentic-harness/index|agentic-harness]]', parent);
  }
});

test('withLinks: the index is where the note is filed, when the caller knows better', () => {
  const linked = withLinks({ ...BASE, collection: 'misc' }, 'projects', 'bb2dash');
  assert.equal(linked.up, '[[projects/bb2dash/index|bb2dash]]');
  assert.equal(linked.collection, 'misc', 'the field itself is a fact and is left alone');
});

test('withLinks: related is resumed_from then supersedes, de-duplicated', () => {
  const linked = withLinks(
    {
      ...BASE,
      resumed_from: `session-${UUID}`,
      supersedes: [`session-${UUID}`, `session-${UUID}-r2`, 'bad|id'],
    },
    'projects',
  );
  assert.deepEqual(linked.related, [`[[${UUID}]]`, `[[${UUID}-r2]]`]);
});

test('withLinks: links are recomputed, never accumulated', () => {
  const stale = { ...BASE, up: '[[old]]', related: ['[[gone]]'] };
  const linked = withLinks(stale, 'projects');
  assert.equal(linked.up, '[[projects/agentic-harness/index|agentic-harness]]');
  assert.deepEqual(linked.related, []);
});

test('withLinks: returns a new object and leaves its input alone', () => {
  const input = Object.freeze({ ...BASE, supersedes: Object.freeze([]) });
  const linked = withLinks(input, 'projects');
  assert.notEqual(linked, input);
  assert.equal(input.up, '');
});

test('withLinks: a hand-mangled supersedes that is not a list is tolerated', () => {
  const linked = withLinks({ ...BASE, supersedes: 'session-abc' }, 'projects');
  assert.deepEqual(linked.related, []);
});
