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
import { UNCLASSIFIED } from '../lib/vocabulary.mjs';
import { GOLDEN_DIR } from './helpers/sandbox.mjs';
import { SCENARIOS } from './helpers/scenarios.mjs';
import { parseTagsDoc } from './helpers/tags-doc.mjs';

const doc = parseTagsDoc();
const DOCUMENTED = new Set([...doc.areas, ...doc.activities, ...doc.sentinel]);
const PHASE_FAMILY = /^phase-([1-9][0-9]?)$/;

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
