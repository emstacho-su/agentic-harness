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
import { ACTIVITY_TAGS, AREA_TAGS, UNCLASSIFIED, phaseTag } from './vocabulary.mjs';

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
const PHASE_IN_BRANCH = /phase[-_ ]?(\d{1,2})\b/i;
const PHASE_IN_PLANNING_PATH = /docs\/planning\/[^/]*phase[-_ ]?(\d{1,2})/i;
const PHASE_IN_TITLE = /\bphase[-_ ]?(\d{1,2})\b/i;
const PHASE_BRIEF_PATH = /^docs\/planning\/.*phase/i;

/**
 * `phase-7`, or `''`.
 *
 * Three sources, in order of how specific each one is: the branch, the title of
 * a pull request from the session's window, then a planning brief the session
 * touched. `prTitles` is empty for the hook — it has no network — and is filled
 * in by the one-time migration, which does.
 *
 * Nothing is read from prose. A wrong phase is worse than no phase: the empty
 * field is honest and a filter on it returns nothing, where a wrong one returns
 * the wrong sessions and reads as an answer.
 */
export function derivePhase({ branch = '', docsTouched = [], prTitles = [] } = {}) {
  const fromBranch = String(branch).match(PHASE_IN_BRANCH);
  if (fromBranch) {
    const tag = phaseTag(fromBranch[1]);
    if (tag) return tag;
  }

  for (const title of prTitles) {
    const match = String(title).match(PHASE_IN_TITLE);
    if (match) {
      const tag = phaseTag(match[1]);
      if (tag) return tag;
    }
  }

  for (const doc of docsTouched) {
    const match = String(doc).match(PHASE_IN_PLANNING_PATH);
    if (match) {
      const tag = phaseTag(match[1]);
      if (tag) return tag;
    }
  }
  return '';
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
} = {}) {
  const phase = derivePhase({ branch, docsTouched, prTitles });
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
