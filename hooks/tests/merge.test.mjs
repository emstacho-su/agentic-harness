/**
 * Merge semantics, as units.
 *
 * `resume.test.mjs` proves the behaviour end to end through the vault; this
 * file pins the rules themselves, so a failure says which rule broke rather
 * than which fixture changed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTION_CREATE,
  ACTION_MERGE,
  ACTION_NOOP,
  ACTION_RESUME,
  hasNewActivity,
  markSuperseded,
  mergeFields,
  mergeTags,
  planWrite,
  statusRank,
} from '../lib/merge.mjs';

const BASE = Object.freeze({
  id: 'session-abc',
  status: 'active',
  ended_at: '2026-09-13T10:30:00.000Z',
  prompt_count: 1,
  command_count: 2,
  tags: ['docs'],
  commits: ['aaaaaaaaaaaa'],
  prs: [6],
  repo: 'emstacho-su/agentic-harness',
  branch: 'feat/session-context',
  supersedes: [],
  files_modified: ['docs/ingestion.md'],
  tools_used: { Edit: 1 },
});

test('no existing note means create', () => {
  const plan = planWrite(null, { ...BASE });
  assert.equal(plan.action, ACTION_CREATE);
});

test('status ratchets forward and never back', () => {
  assert.equal(statusRank('active'), 0);
  assert.equal(statusRank('concluded'), 1);
  assert.equal(statusRank('superseded'), 2);
  assert.equal(statusRank('nonsense'), 0, 'an unknown status ranks lowest rather than throwing');

  const merged = mergeFields({ ...BASE, status: 'superseded' }, { ...BASE, status: 'active' });
  assert.equal(merged.status, 'superseded');
});

test('a stale SessionEnd over a settled note is a no-op', () => {
  const existing = { ...BASE, status: 'concluded' };
  const plan = planWrite(existing, { ...BASE, status: 'concluded' });
  assert.equal(plan.action, ACTION_NOOP);
});

test('new activity over a settled note starts a resume note', () => {
  const existing = { ...BASE, status: 'concluded' };
  const next = { ...BASE, status: 'concluded', ended_at: '2026-09-14T11:40:00.000Z', prompt_count: 2 };
  const plan = planWrite(existing, next);

  assert.equal(plan.action, ACTION_RESUME);
  assert.equal(plan.fields.resumed_from, 'session-abc');
  assert.deepEqual(plan.fields.supersedes, ['session-abc']);
});

test('a resume note inherits the chain it continues', () => {
  const existing = { ...BASE, id: 'session-abc-r2', status: 'concluded', supersedes: ['session-abc'] };
  const next = { ...BASE, ended_at: '2026-09-15T09:00:00.000Z', status: 'concluded' };
  const plan = planWrite(existing, next);
  assert.deepEqual(plan.fields.supersedes, ['session-abc-r2', 'session-abc']);
});

test('new activity is ended_at first, prompt count as the tie-break', () => {
  assert.equal(hasNewActivity(BASE, { ...BASE, ended_at: '2026-09-14T00:00:00.000Z' }), true);
  assert.equal(hasNewActivity(BASE, { ...BASE }), false);
  assert.equal(hasNewActivity(BASE, { ...BASE, prompt_count: 2 }), true);
  assert.equal(hasNewActivity(BASE, { ...BASE, ended_at: '2026-09-01T00:00:00.000Z' }), false);
});

test('lists grow and never shrink', () => {
  const merged = mergeFields(BASE, {
    ...BASE,
    commits: ['bbbbbbbbbbbb'],
    prs: [12],
    files_modified: ['docs/tags.md'],
  });
  assert.deepEqual(merged.commits, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  assert.deepEqual(merged.prs, [6, 12]);
  assert.deepEqual(merged.files_modified, ['docs/ingestion.md', 'docs/tags.md']);
});

test('a derived scalar replaces an empty one but never the reverse', () => {
  const filled = mergeFields({ ...BASE, branch: '' }, { ...BASE, branch: 'feat/x' });
  assert.equal(filled.branch, 'feat/x');

  const kept = mergeFields({ ...BASE, branch: 'feat/x' }, { ...BASE, branch: '' });
  assert.equal(kept.branch, 'feat/x', 'a failed derivation must not erase a good value');
});

test('counters take the larger of the two', () => {
  const merged = mergeFields({ ...BASE, prompt_count: 9 }, { ...BASE, prompt_count: 2 });
  assert.equal(merged.prompt_count, 9);
});

test('a manual tag survives, and unclassified yields to any real tag', () => {
  assert.deepEqual(mergeTags(['needs-followup'], ['db']), ['needs-followup', 'db']);
  assert.deepEqual(mergeTags(['unclassified'], ['db']), ['db']);
  assert.deepEqual(mergeTags(['needs-followup'], ['unclassified']), ['needs-followup']);
  assert.deepEqual(mergeTags(['unclassified'], ['unclassified']), ['unclassified']);
  assert.deepEqual(mergeTags([], []), ['unclassified']);
  assert.deepEqual(mergeTags(['db'], ['db']), ['db'], 'no duplicates');
});

test('the manual tag cap is the hook, not the merge', () => {
  const manual = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  assert.equal(mergeTags(manual, ['db']).length, 9, 'manual tags are uncapped');
});

test('a merge returns a new object and leaves both inputs alone', () => {
  const existing = { ...BASE, tags: ['docs'] };
  const next = { ...BASE, tags: ['db'] };
  const merged = mergeFields(existing, next);
  assert.notEqual(merged, existing);
  assert.deepEqual(existing.tags, ['docs']);
  assert.deepEqual(next.tags, ['db']);
});

test('markSuperseded changes one field and copies the rest', () => {
  const flipped = markSuperseded(BASE);
  assert.equal(flipped.status, 'superseded');
  assert.equal(BASE.status, 'active');
  assert.equal(flipped.id, BASE.id);
});

test('an unknown field on the existing note is carried through the merge', () => {
  const merged = mergeFields({ ...BASE, reviewed_by: 'stack' }, { ...BASE });
  assert.equal(merged.reviewed_by, 'stack');
  assert.equal(planWrite({ ...BASE, reviewed_by: 'stack' }, { ...BASE }).action, ACTION_MERGE);
});
