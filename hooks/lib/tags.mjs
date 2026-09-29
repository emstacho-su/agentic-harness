/**
 * The tag classifier (R-27.4).
 *
 * Area tags come from the repo-relative paths the session edited — or, when the
 * edits raise none, from the paths it read; activity tags
 * come from transcript signals — the commands it ran, the skills it invoked and
 * the branch it was on. Every term it can produce is in `docs/tags.md`, and
 * `tests/tags.test.mjs` proves that by set difference rather than by trust.
 *
 * A session that raises nothing gets exactly `[unclassified]`, which is a
 * reviewable state and not a failure: a planning conversation that edited no
 * files genuinely has nothing mechanical to say about itself.
 */

import { MAX_HOOK_TAGS } from './constants.mjs';
import { aliasPhase } from './phase-aliases.mjs';
import { ACTIVITY_TAGS, AREA_TAGS, PHASE_TAG_PATTERN, UNCLASSIFIED, phaseTag } from './vocabulary.mjs';

/** Path shape -> area tag. A path may raise more than one. */
const AREA_RULES = Object.freeze([
  ['ingest', (p) => p.startsWith('ingest/')],
  ['db', (p) => p.startsWith('db/') || p.includes('/migrations/') || p.endsWith('.sql')],
  ['retrieval', (p) => /(^|\/)(retrieval|search)|(^|\/)rag\//.test(p)],
  ['gui', (p) => p.startsWith('web/') || /\.(tsx|jsx|css|scss)$/.test(p)],
  ['mcp', (p) => p.includes('mcp-server/') || /(^|\/)mcp\//.test(p)],
  ['harness', (p) => p.startsWith('hooks/') || p.includes('.claude/') || p.includes('agentic-harness')],
  ['planning', (p) => p.startsWith('docs/planning/')],
  ['docs', (p) => p.startsWith('docs/') || (p.endsWith('.md') && !p.startsWith('docs/planning/'))],
]);

/** Command-line shape -> activity tag. */
const COMMAND_RULES = Object.freeze([
  ['pr', /\bgh\s+pr\s+(create|merge|ready|edit|comment)\b/],
  ['integration', /\bgit\s+(merge|rebase)\b|\bgh\s+pr\s+merge\b/],
  ['validation', /\b(pytest|vitest|cargo\s+test|go\s+test)\b|\bnpm\s+(run\s+)?test\b|\bnode\s+--test\b/],
]);

/** Prompt or skill shape -> tag. Reviews are run, not edited. */
const REVIEW_SIGNAL = /(^|\s)\/(code-review|security-review)\b|^(code-review|security-review)$/;

/** Supabase's migration tool is a database signal no path records. */
const MIGRATION_TOOL = /apply_migration/;

/** Reserved slots inside `MAX_HOOK_TAGS`, so neither axis crowds out the other. */
const AREA_SLOTS = 2;
const ACTIVITY_SLOTS = 2;

const HOTFIX_BRANCH = /^(fix|hotfix)\//;
const PHASE_BRIEF_PATH = /^docs\/planning\/.*phase/i;

/** `phase7`, `phase-12b`, `PHASE_14`: the one rule every repo shares (H-1). */
const PHASE_TOKEN = /phase[-_ ]?([0-9]{1,2})([a-z]?)(?![a-z0-9])/gi;
/** The anchor of a planning path: briefs are filed into per-sprint folders below it. */
const PHASE_IN_PLANNING_PATH = 'docs/planning/';

/** The repo whose branch segments and aliases name phases (H-1 rules (i) and (ii)). */
const SEGMENT_RULE_REPO = 'emstacho-su/bb2dash';
const BRANCH_TYPE_PREFIX = /^(?:feat|fix|chore|docs)\/(.+)$/;
const PHASE_SEGMENT = /^([0-9]{1,2})([a-z]?)$/;

/**
 * `phase-7`, `phase-12b`, or `''` (brief 101 H-1).
 *
 * Three sources, in order of how specific each one is: the branch, the title of
 * a pull request from the session's window, then a planning path under
 * `docs/planning/` the session touched. `prTitles` is empty for the hook — it
 * has no network — and is filled in by the back-fill, which does. Within one
 * source every distinct phase is collected: one is the answer; two or more is
 * `''` and no later source is read, because a session that spans phases
 * carries none; none moves on to the next source.
 *
 * For `emstacho-su/bb2dash` the branch also yields a phase from a segment of
 * digits (`feat/grades-v1-16`) or from the alias table (`phase-aliases.mjs`),
 * and PR titles are not read: some of its titles name the wrong phase.
 *
 * Nothing is read from prose. A wrong phase is worse than no phase: the empty
 * field is honest and a filter on it returns nothing, where a wrong one returns
 * the wrong sessions and reads as an answer.
 */
export function derivePhase({ branch = '', docsTouched = [], prTitles = [], repo = '' } = {}) {
  const bb2dash = String(repo ?? '').toLowerCase() === SEGMENT_RULE_REPO;
  const sources = [
    () => branchPhases(String(branch ?? ''), bb2dash),
    () => (bb2dash ? [] : listOf(prTitles).flatMap((title) => tokenPhases(String(title ?? '')))),
    () => listOf(docsTouched).flatMap((doc) => planningPhases(String(doc?.path ?? doc ?? ''))),
  ];
  for (const source of sources) {
    const found = new Set(source());
    if (found.size === 1) return [...found][0];
    if (found.size > 1) return '';
  }
  return '';
}

/**
 * The first phase slot filled by `phase`, as `classify` would have filled it:
 * a phase learned after classifying (a worker inheriting its parent's) takes
 * slot one, and the cap drops the last tag, never a hand tag (this list is
 * hook-applied only). `unclassified` gives way to it.
 */
export function withPhaseTag(tags, phase) {
  const list = listOf(tags).filter((tag) => tag !== UNCLASSIFIED && !PHASE_TAG_PATTERN.test(tag));
  if (!phase) return [...listOf(tags)];
  return [phase, ...list].slice(0, MAX_HOOK_TAGS);
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

/** Every phase the phase rule finds in `text`. */
function tokenPhases(text) {
  return [...text.matchAll(PHASE_TOKEN)]
    .map((match) => phaseTag(match[1], match[2].toLowerCase()))
    .filter(Boolean);
}

/** The branch's phases: the phase rule, and for bb2dash its segments and aliases. */
function branchPhases(branch, bb2dash) {
  const found = tokenPhases(branch);
  if (!bb2dash) return found;
  const name = branch.match(BRANCH_TYPE_PREFIX)?.[1] ?? '';
  if (!name) return found;
  for (const segment of name.split('-')) {
    const match = segment.match(PHASE_SEGMENT);
    const tag = match ? phaseTag(match[1], match[2]) : '';
    if (tag) found.push(tag);
  }
  const aliased = aliasPhase(name);
  if (aliased) found.push(aliased);
  return found;
}

/** Phases named below `docs/planning/`; a path anywhere else names none. */
function planningPhases(doc) {
  const posix = doc.replace(/\\/g, '/');
  const at = posix.indexOf(PHASE_IN_PLANNING_PATH);
  if (at === -1 || (at > 0 && posix[at - 1] !== '/')) return [];
  return tokenPhases(posix.slice(at + PHASE_IN_PLANNING_PATH.length));
}

/**
 * Classify one session.
 *
 * @returns {{tags: string[], phase: string}} at most `MAX_HOOK_TAGS` tags, or
 *          exactly `['unclassified']`.
 */
export function classify({
  files = [],
  filesRead = [],
  docsTouched = [],
  commandTexts = [],
  promptTexts = [],
  skills = [],
  toolNames = [],
  branch = '',
  prTitles = [],
  repo = '',
} = {}) {
  const phase = derivePhase({ branch, docsTouched, prTitles, repo });
  // What a session read is weaker evidence than what it changed, so it speaks
  // only when the edits are silent: a research or review worker edits nothing.
  const editedAreas = countAreas(files);
  const areaCounts = editedAreas.size ? editedAreas : countAreas(filesRead);
  const activities = new Set(collectActivities({ commandTexts, promptTexts, skills, toolNames, branch, files }));

  if (activities.has('review')) {
    // `review` is an area term raised by an activity signal; see docs/tags.md.
    areaCounts.set('review', (areaCounts.get('review') || 0) + 1);
    activities.delete('review');
  }
  if (activities.has('db')) {
    areaCounts.set('db', (areaCounts.get('db') || 0) + 1);
    activities.delete('db');
  }

  const areas = orderedAreas(areaCounts);
  const activityTags = ACTIVITY_TAGS.filter((tag) => activities.has(tag));

  // Slot order, not simple concatenation: an area-heavy session would otherwise
  // spend all five slots on areas and never say that it opened a PR. Two of
  // each first, then whatever is left over fills the remaining slots.
  const ordered = [
    ...(phase ? [phase] : []),
    ...areas.slice(0, AREA_SLOTS),
    ...activityTags.slice(0, ACTIVITY_SLOTS),
    ...areas.slice(AREA_SLOTS),
    ...activityTags.slice(ACTIVITY_SLOTS),
  ];

  return {
    phase,
    tags: ordered.length === 0 ? [UNCLASSIFIED] : ordered.slice(0, MAX_HOOK_TAGS),
  };
}

function countAreas(files) {
  const counts = new Map();
  for (const file of files) {
    const posix = String(file?.path ?? file ?? '');
    if (!posix) continue;
    for (const [tag, matches] of AREA_RULES) {
      if (matches(posix)) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return counts;
}

/** Most-touched area first; ties broken by vocabulary order, never by chance. */
function orderedAreas(counts) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || AREA_TAGS.indexOf(a[0]) - AREA_TAGS.indexOf(b[0]))
    .map(([tag]) => tag);
}

function collectActivities({ commandTexts, promptTexts, skills, toolNames, branch, files }) {
  const found = [];

  for (const command of commandTexts) {
    const text = String(command ?? '');
    for (const [tag, pattern] of COMMAND_RULES) {
      if (pattern.test(text)) found.push(tag);
    }
  }
  for (const prompt of promptTexts) {
    if (REVIEW_SIGNAL.test(String(prompt ?? '').trim())) found.push('review');
  }
  for (const skill of skills) {
    if (REVIEW_SIGNAL.test(String(skill ?? '').trim())) found.push('review');
  }
  for (const tool of toolNames) {
    if (MIGRATION_TOOL.test(String(tool ?? ''))) found.push('db');
  }
  if (HOTFIX_BRANCH.test(String(branch ?? ''))) found.push('hotfix');
  for (const file of files) {
    if (PHASE_BRIEF_PATH.test(String(file?.path ?? file ?? ''))) {
      found.push('phase-brief');
      break;
    }
  }
  return found;
}
