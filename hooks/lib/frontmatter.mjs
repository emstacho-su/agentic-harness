/**
 * The frontmatter schema, and a parser narrow enough to be trusted.
 *
 * The hook both writes and re-reads session notes: it merges its new facts into
 * whatever is already on disk so a tag Stack typed by hand survives. That means
 * reading YAML. Pulling in a YAML library would be a dependency in a hook that
 * must start in single-digit milliseconds, so this parses the subset the hook
 * itself emits, plus the shapes a person plausibly hand-types.
 *
 * The subset:
 *   key: 'single quoted'      key: "double quoted"      key: bare
 *   key: 123                  key: true                 key: []
 *   key: [a, 'b', 3]          key:\n  - item            key:\n  subkey: value
 *   # whole-line comments
 *
 * Anything else is a parse failure, and a parse failure makes the caller refuse
 * to write. Silently rewriting a note whose YAML we could not read is exactly
 * how a hand-added tag disappears.
 */

import { yamlStr } from './text.mjs';

const QUOTED = 'quoted';
const PLAIN = 'plain';
const LIST = 'list';
const NUMBER_LIST = 'numlist';
const MAP = 'map';

/**
 * Frozen field order and emit style. R-27.2 / R-27.3 name every field here;
 * renaming one breaks the W-H2 seam, so the names are contract, not preference.
 */
export const FIELD_SPEC = Object.freeze([
  ['id', QUOTED],
  ['title', QUOTED],
  ['type', PLAIN],
  ['schema_version', PLAIN],
  ['collection', QUOTED],
  ['collection_source', QUOTED],
  ['session_id', QUOTED],
  ['date', PLAIN],
  ['started_at', QUOTED],
  ['ended_at', QUOTED],
  ['duration_minutes', PLAIN],
  ['status', QUOTED],
  ['concluded_at', QUOTED],
  ['end_reason', QUOTED],
  ['repo', QUOTED],
  ['branch', QUOTED],
  ['worktree', QUOTED],
  ['repos_touched', LIST],
  ['cwd', QUOTED],
  ['cwds_seen', LIST],
  ['phase', QUOTED],
  ['tags', LIST],
  ['supersedes', LIST],
  ['resumed_from', QUOTED],
  ['parent_session', QUOTED],
  ['child_sessions', LIST],
  ['commits', LIST],
  ['prs', NUMBER_LIST],
  ['memory_files', LIST],
  ['plan_file', QUOTED],
  ['docs_touched', LIST],
  ['artifacts', LIST],
  ['files_modified', LIST],
  ['prompt_count', PLAIN],
  ['command_count', PLAIN],
  ['agent', PLAIN],
  ['agent_type', QUOTED],
  ['origin', QUOTED],
  ['captured_by', QUOTED],
  ['generator', QUOTED],
  ['tools_used', MAP],
  // Derived Obsidian links (`links.mjs`). Appended, so no contract field moved.
  ['up', QUOTED],
  ['related', LIST],
  // Which machine wrote the note (`machine-env.mjs`). Appended, same reason.
  ['machine', QUOTED],
]);

/** Field names in emit order. Handy for tests and for the migration. */
export const FIELD_ORDER = Object.freeze(FIELD_SPEC.map(([name]) => name));

const DELIMITER = /^---\s*$/;

/**
 * Keys that mean something to the JavaScript object model rather than to the
 * note. These files are hand-edited, and their parsed shape is spread into new
 * objects and serialized back out; a key that can move a prototype has no
 * business in a session note's frontmatter.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The key shape `parseBlock` accepts, which is therefore the only shape the
 * serializer may emit.
 *
 * `tools_used` was the one field whose keys went out unescaped, and its keys
 * are tool names read straight from a transcript. A name containing a newline
 * closed the block and wrote arbitrary keys at column zero — after every
 * legitimate one, so they *won* on the next parse. Forging `status:
 * 'superseded'` that way diverts the next merge into the resume branch and
 * orphans the real note.
 */
const EMITTABLE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

/**
 * Split `raw` into frontmatter and body.
 *
 * Returns `{ ok: true, fields, body }` or `{ ok: false, error, body }`. A note
 * with no frontmatter at all is `ok` with empty fields — that is a new note,
 * not a broken one.
 */
export function parseFrontmatter(raw) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!DELIMITER.test(text.split('\n', 1)[0] ?? '')) {
    return { ok: true, fields: {}, body: text };
  }

  const lines = text.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (DELIMITER.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) return { ok: false, error: 'frontmatter has no closing ---', body: text };

  try {
    const fields = parseBlock(lines.slice(1, end));
    return { ok: true, fields, body: lines.slice(end + 1).join('\n') };
  } catch (err) {
    return { ok: false, error: err?.message || 'unparseable frontmatter', body: text };
  }
}

