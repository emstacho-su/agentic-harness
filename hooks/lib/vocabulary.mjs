/**
 * The controlled tag vocabulary, machine-readable.
 *
 * `docs/tags.md` is the human-readable source of the same list, and
 * `tests/vocabulary.test.mjs` fails if the two drift apart. Order matters: it
 * is the tie-break when the five-tag cap has to drop something.
 */

/** What the session touched. Raised from repo-relative paths. */
export const AREA_TAGS = Object.freeze([
  'ingest',
  'db',
  'retrieval',
  'gui',
  'mcp',
  'harness',
  'docs',
  'review',
  'planning',
]);

/** What the session did. Raised from transcript signals. */
export const ACTIVITY_TAGS = Object.freeze([
  'phase-brief',
  'integration',
  'pr',
  'hotfix',
  'validation',
]);

/** The phase tag is a family, `phase-7`, not a fixed term. */
export const PHASE_TAG_PATTERN = /^phase-([1-9][0-9]?)$/;

/** Printed in docs/tags.md as the family's shape. */
export const PHASE_TAG_TEMPLATE = 'phase-<n>';

/** Not a term: "the classifier had nothing to go on". */
export const UNCLASSIFIED = 'unclassified';

const KNOWN = new Set([...AREA_TAGS, ...ACTIVITY_TAGS, UNCLASSIFIED]);

/** Is `tag` in the vocabulary, counting the `phase-<n>` family and the sentinel? */
export function isKnownTag(tag) {
  if (typeof tag !== 'string' || tag === '') return false;
  return KNOWN.has(tag) || PHASE_TAG_PATTERN.test(tag);
}

/** Every literal term, in vocabulary order. Used by the docs-parity test. */
export function allLiteralTags() {
  return [...AREA_TAGS, ...ACTIVITY_TAGS];
}

/** `phase-7` from `7`, or `''` when the number is out of range. */
export function phaseTag(number) {
  const n = Number.parseInt(String(number ?? ''), 10);
  if (!Number.isInteger(n) || n < 1 || n > 99) return '';
  return `phase-${n}`;
}
