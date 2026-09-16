/**
 * Approval tests: every fixture renders exactly its committed golden note.
 *
 * This is the schema's tripwire. The frontmatter these files contain is what
 * `ingest` stores in `rag.documents.metadata` and what W-H2's `filter_metadata`
 * queries, so a field that quietly changes name, type or order breaks retrieval
 * somewhere nobody is looking. Here it breaks the suite instead.
 *
 * Regenerate with `node hooks/tests/update-goldens.mjs`, then read the diff.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { FIELD_ORDER, parseFrontmatter } from '../lib/frontmatter.mjs';
import { GOLDEN_DIR, createSandbox, readNote } from './helpers/sandbox.mjs';
import { SCENARIOS, runScenario } from './helpers/scenarios.mjs';

for (const scenario of SCENARIOS) {
  test(`golden: ${scenario.name} — ${scenario.description}`, () => {
    const sandbox = createSandbox();
    try {
      const outcome = runScenario(sandbox, scenario);
      assert.equal(outcome.written, true, `expected a note, got ${outcome.action}: ${outcome.skip}`);

      const actual = readNote(sandbox, scenario.note);
      const expected = fs.readFileSync(path.join(GOLDEN_DIR, `${scenario.name}.md`), 'utf8');
      assert.equal(actual, expected);
    } finally {
      sandbox.cleanup();
    }
  });
}

test('every golden carries every schema-v2 field, in order', () => {
  for (const scenario of SCENARIOS) {
    const raw = fs.readFileSync(path.join(GOLDEN_DIR, `${scenario.name}.md`), 'utf8');
    const parsed = parseFrontmatter(raw);
    assert.equal(parsed.ok, true, `${scenario.name}: ${parsed.error}`);

    const present = Object.keys(parsed.fields);
    // `tools_used` is omitted when a session used no tools; everything else is
    // unconditional, because "absent" and "empty" must not be the same signal.
    const required = FIELD_ORDER.filter((field) => field !== 'tools_used');
    for (const field of required) {
      assert.ok(present.includes(field), `${scenario.name} is missing ${field}`);
    }
    const order = present.filter((field) => FIELD_ORDER.includes(field));
    const expectedOrder = FIELD_ORDER.filter((field) => present.includes(field));
    assert.deepEqual(order, expectedOrder, `${scenario.name} emits fields out of order`);
  }
});

test('the DoD fields are never null and never missing', () => {
  for (const scenario of SCENARIOS) {
    const raw = fs.readFileSync(path.join(GOLDEN_DIR, `${scenario.name}.md`), 'utf8');
    const { fields } = parseFrontmatter(raw);
    assert.equal(fields.type, 'session');
    assert.equal(fields.schema_version, 2);
    assert.ok(['active', 'concluded', 'superseded'].includes(fields.status));
    assert.ok(['git', 'folder'].includes(fields.collection_source));
    assert.equal(typeof fields.repo, 'string');
    assert.equal(typeof fields.branch, 'string');
    assert.equal(typeof fields.phase, 'string');
    assert.ok(Array.isArray(fields.tags) && fields.tags.length > 0);
    assert.ok(Array.isArray(fields.prs));
    for (const pr of fields.prs) assert.equal(typeof pr, 'number', 'prs must stay integers for filter_metadata');
  }
});

test('collection comes from the git remote, and the folder fallback is flagged', () => {
  const byName = Object.fromEntries(
    SCENARIOS.map((scenario) => [
      scenario.name,
      parseFrontmatter(fs.readFileSync(path.join(GOLDEN_DIR, `${scenario.name}.md`), 'utf8')).fields,
    ]),
  );

  // The worktree is the whole point of R-27.1: same collection as the main repo.
  assert.equal(byName.worktree.collection, 'bb2dash');
  assert.equal(byName.worktree.collection_source, 'git');
  assert.equal(byName.worktree.worktree, 'bb2dash-wt-sl');
  assert.equal(byName.worktree.repo, 'emstacho-su/bb2dash');
  assert.equal(byName['plain-main'].collection, byName.worktree.collection);

  // A class folder has no remote and says so rather than inventing one.
  assert.equal(byName.class.collection, 'ist323');
  assert.equal(byName.class.collection_source, 'folder');
  assert.equal(byName.class.repo, '');
});

test('a cross-repo session stays one note and records both repositories', () => {
  const { fields } = parseFrontmatter(
    fs.readFileSync(path.join(GOLDEN_DIR, 'cross-repo.md'), 'utf8'),
  );
  assert.deepEqual(fields.repos_touched, ['agentic-harness', 'bb2dash']);
  assert.equal(fields.collection, 'bb2dash');
});

test('a subagent transcript records the session that spawned it', () => {
  const { fields } = parseFrontmatter(fs.readFileSync(path.join(GOLDEN_DIR, 'subagent.md'), 'utf8'));
  assert.equal(fields.parent_session, 'a1b2c3d4-0000-4000-8000-000000000001');
});

test('the parent note lists its children, and scratchpad paths are gone', () => {
  const { fields } = parseFrontmatter(fs.readFileSync(path.join(GOLDEN_DIR, 'plain-main.md'), 'utf8'));
  // Child note ids, which are the ingest external_ids, so a search follows the
  // link straight to the worker's own note.
  assert.deepEqual(fields.child_sessions, [
    'session-11111111-1111-4111-8111-111111111111--aaa111',
    'session-11111111-1111-4111-8111-111111111111--bbb222',
  ]);
  assert.deepEqual(fields.prs, [6]);
  assert.equal(fields.plan_file, 'abundant-gathering-wirth');
  assert.deepEqual(fields.memory_files, ['pm-worker-arrangement']);
  for (const file of fields.files_modified) {
    assert.ok(!file.includes('scratchpad'), `scratchpad path survived: ${file}`);
    assert.ok(!file.includes('AppData'), `temp path survived: ${file}`);
    assert.ok(!path.isAbsolute(file), `path is not repo-relative: ${file}`);
  }
  // A subagent's edit is the parent's edit.
  assert.ok(fields.files_modified.includes('db/migrations/036_views_security_invoker.sql'));
});
