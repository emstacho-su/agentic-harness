/**
 * The migration's git and GitHub back-fill.
 *
 * Both runners are stubbed: these tests assert the window arithmetic and the
 * "derive or leave empty" rule, not that `gh` is installed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { backfillSession, branchContaining, pullRequestsInWindow } from '../lib/backfill.mjs';
import { derivePhase } from '../lib/tags.mjs';

const WINDOW = { startedAt: '2026-09-10T20:07:00.000Z', endedAt: '2026-09-14T17:04:00.000Z' };

const PR_ROWS = [
  { number: 6, title: 'Phase 7 — retrieval polish', headRefName: 'feat/phase7-retrieval', createdAt: '2026-09-11T10:00:00Z', mergedAt: '2026-09-11T18:00:00Z', closedAt: '2026-09-11T18:00:00Z' },
  { number: 9, title: 'Phase 9 — sync loop', headRefName: 'feat/sync-loop', createdAt: '2026-09-13T09:00:00Z', mergedAt: null, closedAt: null },
  { number: 2, title: 'GUI v1', headRefName: 'feat/gui-v1', createdAt: '2026-09-01T09:00:00Z', mergedAt: '2026-09-02T09:00:00Z', closedAt: '2026-09-02T09:00:00Z' },
];

const okGh = (rows) => () => ({ ok: true, stdout: JSON.stringify(rows) });

test('only pull requests touching the window are matched', () => {
  const result = pullRequestsInWindow({ repoFullName: 'emstacho-su/bb2dash', ...WINDOW, runGh: okGh(PR_ROWS) });
  assert.deepEqual(result.prs, [6, 9]);
  // Most recent first, so the branch and the phase come from the last PR the
  // session touched rather than from gh's print order.
  assert.deepEqual(result.branches, ['feat/sync-loop', 'feat/phase7-retrieval']);
  assert.deepEqual(result.titles, ['Phase 9 — sync loop', 'Phase 7 — retrieval polish']);
  assert.equal(result.error, '');
});

test('the phase falls back to a pull request title when the branch is silent', () => {
  assert.equal(derivePhase({ branch: 'feat/sync-loop', prTitles: ['Phase 9 — sync loop'] }), 'phase-9');
  // A branch that names a phase still wins: it is the more specific signal.
  assert.equal(derivePhase({ branch: 'feat/phase7-x', prTitles: ['Phase 9 — sync loop'] }), 'phase-7');
  assert.equal(derivePhase({ branch: 'feat/sync-loop', prTitles: ['GUI v1'] }), '');
});

test('a gh failure is a reason, not an exception', () => {
  for (const runGh of [
    () => ({ ok: false, stdout: '', error: 'gh: not found' }),
    () => ({ ok: true, stdout: 'not json' }),
    () => ({ ok: true, stdout: '{"message":"Not Found"}' }),
  ]) {
    const result = pullRequestsInWindow({ repoFullName: 'a/b', ...WINDOW, runGh });
    assert.deepEqual(result.prs, []);
    assert.deepEqual(result.titles, []);
    assert.ok(result.error.length > 0);
  }
});

test('gh is not called at all without a repo or a window', () => {
  let calls = 0;
  const runGh = () => {
    calls += 1;
    return { ok: true, stdout: '[]' };
  };
  pullRequestsInWindow({ repoFullName: '', ...WINDOW, runGh });
  pullRequestsInWindow({ repoFullName: 'a/b', startedAt: '', endedAt: '', runGh });
  assert.equal(calls, 0);
});

test('a branch is accepted only when git names exactly one non-trunk branch', () => {
  const one = branchContaining({
    repoRoot: 'C:/repo',
    sha: 'abc',
    runGit: () => ({ ok: true, stdout: '* main\n  feat/sync-loop\n' }),
  });
  assert.equal(one, 'feat/sync-loop');

  const ambiguous = branchContaining({
    repoRoot: 'C:/repo',
    sha: 'abc',
    runGit: () => ({ ok: true, stdout: 'main\nfeat/a\nfeat/b\n' }),
  });
  assert.equal(ambiguous, '', 'two candidates is a guess, and a guess is worse than empty');

  // Only the trunk contains it: the work went straight to main, which is an
  // answer rather than a guess.
  const trunkOnly = branchContaining({
    repoRoot: 'C:/repo',
    sha: 'abc',
    runGit: () => ({ ok: true, stdout: 'main\n' }),
  });
  assert.equal(trunkOnly, 'main');

  const trunkPair = branchContaining({
    repoRoot: 'C:/repo',
    sha: 'abc',
    runGit: () => ({ ok: true, stdout: 'main\nmaster\n' }),
  });
  assert.equal(trunkPair, '');

  assert.equal(branchContaining({ repoRoot: '', sha: 'abc' }), '');
  assert.equal(
    branchContaining({ repoRoot: 'C:/repo', sha: 'abc', runGit: () => ({ ok: false, stdout: '' }) }),
    '',
  );
});

test('a session with no commits and no PRs back-fills to empty, with reasons', () => {
  const result = backfillSession({
    repoRoot: 'C:/repo',
    repoFullName: 'emstacho-su/bb2dash',
    ...WINDOW,
    runGit: () => ({ ok: true, stdout: '' }),
    runGh: okGh([]),
  });
  assert.deepEqual(result.commits, []);
  assert.deepEqual(result.prs, []);
  assert.equal(result.branch, '');
  assert.ok(result.notes.some((note) => note.startsWith('commits:')));
  assert.ok(result.notes.some((note) => note.startsWith('prs:')));
  assert.ok(result.notes.some((note) => note.startsWith('branch:')));
});

test('a full back-fill prefers the pull request head branch', () => {
  const result = backfillSession({
    repoRoot: 'C:/repo',
    repoFullName: 'emstacho-su/bb2dash',
    ...WINDOW,
    runGit: () => ({ ok: true, stdout: `abc123def456\u001ffeat: thing (#6)\u001f\u001e` }),
    runGh: okGh(PR_ROWS),
  });
  assert.deepEqual(result.commits, ['abc123def456']);
  assert.deepEqual(result.prs, [6, 9]);
  assert.equal(result.branch, 'feat/sync-loop', 'the most recent pull request in the window wins');
  assert.deepEqual(result.notes, []);
});
