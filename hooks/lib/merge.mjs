/**
 * Merge, never rewrite (R-27.2, R-27.4).
 *
 * The note on disk is not the hook's private output. Stack edits it — a tag,
 * a line of context, a field of his own — and the next `SessionEnd` must not
 * quietly undo that. So every write is a merge of what the hook just derived
 * into what is already there, under three rules:
 *
 *   1. **Lists grow.** A tag, commit or PR in the note stays in the note.
 *   2. **Scalars only improve.** A derived value replaces an empty one; it
 *      never replaces a value with an empty.
 *   3. **`status` ratchets.** active -> concluded -> superseded, one way. A
 *      stale SessionEnd replayed over a concluded note writes nothing at all.
 */

import { FIELD_SPEC } from './frontmatter.mjs';
import {
  MAX_ARTIFACTS,
  MAX_CHILD_SESSIONS,
  MAX_COMMITS,
  MAX_CWDS_SEEN,
  MAX_DOCS_TOUCHED,
  MAX_FILES_LISTED,
  MAX_MEMORY_FILES,
  MAX_PRS,
  MAX_REPOS_TOUCHED,
  STATUS_CONCLUDED,
  STATUS_RANK,
  STATUS_SUPERSEDED,
} from './constants.mjs';
import { UNCLASSIFIED } from './vocabulary.mjs';
import { isoToMillis, uniqueCapped } from './text.mjs';

/** What the caller should do with the result. */
export const ACTION_CREATE = 'create';
export const ACTION_MERGE = 'merge';
export const ACTION_RESUME = 'resume';
export const ACTION_NOOP = 'noop';

const LIST_CAPS = Object.freeze({
  tags: null, // manual tags are uncapped; the hook's own five are capped upstream
  supersedes: 20,
  child_sessions: MAX_CHILD_SESSIONS,
  commits: MAX_COMMITS,
  prs: MAX_PRS,
  memory_files: MAX_MEMORY_FILES,
  docs_touched: MAX_DOCS_TOUCHED,
  artifacts: MAX_ARTIFACTS,
  files_modified: MAX_FILES_LISTED,
  cwds_seen: MAX_CWDS_SEEN,
  repos_touched: MAX_REPOS_TOUCHED,
});

const LIST_KINDS = new Set(['list', 'numlist']);
const KIND_BY_FIELD = new Map(FIELD_SPEC);

/** Rank of a status string; an unknown value ranks lowest rather than throwing. */
export function statusRank(status) {
  const at = STATUS_RANK.indexOf(String(status ?? ''));
  return at === -1 ? 0 : at;
}

/**
 * Decide what this `SessionEnd` should do to the note that is already there.
 *
 * @param {object|null} existing  parsed frontmatter, or null when there is no note
 * @param {object} next           the frontmatter this run derived
 * @returns {{action: string, fields: object, reason: string}}
 */
export function planWrite(existing, next) {
  if (!existing) return { action: ACTION_CREATE, fields: next, reason: 'no existing note' };

  const settled = statusRank(existing.status) >= statusRank(STATUS_CONCLUDED);
  const advanced = hasNewActivity(existing, next);

  if (settled && !advanced) {
    return { action: ACTION_NOOP, fields: existing, reason: `status ${existing.status} and nothing new` };
  }
  if (settled && advanced) {
    return {
      action: ACTION_RESUME,
      fields: resumeFields(existing, next),
      reason: `resumed after ${existing.status}`,
    };
  }
  return { action: ACTION_MERGE, fields: mergeFields(existing, next), reason: 'merged into active note' };
}

/**
 * Did anything actually happen since the note was written?
 *
 * `ended_at` is the primary signal. Prompt count is the tie-break for the case
 * where a resume adds turns inside the same second — rare, cheap to check, and
 * the alternative is losing a genuine resume to clock granularity.
 */
export function hasNewActivity(existing, next) {
  const before = isoToMillis(existing?.ended_at);
  const after = isoToMillis(next?.ended_at);
  if (Number.isFinite(before) && Number.isFinite(after) && after > before) return true;
  return Number(next?.prompt_count ?? 0) > Number(existing?.prompt_count ?? 0);
}

/**
 * A resume that arrives after the note settled starts a new note (Stack,
 * 2026-09-14): ids stay immutable, and the chain is walkable in both directions
 * — forward by filtering `resumed_from`, backward by following it.
 */
function resumeFields(existing, next) {
  return {
    ...next,
    resumed_from: String(existing.id ?? ''),
    supersedes: uniqueCapped([String(existing.id ?? ''), ...asList(existing.supersedes)], LIST_CAPS.supersedes),
  };
}

/** The previous note, marked superseded. Returns a new object. */
export function markSuperseded(existing) {
  return { ...existing, status: STATUS_SUPERSEDED };
}

/**
 * Field-by-field merge driven by the schema, so a field added to `FIELD_SPEC`
 * gets the right behaviour without a second edit here.
 */
export function mergeFields(existing, next) {
  const merged = { ...existing };

  for (const key of Object.keys(next)) {
    const kind = KIND_BY_FIELD.get(key) ?? 'quoted';
    if (LIST_KINDS.has(kind)) {
      merged[key] = uniqueCapped([...asList(existing[key]), ...asList(next[key])], LIST_CAPS[key] ?? null);
      continue;
    }
    if (kind === 'map') {
      merged[key] = next[key];
      continue;
    }
    merged[key] = preferNonEmpty(next[key], existing[key]);
  }

  merged.status = STATUS_RANK[Math.max(statusRank(existing.status), statusRank(next.status))];
  merged.tags = mergeTags(existing.tags, next.tags);
  merged.prompt_count = Math.max(Number(existing.prompt_count ?? 0), Number(next.prompt_count ?? 0));
  merged.command_count = Math.max(Number(existing.command_count ?? 0), Number(next.command_count ?? 0));
  return merged;
}

/**
 * Union of both tag lists, with one exception: `unclassified` is bookkeeping,
 * not a term, so it drops the moment any real tag exists on either side.
 */
export function mergeTags(existingTags, nextTags) {
  const union = uniqueCapped([...asList(existingTags), ...asList(nextTags)], null);
  const real = union.filter((tag) => tag !== UNCLASSIFIED);
  return real.length > 0 ? real : [UNCLASSIFIED];
}

function preferNonEmpty(candidate, fallback) {
  if (candidate === undefined || candidate === null || candidate === '') {
    return fallback === undefined ? '' : fallback;
  }
  return candidate;
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}