function parseBlock(lines) {
  const fields = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) throw new Error(`unexpected indentation at "${line.trim()}"`);

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_.-]*):(.*)$/);
    if (!match) throw new Error(`not a key: "${line.trim()}"`);
    const [, key, rest] = match;
    if (UNSAFE_KEYS.has(key)) throw new Error(`reserved key in frontmatter: "${key}"`);
    const inline = rest.trim();

    if (inline !== '') {
      fields[key] = parseScalarOrFlow(inline);
      continue;
    }

    // Block form: consume the indented lines that follow.
    const child = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
      const trimmed = lines[i + 1].trim();
      // An indented comment is still a comment. Treating one as a mapping key
      // made the note unparseable, which made the hook refuse to write it ever
      // again — a comment beside a tag was enough to retire the note silently.
      if (trimmed !== '' && !trimmed.startsWith('#')) child.push(lines[i + 1]);
      i += 1;
    }
    fields[key] = child.length === 0 ? '' : parseChildBlock(child);
  }
  return fields;
}

function parseChildBlock(child) {
  if (child.every((line) => /^\s*-\s/.test(line) || /^\s*-\s*$/.test(line))) {
    return child.map((line) => parseScalar(line.replace(/^\s*-\s*/, '').trim()));
  }
  const map = {};
  for (const line of child) {
    const match = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (!match) throw new Error(`not a nested key: "${line.trim()}"`);
    const key = match[1].trim();
    if (UNSAFE_KEYS.has(key)) throw new Error(`reserved key in frontmatter: "${key}"`);
    map[key] = parseScalar(match[2].trim());
  }
  return map;
}

function parseScalarOrFlow(text) {
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new Error(`unterminated flow sequence: "${text}"`);
    const inner = text.slice(1, -1).trim();
    if (inner === '') return [];
    return splitFlow(inner).map((item) => parseScalar(item.trim()));
  }
  if (text === '{}') return {};
  return parseScalar(text);
}

/** Split `a, 'b, c', d` on commas that are not inside quotes. */
function splitFlow(inner) {
  const parts = [];
  let current = '';
  let quote = '';
  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function parseScalar(text) {
  if (text === '') return '';
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'")) throw new Error(`unterminated quote: "${text}"`);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"')) throw new Error(`unterminated quote: "${text}"`);
    return text.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n');
  }
  // Bare scalar: strip a trailing comment, then type it.
  const bare = text.replace(/\s+#.*$/, '').trim();
  if (bare === 'true') return true;
  if (bare === 'false') return false;
  if (bare === 'null' || bare === '~') return '';
  // Only take the number when the number round-trips to the same text. `0012`
  // and `+5` are strings a person typed, and turning them into `12` and `5`
  // would rewrite their note on the next merge.
  if (/^-?\d+$/.test(bare)) return numberIfExact(bare, Number.parseInt(bare, 10));
  if (/^-?\d+\.\d+$/.test(bare)) return numberIfExact(bare, Number.parseFloat(bare));
  return bare;
}

function numberIfExact(text, value) {
  return Number.isFinite(value) && String(value) === text ? value : text;
}

/**
 * Render `fields` as a frontmatter block, delimiters included.
 *
 * Known fields come first in `FIELD_SPEC` order so goldens stay diffable. Keys
 * the hook does not know about — anything Stack added by hand — are kept and
 * appended, because the hook's job is to merge, not to normalise someone's note.
 */
export function serializeFrontmatter(fields) {
  const lines = ['---'];
  const emitted = new Set();

  for (const [key, kind] of FIELD_SPEC) {
    if (!(key in fields)) continue;
    emitted.add(key);
    lines.push(...emitField(key, fields[key], kind));
  }
  for (const key of Object.keys(fields)) {
    if (emitted.has(key) || UNSAFE_KEYS.has(key)) continue;
    lines.push(...emitField(key, fields[key], inferKind(fields[key])));
  }

  lines.push('---');
  return lines.join('\n');
}

function inferKind(value) {
  if (Array.isArray(value)) return value.every((v) => typeof v === 'number') && value.length ? NUMBER_LIST : LIST;
  if (value && typeof value === 'object') return MAP;
  if (typeof value === 'number' || typeof value === 'boolean') return PLAIN;
  return QUOTED;
}

function emitField(key, value, kind) {
  switch (kind) {
    case PLAIN:
      return [`${key}: ${value === '' ? "''" : String(value)}`];
    case LIST:
    case NUMBER_LIST: {
      const items = Array.isArray(value) ? value : [];
      if (items.length === 0) return [`${key}: []`];
      const render = kind === NUMBER_LIST ? (v) => String(v) : (v) => yamlStr(v);
      return [`${key}:`, ...items.map((item) => `  - ${render(item)}`)];
    }
    case MAP: {
      const source = value && typeof value === 'object' ? Object.entries(value) : [];
      // Keys the parser would refuse are dropped rather than escaped: a tool
      // name outside this shape is not a tool name. Counts are coerced so the
      // value side cannot carry text either.
      const entries = source.filter(([name]) => EMITTABLE_KEY.test(name) && !UNSAFE_KEYS.has(name));
      // Emitted even when empty, so "no tools" and "field missing" stay
      // distinguishable for a metadata filter.
      if (entries.length === 0) return [`${key}: {}`];
      return [`${key}:`, ...entries.map(([name, count]) => `  ${name}: ${Number(count) || 0}`)];
    }
    case QUOTED:
    default:
      return [`${key}: ${yamlStr(value)}`];
  }
}
