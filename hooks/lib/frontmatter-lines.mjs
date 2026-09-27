/**
 * Edit single frontmatter lines in place, never re-serialising the note.
 *
 * The same promise rename-hubs.mjs makes for `up:`: a note's frontmatter was
 * written by the hook, by Python's `yaml.safe_dump`, or by a person, and a
 * re-serialise would reorder and requote all of it. Here each top-level
 * `key: value` line between the delimiters that an edit names is rewritten on
 * its own, keeping its quote style, its spacing and its line ending; every
 * other byte of the file stays as it was.
 */

const DELIMITER = /^---\s*$/;
const KEY_LINE = /^([A-Za-z_][\w-]*):([ \t]*)(.*?)([ \t]*)$/;
/** A value that may stay unquoted in YAML without changing meaning. */
const PLAIN_SAFE = /^[A-Za-z0-9_./-][A-Za-z0-9_ ./-]*$/;

const splitEol = (line) => {
  const eol = line.match(/\r?\n$/)?.[0] ?? '';
  return { body: line.slice(0, line.length - eol.length), eol };
};

/** `'it''s'` -> `{value: "it's", quote: "'"}`; a double-quoted value with escapes is refused (null). */
function unquote(raw) {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return { value: raw.slice(1, -1).replace(/''/g, "'"), quote: "'" };
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    const inner = raw.slice(1, -1);
    return inner.includes('\\') ? null : { value: inner, quote: '"' };
  }
  return { value: raw, quote: '' };
}

function requote(value, quote) {
  if (quote === '"' && !/["\\]/.test(value)) return `"${value}"`;
  if (quote === '' && PLAIN_SAFE.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * `raw` with each frontmatter line whose key is in `edits` passed through its
 * function: `(value) => newValue`, where returning the same value (or null)
 * leaves the line alone. Pure.
 *
 * @param {string} raw
 * @param {Record<string, (value: string) => (string|null)>} edits
 * `found` says whether a frontmatter block was located at all (a file with
 * bare-CR line ends has none this editor can see), and `skipped` names each
 * line an edit was asked for but that was left alone because its value is
 * double-quoted with escapes, which this editor does not rewrite.
 *
 * @returns {{text: string, changes: Array<{key: string, old: string, new: string}>, skipped: string[], found: boolean}}
 */
export function editFrontmatterLines(raw, edits) {
  const text = String(raw);
  const lines = text.split(/(?<=\n)/);
  const missing = { text, changes: [], skipped: [], found: false };
  if (lines.length === 0 || !DELIMITER.test(splitEol(lines[0]).body)) return missing;
  const close = lines.findIndex((line, index) => index > 0 && DELIMITER.test(splitEol(line).body));
  if (close === -1) return missing;

  const changes = [];
  const skipped = [];
  const rewritten = lines.map((line, index) => {
    if (index === 0 || index >= close) return line;
    const { body, eol } = splitEol(line);
    const match = body.match(KEY_LINE);
    if (!match || !Object.hasOwn(edits, match[1])) return line;
    const [, key, before, rawValue, after] = match;
    const parsed = unquote(rawValue);
    if (!parsed) {
      skipped.push(key);
      return line;
    }
    const next = edits[key](parsed.value);
    if (next === null || next === undefined || next === parsed.value) return line;
    const value = requote(String(next), parsed.quote);
    changes.push({ key, old: rawValue, new: value });
    return `${key}:${before}${value}${after}${eol}`;
  });
  return { text: changes.length ? rewritten.join('') : text, changes, skipped, found: true };
}

