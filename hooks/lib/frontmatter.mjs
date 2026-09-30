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
 * and, for the retrieval record field only (`RECORDS` in `FIELD_SPEC`), a block
 * list of one-level mappings whose values may be flow maps and flow lists:
 *
 *   retrievals:
 *     - at: '2026-09-24T14:03:11Z'
 *       filters: {collection: agentic-harness, tags: [ingest, db]}
 *       results: ['obsidian:session-1a2b@0.8123']
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
/** A block list of one-level mappings: the SC-1 retrieval record. */
const RECORDS = 'records';

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
  // Retrieval provenance (SC-1, R-P2): what the session searched for, and the
  // vault notes it got back. Appended, same reason.
  ['retrievals', RECORDS],
  ['retrieved', LIST],
  // The tags the hook raised on its latest render (H-3, R-102): the only tags a
  // merge may replace; anything else in `tags` is a hand tag. Appended, same reason.
  ['hook_tags', LIST],
]);

/** Field names in emit order. Handy for tests and for the migration. */
export const FIELD_ORDER = Object.freeze(FIELD_SPEC.map(([name]) => name));

const KIND_BY_KEY = new Map(FIELD_SPEC);

/** SC-1 record keys, in emit order. Any other key in a record follows them, in its own order. */
const RECORD_KEY_ORDER = Object.freeze(['at', 'channel', 'tool', 'query', 'filters', 'results', 'chunks']);

/** Record keys whose strings are always quoted: a timestamp, free text, and ids. */
const QUOTED_RECORD_KEYS = new Set(['at', 'query', 'results', 'chunks']);

/**
 * A string that reads back as itself when written bare inside a flow
 * collection: no spaces, quotes, commas, colons or brackets, and not a word the
 * parser turns into a boolean or an empty value.
 */
const BARE_WORD = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
// YAML 1.1 (PyYAML, which ingest reads notes with) also turns these into booleans or null, in any case.
const NON_STRING_WORDS = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off']);

const FLOW_CLOSER = new Map([
  ['[', ']'],
  ['{', '}'],
]);
const FLOW_CLOSERS = new Set(FLOW_CLOSER.values());

/** What may precede a quote or an opening bracket for it to be syntax rather than text. */
const TOKEN_BOUNDARY = new Set(['', ',', '[', '{', ':']);

/** `key: value` or `key:`, as a record entry or a flow-map entry. */
const ENTRY = /^([^\s:]+):(?:\s+([\s\S]*))?$/;

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
    const records = KIND_BY_KEY.get(key) === RECORDS;

    if (inline !== '') {
      // `[]` is how an empty record list is written. Anything else inline is
      // not a record list, and guessing at one would rewrite it as something else.
      if (records && inline !== '[]') throw new Error(`${key} must be a block list of records`);
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
    if (child.length === 0) fields[key] = '';
    else fields[key] = records ? parseRecords(child) : parseChildBlock(child);
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

/**
 * A top-level inline value. A flow list's items are scalars; an item that is
 * itself bracketed stays the string it always was here. Only `{}` is a map: a
 * hand-typed `{owner: stack}` under an unknown key stays a string, because the
 * MAP emitter writes counts and would turn its values into zeros.
 */
function parseScalarOrFlow(text) {
  if (text.startsWith('[')) return parseFlowList(text, parseScalar);
  if (text === '{}') return {};
  return parseScalar(text);
}

/** `[a, 'b', 3]`, each item read by `readItem`. */
function parseFlowList(text, readItem) {
  if (!text.endsWith(']')) throw new Error(`unterminated flow sequence: "${text}"`);
  const inner = text.slice(1, -1).trim();
  if (inner === '') return [];
  return splitFlow(inner).map((item) => readItem(item.trim()));
}

/** `{key: scalar, key: [scalar, ...]}`: one level, as a retrieval record's `filters`. */
function parseFlowMap(text) {
  if (!text.endsWith('}')) throw new Error(`unterminated flow map: "${text}"`);
  const inner = text.slice(1, -1).trim();
  if (inner === '') return {};
  const entries = splitFlow(inner).map((part) => {
    const [key, value] = splitEntry(part.trim());
    return [key, value.startsWith('[') ? parseFlowList(value, parseFlowScalar) : parseFlowScalar(value)];
  });
  return fromUniqueEntries(entries);
}

/** A scalar inside a record's flow value. A collection here is one level too deep. */
function parseFlowScalar(text) {
  if (text.startsWith('[') || text.startsWith('{')) throw new Error(`nested flow collection: "${text}"`);
  return parseScalar(text);
}

/**
 * Split `a, 'b, c', [d, e], {f: g}` on the commas that separate items.
 *
 * A quote or an opening bracket is syntax only where a token starts (after
 * `,`, `:` or another opening bracket), so the apostrophe in `don't` stays
 * text. Brackets must balance and quotes must close; either failing throws,
 * and the caller refuses to write the note.
 */
function splitFlow(inner) {
  const parts = [];
  const open = [];
  let current = '';
  let quote = '';
  let last = '';
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (quote) {
      current += char;
      if (quote === '"' && char === '\\' && i + 1 < inner.length) {
        current += inner[i + 1];
        i += 1;
      } else if (char === "'" && quote === "'" && inner[i + 1] === "'") {
        current += "'";
        i += 1;
      } else if (char === quote) {
        quote = '';
        last = char;
      }
      continue;
    }
    if ((char === "'" || char === '"') && TOKEN_BOUNDARY.has(last)) {
      quote = char;
    } else if (FLOW_CLOSER.has(char) && TOKEN_BOUNDARY.has(last)) {
      open.push(FLOW_CLOSER.get(char));
    } else if (FLOW_CLOSERS.has(char)) {
      if (open.pop() !== char) throw new Error(`unbalanced "${char}" in flow collection: "${inner}"`);
    } else if (char === ',' && open.length === 0) {
      parts.push(current);
      current = '';
      last = char;
      continue;
    }
    current += char;
    if (!/\s/.test(char)) last = char;
  }
  if (quote) throw new Error(`unterminated quote in flow collection: "${inner}"`);
  if (open.length > 0) throw new Error(`unterminated flow collection: "${inner}"`);
  parts.push(current);
  return parts;
}

