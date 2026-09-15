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
  ['generator', QUOTED],
  ['tools_used', MAP],
]);

const SPEC_BY_KEY = new Map(FIELD_SPEC);

/** Field names in emit order. Handy for tests and for the migration. */
export const FIELD_ORDER = Object.freeze(FIELD_SPEC.map(([name]) => name));

const DELIMITER = /^---\s*$/;

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
    const inline = rest.trim();

    if (inline !== '') {
      fields[key] = parseScalarOrFlow(inline);
      continue;
    }

    // Block form: consume the indented lines that follow.
    const child = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
      if (lines[i + 1].trim() !== '') child.push(lines[i + 1]);
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
    map[match[1].trim()] = parseScalar(match[2].trim());
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
  if (/^-?\d+$/.test(bare)) return Number.parseInt(bare, 10);
  if (/^-?\d+\.\d+$/.test(bare)) return Number.parseFloat(bare);
  return bare;
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
    if (emitted.has(key)) continue;
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
      const entries = value && typeof value === 'object' ? Object.entries(value) : [];
      if (entries.length === 0) return [];
      return [`${key}:`, ...entries.map(([name, count]) => `  ${name}: ${count}`)];
    }
    case QUOTED:
    default:
      return [`${key}: ${yamlStr(value)}`];
  }
}
