/**
 * `ensureIndex`: a collection's hub note, `<collection>.md`, exists, and is
 * never overwritten.
 *
 * Every session links up to `<area>/<collection>/<collection>`. A collection the
 * hook creates on demand has no such note, and a link to nothing is a ghost node.
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
  const raw = fs.readFileSync(path.join(vault, 'projects', 'bb2dash', 'bb2dash.md'), 'utf8');
  const parsed = parseFrontmatter(raw);
  assert.ok(parsed.ok);
  assert.equal(parsed.fields.title, 'bb2dash');
  assert.equal(parsed.fields.collection, 'bb2dash');
  assert.equal(parsed.fields.type, 'index');
  assert.match(parsed.fields.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(!raw.includes('[['), 'an index body must not carry links: they would be embedded');
  assert.ok(!fs.existsSync(path.join(vault, 'projects', 'bb2dash', 'index.md')), 'the hub is named after its folder');
});

test('an existing index is left byte for byte alone', (t) => {
  const vault = scratchVault(t);
  const indexPath = path.join(vault, 'classes', 'ist323', 'ist323.md');
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, 'handwritten\n', 'utf8');

  const result = ensureIndex(vault, 'classes', 'ist323');

  assert.deepEqual({ ok: result.ok, created: result.created }, { ok: true, created: false });
  assert.equal(fs.readFileSync(indexPath, 'utf8'), 'handwritten\n');
});

test('a legacy index.md is the hub until rename-hubs has run: no second hub is written', (t) => {
  const vault = scratchVault(t);
  const legacy = path.join(vault, 'projects', 'bb2dash', 'index.md');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, '---\nid: "x"\ntype: index\n---\n', 'utf8');

  const result = ensureIndex(vault, 'projects', 'bb2dash');

  assert.deepEqual(result, { ok: true, created: false, path: legacy, error: '' });
  assert.ok(!fs.existsSync(path.join(vault, 'projects', 'bb2dash', 'bb2dash.md')));
  assert.equal(fs.readFileSync(legacy, 'utf8'), '---\nid: "x"\ntype: index\n---\n');
});

test('once the hub is renamed, a leftover index.md beside it changes nothing', (t) => {
  const vault = scratchVault(t);
  const dir = path.join(vault, 'classes', 'ist323');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ist323.md'), 'hub\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'index.md'), 'legacy\n', 'utf8');

  const result = ensureIndex(vault, 'classes', 'ist323');

  assert.equal(result.path, path.join(dir, 'ist323.md'));
  assert.equal(result.created, false);
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