/**
 * The retrieval records. `- key: value` starts one; `key: value` indented past
 * the dash continues it. Every line is one of those two, or the block is refused.
 */
function parseRecords(child) {
  const itemIndent = indentOf(child[0]);
  const groups = [];
  for (const line of child) {
    const indent = indentOf(line);
    const text = line.trim();
    if (/^-(\s|$)/.test(text)) {
      if (indent !== itemIndent) throw new Error(`nested block in a record: "${text}"`);
      groups.push([text.replace(/^-\s*/, '')]);
      continue;
    }
    if (groups.length === 0 || indent <= itemIndent) throw new Error(`not a record entry: "${text}"`);
    groups.at(-1).push(text);
  }
  return groups.map((entries) =>
    fromUniqueEntries(
      entries.map((entry) => {
        const [key, value] = splitEntry(entry);
        return [key, parseRecordValue(value)];
      }),
    ),
  );
}

function parseRecordValue(text) {
  if (text.startsWith('{')) return parseFlowMap(text);
  if (text.startsWith('[')) return parseFlowList(text, parseFlowScalar);
  return parseScalar(text);
}

/** `[key, rawValue]` from `key: value`. The key must be one the serializer could emit. */
function splitEntry(text) {
  const match = text.match(ENTRY);
  if (!match) throw new Error(`not a key: "${text}"`);
  const key = match[1];
  if (UNSAFE_KEYS.has(key)) throw new Error(`reserved key in frontmatter: "${key}"`);
  if (!EMITTABLE_KEY.test(key)) throw new Error(`not a key: "${text}"`);
  return [key, (match[2] ?? '').trim()];
}

/** An object from entries, refusing a repeated key rather than letting the last one win. */
function fromUniqueEntries(entries) {
  const keys = new Set();
  for (const [key] of entries) {
    if (keys.has(key)) throw new Error(`duplicate key: "${key}"`);
    keys.add(key);
  }
  return Object.fromEntries(entries);
}

function indentOf(line) {
  return line.length - line.trimStart().length;
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
    case RECORDS: {
      const records = (Array.isArray(value) ? value : []).map(emitRecord).filter((lines) => lines.length > 0);
      // Emitted even when empty, like a list: "searched nothing" is a fact.
      if (records.length === 0) return [`${key}: []`];
      return [`${key}:`, ...records.flat()];
    }
    case QUOTED:
    default:
      return [`${key}: ${yamlStr(value)}`];
  }
}

/**
 * What `record` reads back as once written: newlines folded, unemittable keys
 * dropped. `null` for anything that is not a record or has nothing left to
 * write. The merge compares records in this form, so a record read from disk
 * and the same record derived again are the same record.
 */
export function normalizeRecord(record) {
  const lines = emitRecord(record);
  return lines.length === 0 ? null : parseRecords(lines)[0];
}

/** One record as `  - key: value` then `    key: value` lines; `[]` when there is nothing to write. */
function emitRecord(record) {
  if (!isPlainObject(record)) return [];
  const known = RECORD_KEY_ORDER.filter((name) => Object.hasOwn(record, name));
  const others = Object.keys(record).filter((name) => !RECORD_KEY_ORDER.includes(name) && isEmittableKey(name));
  return [...known, ...others].map(
    (name, index) => `${index === 0 ? '  - ' : '    '}${name}: ${emitRecordValue(name, record[name])}`,
  );
}

function emitRecordValue(name, value) {
  const quoted = QUOTED_RECORD_KEYS.has(name);
  if (Array.isArray(value)) return emitFlowList(value, quoted);
  if (isPlainObject(value)) return emitFlowMap(value);
  return emitFlowScalar(value, quoted);
}

/** Keys the parser would refuse are dropped, as in the MAP kind. */
function emitFlowMap(map) {
  const entries = Object.entries(map).filter(([name]) => isEmittableKey(name));
  const rendered = entries.map(
    ([name, value]) => `${name}: ${Array.isArray(value) ? emitFlowList(value, false) : emitFlowScalar(value, false)}`,
  );
  return `{${rendered.join(', ')}}`;
}

function emitFlowList(items, quoted) {
  return `[${items.map((item) => emitFlowScalar(item, quoted)).join(', ')}]`;
}

/**
 * A scalar inside a record. Anything deeper than the record shape allows is
 * written as its JSON text, quoted: kept, and unable to change the structure.
 */
function emitFlowScalar(value, quoted) {
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value === null || value === undefined) return "''";
  if (typeof value !== 'string') return yamlStr(JSON.stringify(value));
  const bare = !quoted && BARE_WORD.test(value) && !NON_STRING_WORDS.has(value.toLowerCase());
  return bare ? value : yamlStr(value);
}

function isEmittableKey(name) {
  return EMITTABLE_KEY.test(name) && !UNSAFE_KEYS.has(name);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
