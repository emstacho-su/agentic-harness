/**
 * `ensureIndex`: a collection's `index.md` exists, and is never overwritten.
 *
 * Every session links up to `<area>/<collection>/index`. A collection the hook
 * creates on demand has no such note, and a link to nothing is a ghost node.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseFrontmatter } from '../lib/frontmatter.mjs';
import { ensureIndex } from '../lib/notes-io.mjs';

function scratchVault(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('an absent index is created with the documented index shape', (t) => {
  const vault = scratchVault(t);
  const result = ensureIndex(vault, 'projects', 'bb2dash');

  assert.deepEqual({ ok: result.ok, created: result.created }, { ok: true, created: true });
  const raw = fs.readFileSync(path.join(vault, 'projects', 'bb2dash', 'index.md'), 'utf8');
  const parsed = parseFrontmatter(raw);
  assert.ok(parsed.ok);
  assert.equal(parsed.fields.title, 'bb2dash');
  assert.equal(parsed.fields.collection, 'bb2dash');
  assert.equal(parsed.fields.type, 'index');
  assert.match(parsed.fields.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(!raw.includes('[['), 'an index body must not carry links: they would be embedded');
});

test('an existing index is left byte for byte alone', (t) => {
  const vault = scratchVault(t);
  const indexPath = path.join(vault, 'classes', 'ist323', 'index.md');
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, 'handwritten\n', 'utf8');

  const result = ensureIndex(vault, 'classes', 'ist323');

  assert.deepEqual({ ok: result.ok, created: result.created }, { ok: true, created: false });
  assert.equal(fs.readFileSync(indexPath, 'utf8'), 'handwritten\n');
});

test('an unknown area or an unsafe collection writes nothing', (t) => {
  const vault = scratchVault(t);
  for (const [area, collection] of [['elsewhere', 'x'], ['projects', '../x'], ['projects', ''], ['projects', 'a|b']]) {
    const result = ensureIndex(vault, area, collection);
    assert.equal(result.ok, false, `${area}/${collection}`);
    assert.equal(result.created, false);
  }
  assert.deepEqual(fs.readdirSync(vault), []);
});
