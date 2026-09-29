/**
 * The classifier, and the rule the Definition of done turns on:
 *
 *   > Every tag the hook applies is in docs/tags.md, or is exactly
 *   > `unclassified`.
 *
 * Checked as a set difference over every fixture — so a new rule that invents a
 * term fails here rather than putting an unsearchable tag in the store.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { MAX_HOOK_TAGS } from '../lib/constants.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';
import { classify, derivePhase } from '../lib/tags.mjs';
import { PHASE_TAG_PATTERN, UNCLASSIFIED } from '../lib/vocabulary.mjs';
import { GOLDEN_DIR } from './helpers/sandbox.mjs';
import { SCENARIOS } from './helpers/scenarios.mjs';
import { parseTagsDoc } from './helpers/tags-doc.mjs';

const doc = parseTagsDoc();
const DOCUMENTED = new Set([...doc.areas, ...doc.activities, ...doc.sentinel]);
const PHASE_FAMILY = /^phase-([1-9][0-9]?)([a-z]?)$/;

function documented(tag) {
  return DOCUMENTED.has(tag) || PHASE_FAMILY.test(tag);
}

test('every tag on every golden note is in docs/tags.md', () => {
  const offenders = [];
  for (const scenario of SCENARIOS) {
    const { fields } = parseFrontmatter(
      fs.readFileSync(path.join(GOLDEN_DIR, `${scenario.name}.md`), 'utf8'),
    );
    for (const tag of fields.tags) {
      if (!documented(tag)) offenders.push(`${scenario.name}: ${tag}`);
    }
  }
  assert.deepEqual(offenders, [], 'tags applied by the hook but absent from docs/tags.md');
});

test('no note exceeds the hook tag cap', () => {
  for (const scenario of SCENARIOS) {
    const { fields } = parseFrontmatter(
      fs.readFileSync(path.join(GOLDEN_DIR, `${scenario.name}.md`), 'utf8'),
    );
    assert.ok(
      fields.tags.length <= MAX_HOOK_TAGS,
      `${scenario.name} has ${fields.tags.length} tags, cap is ${MAX_HOOK_TAGS}`,
    );
  }
});

test('a session with nothing to go on is exactly [unclassified]', () => {
  const result = classify({});
  assert.deepEqual(result.tags, [UNCLASSIFIED]);
  assert.equal(result.phase, '');
});

test('unclassified never appears alongside a real tag', () => {
  const result = classify({ files: [{ path: 'ingest/src/ingest/cli.py', count: 1 }] });
  assert.deepEqual(result.tags, ['ingest']);
});

test('area tags come from paths, activity tags from signals', () => {
  const result = classify({
    files: [
      { path: 'db/migrations/040_x.sql', count: 3 },
      { path: 'web/src/app/page.tsx', count: 2 },
      { path: 'mcp-server/src/search.ts', count: 1 },
    ],
    commandTexts: ['gh pr create --base main', 'uv run pytest -q'],
    branch: 'feat/phase11-sync',
  });
  assert.equal(result.phase, 'phase-11');
  assert.deepEqual(result.tags, ['phase-11', 'db', 'retrieval', 'pr', 'validation']);
});

test('the five slots keep one axis from crowding out the other', () => {
  // Six areas and two activities: the PR still gets said.
  const result = classify({
    files: [
      { path: 'ingest/a.py', count: 9 },
      { path: 'db/b.sql', count: 8 },
      { path: 'web/c.tsx', count: 7 },
      { path: 'mcp-server/d.ts', count: 6 },
      { path: 'hooks/e.mjs', count: 5 },
      { path: 'docs/f.md', count: 4 },
    ],
    commandTexts: ['gh pr merge 6'],
  });
  assert.equal(result.tags.length, MAX_HOOK_TAGS);
  assert.ok(result.tags.includes('pr'), 'an activity tag must survive an area-heavy session');
  assert.ok(result.tags.includes('integration'));
});

test('review comes from the command, not from a path', () => {
  assert.ok(classify({ promptTexts: ['/code-review --fix'] }).tags.includes('review'));
  assert.ok(classify({ skills: ['security-review'] }).tags.includes('review'));
  assert.ok(!classify({ files: [{ path: 'docs/review.md', count: 1 }] }).tags.includes('review'));
});

test('apply_migration raises db with no .sql file in sight', () => {
  const result = classify({ toolNames: ['mcp__plugin_supabase_supabase__apply_migration'] });
  assert.deepEqual(result.tags, ['db']);
});

test('a fix branch is a hotfix', () => {
  assert.ok(classify({ branch: 'fix/loader-collection' }).tags.includes('hotfix'));
  assert.ok(classify({ branch: 'hotfix/tls-verify' }).tags.includes('hotfix'));
  assert.ok(!classify({ branch: 'feat/prefix-search' }).tags.includes('hotfix'));
});

test('the phase comes from the branch first, then a planning brief, then nowhere', () => {
  assert.equal(derivePhase({ branch: 'feat/phase7-retrieval' }), 'phase-7');
  assert.equal(derivePhase({ branch: 'phase-11/sprint' }), 'phase-11');
  assert.equal(
    derivePhase({ branch: 'main', docsTouched: ['docs/planning/50_PHASE7_retrieval_polish.md'] }),
    'phase-7',
  );
  assert.equal(derivePhase({ branch: 'main', docsTouched: ['docs/planning/00_AGENT_BRIEF.md'] }), '');
  assert.equal(
    derivePhase({ branch: 'main', docsTouched: [] }),
    '',
    'phase is never guessed from prose',
  );
});

// ------------------------------------------------------- files read, not edited
//
// A research or review worker edits nothing, so edited paths say nothing about
// it; 102 of the 112 unclassified notes in the index on 2026-09-21 were such
// subagents. What a session read is weaker evidence than what it changed, so it
// is consulted only when the edits raise no area at all.

test('a session that edited nothing takes its areas from the files it read', () => {
  const { tags } = classify({ filesRead: [{ path: 'ingest/src/ingest/cli.py' }, { path: 'db/migrations/001.sql' }] });
  assert.ok(tags.includes('ingest'));
  assert.ok(tags.includes('db'));
  assert.ok(!tags.includes(UNCLASSIFIED));
});

test('edits outrank reads: an editing session is described by what it changed', () => {
  const { tags } = classify({
    files: [{ path: 'hooks/lib/note.mjs' }],
    filesRead: [{ path: 'web/src/app/page.tsx' }, { path: 'web/src/app/layout.tsx' }],
  });
  assert.ok(tags.includes('harness'));
  assert.ok(!tags.includes('gui'));
});

test('reading raises areas only: no phase-brief, which means a brief was written', () => {
  const { tags } = classify({ filesRead: [{ path: 'docs/planning/50_PHASE7_retrieval.md' }] });
  assert.ok(tags.includes('planning'));
  assert.ok(!tags.includes('phase-brief'));
});

test('a session that neither edited nor read anything recognisable is still unclassified', () => {
  assert.deepEqual(classify({ filesRead: [{ path: 'notes.txt' }] }).tags, [UNCLASSIFIED]);
});

test('a planning brief filed in a per-sprint folder still names its phase', () => {
  assert.equal(derivePhase({ docsTouched: ['docs/planning/sprint-1/50_PHASE7_retrieval.md'] }), 'phase-7');
  assert.equal(derivePhase({ docsTouched: ['docs/planning/50_PHASE7_retrieval.md'] }), 'phase-7');
});

test('a planning file with no phase in its name names no phase; the branch or PR title carries it', () => {
  assert.equal(derivePhase({ docsTouched: ['docs/planning/sprint-2/90_SPRINT2_INTAKE.md'] }), '');
  assert.equal(derivePhase({ branch: 'feat/phase-14-containers', docsTouched: ['docs/planning/sprint-2/90_SPRINT2_INTAKE.md'] }), 'phase-14');
});

// ------------------------------------------------ H-2 through the classifier
//
// Brief 101's frozen rows (H-2), bb2dash unless a repo is named, driven through
// `classify`: the phase lands in `phase` and leads `tags`, and a row that reads
// `''` carries no phase tag at all. phase-aliases.test.mjs holds the same rows
// against `derivePhase`.

const BB2DASH = 'emstacho-su/bb2dash';
const HARNESS = 'emstacho-su/agentic-harness';
const BRIEF_80C = 'docs/planning/sprint-1-hub/briefs/80c_PHASE12B_page_pass.md';
const BRIEF_82 = 'docs/planning/sprint-2/82_PHASE14_containers.md';

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
  ['chore/sprint1-closeout', '', { prTitles: ['chore: sprint 1 close-out — planning docs by sprint, Phase 13 skipped, sprint 2 intake'] }],
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

for (const [branch, expected, extra = {}] of H2_ROWS) {
  const label = `${branch}${extra.repo ? ` (${extra.repo})` : ''}${extra.docsTouched ? ` + ${extra.docsTouched.length} doc(s)` : ''}`;
  test(`classify, H-2: ${label} -> ${expected || "''"}`, () => {
    const result = classify({ repo: BB2DASH, ...extra, branch, files: [{ path: 'README.md', count: 1 }] });
    assert.equal(result.phase, expected);
    const phaseTags = result.tags.filter((tag) => PHASE_FAMILY.test(tag));
    assert.deepEqual(phaseTags, expected ? [expected] : []);
    if (expected) assert.equal(result.tags[0], expected, 'the phase takes the first slot');
  });
}

test('the phase family these tests accept is the one the vocabulary declares', () => {
  assert.equal(String(PHASE_FAMILY), String(PHASE_TAG_PATTERN));
});
