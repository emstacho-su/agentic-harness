/**
 * Text surgery for the Outcome backfill. Pure: strings in, strings out.
 *
 * Unlike the link backfill this one has to change the body — that is the point,
 * `ingest` hashes the body and a new section is what makes it re-embed. It
 * inserts and never rewrites: every byte of the existing note survives, the
 * frontmatter included.
 *
 * **The note's text is not trusted.** "What I asked for" is whatever somebody
 * typed or pasted, and it sits above the fact table; a person's own writing sits
 * below the generated marker. So nothing here takes the *first* thing that looks
 * like a heading or a table row:
 *
 *   - only the generated part of the note is searched — everything up to the
 *     last `HANDWRITTEN_MARKER`, which `renderFacts` writes after the table;
 *   - within it the **last** match wins, because `renderBody` writes the fact
 *     table last and prompt text can only come before it;
 *   - a line starts after `\n` (or at the start), never after a bare `\r`. The
 *     `m` flag would also accept `\r`, U+2028 and U+2029 as line starts, which
 *     is how a pasted carriage return becomes a heading the file never had.
 */

import { HANDWRITTEN_MARKER } from './note.mjs';

const LINE_START = '(?:^|\\n)';
const LINE_END = '[ \\t]*(?=\\r?\\n|$)';

const FACTS_HEADING = new RegExp(`${LINE_START}(## Session facts)${LINE_END}`, 'g');
const OUTCOME_HEADING = new RegExp(`${LINE_START}(## Outcome)${LINE_END}`, 'g');
const TRANSCRIPT_ROW = new RegExp(`${LINE_START}\\| Transcript \\| \`([^\`\\r\\n]+)\` \\|${LINE_END}`, 'g');

/** The part of the note the hook generated: everything before the last marker. */
function generatedPart(text) {
  const at = text.lastIndexOf(HANDWRITTEN_MARKER);
  return at === -1 ? text : text.slice(0, at);
}

function lastMatch(pattern, text) {
  let last = null;
  for (const match of text.matchAll(pattern)) last = match;
  return last;
}

/** Where the captured group of `match` starts in the searched text. */
function groupIndex(match) {
  return match.index + match[0].indexOf(match[1]);
}

/** The transcript the note's own fact table names, or '' when it names none. */
export function transcriptPathFrom(raw) {
  return lastMatch(TRANSCRIPT_ROW, generatedPart(String(raw ?? '')))?.[1] ?? '';
}

/**
 * Does the note already carry the section? Only a heading *after* the last
 * "What I asked for" text can be the real one, and the real one sits directly
 * above the fact table — so it must come after every other `##` heading but
 * the facts.
 */
export function hasOutcome(raw) {
  const generated = generatedPart(String(raw ?? ''));
  const facts = lastMatch(FACTS_HEADING, generated);
  const outcome = lastMatch(OUTCOME_HEADING, generated);
  if (!outcome) return false;
  if (!facts) return true;
  if (groupIndex(outcome) > groupIndex(facts)) return false;
  // Nothing but the quoted section may sit between the two headings.
  const between = generated.slice(groupIndex(outcome), groupIndex(facts));
  return !/\n## /.test(between.slice(1));
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

  const match = lastMatch(FACTS_HEADING, generatedPart(text));
  if (!match) return { text, changed: false, error: 'no "## Session facts" heading to insert above' };

  const at = groupIndex(match);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const section = `${outcomeLines.join(eol)}${eol}`;
  return { text: `${text.slice(0, at)}${section}${text.slice(at)}`, changed: true, error: '' };
}
