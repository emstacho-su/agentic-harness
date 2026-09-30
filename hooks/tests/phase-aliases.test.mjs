/**
 * The phase spelling (brief 101 H-1) and its frozen fixture rows (H-2).
 *
 * Every row below is a branch that really existed in bb2dash, with the phase
 * its PR shipped. The rows that must read `''` matter as much as the others: a
 * wrong phase is worse than none, because a filter on it returns the wrong
 * sessions and reads as an answer.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PHASE_ALIASES, aliasPhase } from '../lib/phase-aliases.mjs';
import { derivePhase } from '../lib/tags.mjs';

const BB2DASH = 'emstacho-su/bb2dash';
const HARNESS = 'emstacho-su/agentic-harness';

const BRIEF_80C = 'docs/planning/sprint-1-hub/briefs/80c_PHASE12B_page_pass.md';
const BRIEF_82 = 'docs/planning/sprint-2/82_PHASE14_containers.md';
const SPRINT1_CLOSEOUT_TITLE =
  'chore: sprint 1 close-out — planning docs by sprint, Phase 13 skipped, sprint 2 intake';

/** H-2, row for row: `[branch, expected, extra inputs]`, bb2dash unless `repo` is named. */
const H2_ROWS = Object.freeze([
  ['feat/retrieval-polish', 'phase-7'],
  ['feat/retrieval-polish-db', 'phase-7'],
  ['feat/course-dimension', 'phase-8'],
  ['feat/sync-loop', 'phase-9'],
  ['feat/grades-10a', 'phase-10a'],
  ['feat/grades-10b', 'phase-10b'],
  ['feat/planner-11', 'phase-11'],
  ['feat/planner-events-11b', 'phase-11b'],
  ['feat/electron-12', 'phase-12'],
  ['fix/page-pass-12b', 'phase-12b'],
  ['fix/page-pass-12b-tail', 'phase-12b'],
  ['fix/page-pass-12b-db', 'phase-12b'],
  ['docs/phase6-signoff', 'phase-6'],
  ['docs/phase12b-merged', 'phase-12b'],
  ['docs/phase12b-14-briefs', ''],
  ['feat/retrieval-mcp', ''],
  ['docs/mvp-dod', ''],
  ['feat/inbox-apply', ''],
  ['chore/sprint1-closeout', '', { prTitles: [SPRINT1_CLOSEOUT_TITLE] }],
  ['feat/db-hygiene-15', 'phase-15'],
  ['feat/grades-v1-16', 'phase-16'],
  ['feat/web-polish-17', 'phase-17'],
  ['feat/ingest-corpus-18', 'phase-18'],
  ['feat/content-history-19', 'phase-19'],
  ['feat/containers-14', 'phase-14'],
  ['docs/harness-closure-20', 'phase-20'],
  ['fix/inbox-apply-vault-20', 'phase-20'],
  ['docs/sprint2-planning', ''],
  ['main', ''],
  ['main', 'phase-12b', { docsTouched: [BRIEF_80C] }],
  ['main', '', { docsTouched: [BRIEF_80C, BRIEF_82] }],
  ['feat/containers', '', { repo: HARNESS }],
  ['feat/v2-closure', '', { repo: HARNESS }],
]);

function describe(branch, extra) {
  const parts = [branch];
  if (extra.repo) parts.push(`repo ${extra.repo}`);
  if (extra.docsTouched) parts.push(`docs ${extra.docsTouched.join(', ')}`);
  if (extra.prTitles) parts.push('with a PR title');
  return parts.join(' · ');
}

for (const [branch, expected, extra = {}] of H2_ROWS) {
  test(`H-2: ${describe(branch, extra)} -> ${expected || "''"}`, () => {
    assert.equal(derivePhase({ repo: BB2DASH, ...extra, branch }), expected);
  });
}

// ------------------------------------------------------------ the alias table

test('the alias table holds exactly the three slug branches, each citing its PR', () => {
  assert.deepEqual(
    PHASE_ALIASES.map(({ name, phase, pr }) => [name, phase, pr]),
    [
      ['retrieval-polish', 'phase-7', 6],
      ['course-dimension', 'phase-8', 8],
      ['sync-loop', 'phase-9', 10],
    ],
  );
  assert.ok(Object.isFrozen(PHASE_ALIASES));
});

