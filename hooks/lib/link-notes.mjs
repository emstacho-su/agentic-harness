/**
 * Adding the derived links to a note that already exists: frontmatter only.
 *
 * The capture hook links every note it writes from now on (`links.mjs`). This is
 * the same derivation applied to the notes already in the vault, under a
 * narrower promise than a capture makes: **the block gains `up` and `related`,
 * and nothing else in the file changes.**
 *
 * That is why the body is never parsed and re-rendered here. The frontmatter
 * block is cut out of the raw text and replaced; everything after its closing
 * delimiter is carried over as the bytes it was. `ingest` hashes the body, so
 * this costs a metadata update per note and not one embedding.
 *
 * And it is why a note is refused when re-serializing its frontmatter would
 * change any other line — a hand-typed flow list, a double-quoted string. The
 * rewrite would be harmless, and the hook will make it at that note's next
 * capture anyway, but a bulk pass over three hundred notes is not where a
 * person's formatting gets normalised.
 */

import { parseFrontmatter, serializeFrontmatter } from './frontmatter.mjs';
import { withLinks } from './links.mjs';

/** The opening delimiter, the block, and the closing delimiter — not the newline after it. */
const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?=\r?\n|$)/;

/** Lines this pass owns: the two link fields and the items of `related`. */
const LINK_LINE = /^(up:|related:|  - '\[\[)/;

/**
 * @param {string} raw   the whole note
 * @param {string} area  `projects` or `classes`: the folder the note was found in
 * @returns {{text: string, changed: boolean, added: string[], removed: string[], error: string}}
 *          `text` is `raw` itself whenever `changed` is false.
 */
export function relinkNote(raw, area) {
  const refuse = (error) => ({ text: raw, changed: false, added: [], removed: [], error });

  const block = FRONTMATTER_BLOCK.exec(raw);
  if (!block) return refuse('no frontmatter block');

  const parsed = parseFrontmatter(raw);
  if (!parsed.ok) return refuse(parsed.error);

  const before = block[0].split(/\r?\n/);
  const after = serializeFrontmatter(withLinks(parsed.fields, area)).split('\n');

  const added = difference(after, before);
  const removed = difference(before, after);
  const foreign = [...added, ...removed].filter((line) => !LINK_LINE.test(line));
  if (foreign.length) return refuse(`would also rewrite ${foreign.length} other line(s): ${foreign[0]}`);

  if (added.length === 0 && removed.length === 0) {
    return { text: raw, changed: false, added, removed, error: '' };
  }
  return { text: after.join('\n') + raw.slice(block[0].length), changed: true, added, removed, error: '' };
}

/** Lines of `left` with no counterpart in `right`, as multisets, in `left`'s order. */
function difference(left, right) {
  const remaining = new Map();
  for (const line of right) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const out = [];
  for (const line of left) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else out.push(line);
  }
  return out;
}
