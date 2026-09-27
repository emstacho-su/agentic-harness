/**
 * The in-place frontmatter line editor move-to-realm relies on: one line
 * changed per edit, every other byte kept, and a plain report of what it
 * could not touch.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { editFrontmatterLines } from '../lib/frontmatter-lines.mjs';

const NOTE = "---\nid: 'a'\ncollection: 'memory'\ntitle: \"Session — memory\"\nstatus: concluded\n---\n\ncollection: 'memory' in the body stays\n";

test('only the named lines change, each keeping its quote style', () => {
  const edited = editFrontmatterLines(NOTE, {
    collection: () => 'bb2dash',
    title: (value) => value.replace('memory', 'bb2dash'),
    status: () => 'concluded',
  });
  assert.equal(edited.text, NOTE.replace("collection: 'memory'\n", "collection: 'bb2dash'\n").replace('"Session — memory"', '"Session — bb2dash"'));
  assert.deepEqual(edited.changes.map((c) => c.key), ['collection', 'title']);
  assert.equal(edited.found, true);
  assert.deepEqual(edited.skipped, []);
});

test("single quotes are escaped YAML's way; a plain value that would need quotes gets them", () => {
  assert.match(editFrontmatterLines("---\ntitle: 'x'\n---\n", { title: () => "it's" }).text, /^title: 'it''s'$/m);
  assert.match(editFrontmatterLines('---\nup: none\n---\n', { up: () => '[[a/b|c]]' }).text, /^up: '\[\[a\/b\|c\]\]'$/m);
});

test('CRLF line ends are kept', () => {
  const crlf = NOTE.replace(/\n/g, '\r\n');
  const edited = editFrontmatterLines(crlf, { collection: () => 'bb2dash' });
  assert.equal(edited.text, crlf.replace("collection: 'memory'", "collection: 'bb2dash'"));
});

test('an escaped double-quoted value is skipped and named; a file without a visible block is not found', () => {
  const escaped = `---\ncollection: "mem${String.fromCharCode(92)}u006fry"\n---\n`;
  const skipped = editFrontmatterLines(escaped, { collection: () => 'bb2dash' });
  assert.equal(skipped.text, escaped);
  assert.deepEqual(skipped.skipped, ['collection']);
  const bareCr = NOTE.replace(/\n/g, '\r');
  const missing = editFrontmatterLines(bareCr, { collection: () => 'bb2dash' });
  assert.equal(missing.found, false);
  assert.equal(missing.text, bareCr);
});

test('an edit returning null or the same value changes nothing', () => {
  const edited = editFrontmatterLines(NOTE, { collection: () => null, id: (value) => value });
  assert.equal(edited.text, NOTE);
  assert.deepEqual(edited.changes, []);
});
