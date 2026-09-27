/**
 * The derived Obsidian links, as units.
 *
 * Obsidian draws a graph edge only for a `[[wikilink]]`, and the relational
 * fields hold raw ids because the RAG store filters on them. These rules are
 * the projection from one to the other.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { hubFilename, hubLink, noteStem, sessionLink, withLinks } from '../lib/links.mjs';

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

test('hubFilename: a hub note is named after its collection folder', () => {
  assert.equal(hubFilename('bb2dash'), 'bb2dash.md');
  assert.equal(hubFilename('ist323'), 'ist323.md');
});

test('hubFilename: an unsafe collection yields no filename', () => {
  assert.equal(hubFilename(''), '');
  assert.equal(hubFilename('a|b'), '');
  assert.equal(hubFilename('../x'), '');
  assert.equal(hubFilename(undefined), '');
});

test('hubLink: the full path to the hub, labelled with the collection', () => {
  assert.equal(hubLink('projects', 'bb2dash'), '[[projects/bb2dash/bb2dash|bb2dash]]');
  assert.equal(hubLink('classes', 'ist323'), '[[classes/ist323/ist323|ist323]]');
});

test('hubLink: an unknown area or an unsafe collection yields no link', () => {
  assert.equal(hubLink('elsewhere', 'bb2dash'), '');
  assert.equal(hubLink('projects', 'a|b'), '');
  assert.equal(hubLink('projects', ''), '');
  assert.equal(hubLink('', 'bb2dash'), '');
});

test('withLinks: a top-level session links up to its collection hub', () => {
  const linked = withLinks(BASE, 'projects');
  assert.equal(linked.up, '[[projects/agentic-harness/agentic-harness|agentic-harness]]');
  assert.deepEqual(linked.related, []);
});

test('withLinks: a worker links up to its parent session by full path, not the hub', () => {
  // A bare `[[<uuid>]]` followed before the parent note exists makes Obsidian
  // create the note at the vault root (2026-09-24). The full path creates it
  // where the hook will write it.
  const linked = withLinks({ ...BASE, parent_session: UUID }, 'projects');
  assert.equal(linked.up, `[[projects/agentic-harness/sessions/${UUID}]]`);
});

test("withLinks: the parent's own folder and title, when the caller knows them", () => {
  const parent = { area: 'classes', collection: 'ist323', title: '2026-09-24 · ist323' };
  const linked = withLinks({ ...BASE, parent_session: UUID }, 'projects', 'agentic-harness', parent);
  assert.equal(linked.up, `[[classes/ist323/sessions/${UUID}|2026-09-24 · ist323]]`);
});

test("withLinks: the parent folder defaults to the note's own placement, collection override included", () => {
  const linked = withLinks({ ...BASE, collection: 'misc', parent_session: UUID }, 'projects', 'bb2dash', { title: 'Parent' });
  assert.equal(linked.up, `[[projects/bb2dash/sessions/${UUID}|Parent]]`);
});

test('withLinks: a parent title cannot break out of the link, and is capped', () => {
  const link = (title) => withLinks({ ...BASE, parent_session: UUID }, 'projects', undefined, { title }).up;
  const stem = `projects/agentic-harness/sessions/${UUID}`;
  assert.equal(link('a [[b]] | c\n\td\u0000'), `[[${stem}|a b c d]]`);
  assert.equal(link('   '), `[[${stem}]]`, 'an empty alias is no alias');
  assert.equal(link('[]|'), `[[${stem}]]`);
  assert.equal(link(undefined), `[[${stem}]]`);
  // 80 code points, not 80 UTF-16 units: an emoji is never cut in half.
  assert.equal(link('\u{1F600}'.repeat(100)), `[[${stem}|${'\u{1F600}'.repeat(80)}]]`);
  assert.equal(link(`${'x'.repeat(79)} tail`), `[[${stem}|${'x'.repeat(79)}]]`, 'no trailing space after the cut');
});

test('withLinks: a parent folder that is not a collection falls back to the hub', () => {
  for (const parent of [{ area: 'elsewhere' }, { collection: 'a|b' }, { collection: '../x' }]) {
    const linked = withLinks({ ...BASE, parent_session: UUID }, 'projects', undefined, parent);
    assert.equal(linked.up, '[[projects/agentic-harness/agentic-harness|agentic-harness]]', JSON.stringify(parent));
  }
});

test('withLinks: a hostile parent id falls back to the hub', () => {
  const linked = withLinks({ ...BASE, parent_session: 'x]]|[[evil' }, 'projects');
  assert.equal(linked.up, '[[projects/agentic-harness/agentic-harness|agentic-harness]]');
});

test('withLinks: a parent that is filename-safe but not a session id is not followed', () => {
  // A checkpoint note arrives through git. `README` would otherwise make any
  // note in the vault this note's parent.
  for (const parent of ['README', 'index', `${UUID}-r2`, `session-${UUID}`]) {
    const linked = withLinks({ ...BASE, parent_session: parent }, 'projects');
    assert.equal(linked.up, '[[projects/agentic-harness/agentic-harness|agentic-harness]]', parent);
  }
});

test('withLinks: the hub is where the note is filed, when the caller knows better', () => {
  const linked = withLinks({ ...BASE, collection: 'misc' }, 'projects', 'bb2dash');
  assert.equal(linked.up, '[[projects/bb2dash/bb2dash|bb2dash]]');
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
  assert.equal(linked.up, '[[projects/agentic-harness/agentic-harness|agentic-harness]]');
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

test('a pass that knows no parent keeps a worker link already qualified for the same parent (review #3)', () => {
  const parentId = '11111111-1111-4111-8111-111111111111';
  const up = `[[projects/agentic-harness/sessions/${parentId}|2026-09-24 · agentic-harness · build it]]`;
  const fields = withLinks({ parent_session: parentId, collection: 'misc', up }, 'projects', 'misc');
  assert.equal(fields.up, up);
});

test('an up naming another parent is re-derived, not kept', () => {
  const parentId = '11111111-1111-4111-8111-111111111111';
  const up = '[[projects/misc/sessions/22222222-2222-4222-8222-222222222222|old]]';
  const fields = withLinks({ parent_session: parentId, collection: 'misc', up }, 'projects', 'misc');
  assert.equal(fields.up, `[[projects/misc/sessions/${parentId}]]`);
});
