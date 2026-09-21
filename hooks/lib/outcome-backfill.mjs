/**
 * Text surgery for the Outcome backfill. Pure: strings in, strings out.
 *
 * Unlike the link backfill this one has to change the body — that is the point,
 * `ingest` hashes the body and a new section is what makes it re-embed. It
 * inserts and never rewrites: every byte of the existing note survives, the
 * frontmatter included.
 */

const FACTS_HEADING = /^## Session facts[ \t]*$/m;
const OUTCOME_HEADING = /^## Outcome[ \t]*$/m;
const TRANSCRIPT_ROW = /^\| Transcript \| `([^`\n]+)` \|[ \t]*$/m;

/** The transcript the note's own fact table names, or '' when it names none. */
export function transcriptPathFrom(raw) {
  return TRANSCRIPT_ROW.exec(String(raw ?? ''))?.[1] ?? '';
}

export function hasOutcome(raw) {
  return OUTCOME_HEADING.test(String(raw ?? ''));
}

/**
 * Insert the rendered section directly above `## Session facts`, where
 * `renderBody` puts it.
 *
 * @param {string} raw            the whole note, frontmatter included
 * @param {string[]} outcomeLines from `renderOutcome`
 * @returns {{text: string, changed: boolean, error: string}}
 */
export function insertOutcome(raw, outcomeLines) {
  const text = String(raw ?? '');
  if (hasOutcome(text) || outcomeLines.length === 0) return { text, changed: false, error: '' };

  const match = FACTS_HEADING.exec(text);
  if (!match) return { text, changed: false, error: 'no "## Session facts" heading to insert above' };

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const section = `${outcomeLines.join(eol)}${eol}`;
  return {
    text: `${text.slice(0, match.index)}${section}${text.slice(match.index)}`,
    changed: true,
    error: '',
  };
}
