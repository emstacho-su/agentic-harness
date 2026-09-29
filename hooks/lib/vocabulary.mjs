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

/** The phase tag is a family, `phase-7` or `phase-12b`, not a fixed term. */
export const PHASE_TAG_PATTERN = /^phase-([1-9][0-9]?)([a-z]?)$/;

/** Printed in docs/tags.md as the family's shape: `phase-<n>`, or `phase-<n><l>` with a letter. */
export const PHASE_TAG_TEMPLATE = 'phase-<n>[<l>]';

/** Not a term: "the classifier had nothing to go on". */
export const UNCLASSIFIED = 'unclassified';

const KNOWN = new Set([...AREA_TAGS, ...ACTIVITY_TAGS, UNCLASSIFIED]);

/** Is `tag` in the vocabulary, counting the `phase-<n>` family and the sentinel? */
export function isKnownTag(tag) {
  if (typeof tag !== 'string' || tag === '') return false;
  return KNOWN.has(tag) || PHASE_TAG_PATTERN.test(tag);
}

const PHASE_NUMBER = /^[0-9]{1,2}$/;
const PHASE_LETTER = /^[a-z]?$/;

/**
 * `phase-7` from `7`, `phase-12b` from `(12, 'b')`, or `''` when the number is
 * out of range or the letter is not one lowercase letter. The letter is its
 * own argument: `'12b'` as the number is refused, never read as `12`.
 */
export function phaseTag(number, letter = '') {
  const digits = String(number ?? '');
  const suffix = String(letter ?? '');
  if (!PHASE_NUMBER.test(digits) || !PHASE_LETTER.test(suffix)) return '';
  const n = Number.parseInt(digits, 10);
  if (n < 1 || n > 99) return '';
  return `phase-${n}${suffix}`;
}