test('an alias matches the whole name or a worker branch of it, never a longer word', () => {
  assert.equal(aliasPhase('retrieval-polish'), 'phase-7');
  assert.equal(aliasPhase('retrieval-polish-clients'), 'phase-7');
  assert.equal(aliasPhase('sync-loopy'), '');
  assert.equal(aliasPhase('retrieval'), '');
  assert.equal(aliasPhase(''), '');
  assert.equal(aliasPhase(undefined), '');
});

// ----------------------------------------------------- repo-scoped rules only

test('the segment and alias rules are bb2dash-only: another repo, or none, reads no phase from them', () => {
  for (const repo of [HARNESS, '']) {
    assert.equal(derivePhase({ repo, branch: 'feat/grades-10a' }), '');
    assert.equal(derivePhase({ repo, branch: 'feat/retrieval-polish' }), '');
    assert.equal(derivePhase({ repo, branch: 'feat/db-hygiene-15' }), '');
  }
});

test('the phase rule holds for every repo, letters included', () => {
  assert.equal(derivePhase({ repo: HARNESS, branch: 'feat/phase12b-thing' }), 'phase-12b');
  assert.equal(derivePhase({ branch: 'feat/PHASE7-retrieval' }), 'phase-7');
  assert.equal(derivePhase({ branch: 'feat/phase123' }), '', 'three digits is not a phase');
});

test('the repo name is compared without case', () => {
  assert.equal(derivePhase({ repo: 'Emstacho-SU/BB2DASH', branch: 'feat/grades-10a' }), 'phase-10a');
});

// -------------------------------------------------------- one source, one phase

test('two phases in one source is no phase, and no later source is read', () => {
  assert.equal(derivePhase({ repo: BB2DASH, branch: 'docs/phase12b-14-briefs', docsTouched: [BRIEF_80C] }), '');
  assert.equal(derivePhase({ repo: HARNESS, branch: 'main', prTitles: ['Phase 7 polish', 'Phase 8 dims'], docsTouched: [BRIEF_80C] }), '');
});

test('the same phase twice in one source is still one phase', () => {
  assert.equal(derivePhase({ repo: BB2DASH, branch: 'feat/phase-14-containers-14' }), 'phase-14');
});

test('PR titles are read for other repos, and never for bb2dash', () => {
  assert.equal(derivePhase({ repo: HARNESS, branch: 'main', prTitles: ['feat: Phase 11 sync'] }), 'phase-11');
  assert.equal(derivePhase({ branch: 'main', prTitles: ['feat: Phase 11 sync'] }), 'phase-11');
  assert.equal(derivePhase({ repo: BB2DASH, branch: 'main', prTitles: ['feat: Phase 11 sync'] }), '');
});

test('a planning path counts only under docs/planning/', () => {
  assert.equal(derivePhase({ repo: BB2DASH, branch: 'main', docsTouched: ['docs/PHASE7_notes.md'] }), '');
  assert.equal(derivePhase({ repo: BB2DASH, branch: 'main', docsTouched: ['C:/x/docs/planning/50_PHASE7_retrieval.md'] }), 'phase-7');
});

// ------------------------------------------------ dates are not phase segments

test('a date in a bb2dash branch names no phase (code review, PR #36)', () => {
  for (const branch of [
    'docs/inbox-decisions-2026-10-10',
    'docs/inbox-decisions-2026-09-09',
    'docs/inbox-decisions-2026-09-29',
  ]) {
    assert.equal(derivePhase({ repo: BB2DASH, branch }), '', branch);
  }
});

test('a zero-padded segment is not a phase segment', () => {
  assert.equal(derivePhase({ repo: BB2DASH, branch: 'feat/thing-09' }), '');
  assert.equal(derivePhase({ repo: BB2DASH, branch: 'feat/thing-9' }), 'phase-9');
});

test('a date beside a real phase segment leaves the phase', () => {
  assert.equal(
    derivePhase({ repo: BB2DASH, branch: 'docs/phase-notes-16-2026-10-10' }),
    'phase-16',
  );
});
