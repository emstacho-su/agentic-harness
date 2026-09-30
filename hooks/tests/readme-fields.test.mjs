/**
 * R-104: `hooks/README.md`'s field table names every frontmatter field, once.
 *
 * The README tells a reader what every note carries. When a field is appended
 * to `FIELD_SPEC` (as `machine`, `retrievals`, `retrieved` and `hook_tags`
 * were) and the table is not updated, the doc says something the code no longer
 * does. This test ties the two: the fields the table names, read from the
 * `| Group | Fields |` table, equal `FIELD_ORDER` as a set, with no field named
 * twice and nothing named that is not a field.
 *
 * Text in parentheses inside a Fields cell is commentary (the values `origin`
 * can take, say) and is not read as a field name.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FIELD_ORDER } from '../lib/frontmatter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const README_PATH = path.join(HERE, '..', 'README.md');
const TABLE_HEADER = /^\|\s*Group\s*\|\s*Fields\s*\|\s*$/;
const TABLE_ROW = /^\|(.*)\|(.*)\|\s*$/;
const DELIMITER_ROW = /^\|\s*-+\s*\|\s*-+\s*\|\s*$/;

/** Removes parenthesised commentary, nested parentheses included. */
function stripParentheses(text) {
  let depth = 0;
  let out = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

/** Returns `[{ group, fields }]` for the first `| Group | Fields |` table in the text. */
function readFieldTable(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => TABLE_HEADER.test(line));
  if (start === -1) throw new Error(`no "| Group | Fields |" table in ${README_PATH}`);
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (DELIMITER_ROW.test(line)) continue;
    const match = TABLE_ROW.exec(line);
    if (!match) break;
    const group = match[1].trim();
    const fields = [...stripParentheses(match[2]).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    rows.push({ group, fields });
  }
  return rows;
}

const rows = readFieldTable(fs.readFileSync(README_PATH, 'utf8'));
const named = rows.flatMap((row) => row.fields);

test('the field table has rows and every row names at least one field', () => {
  assert.ok(rows.length > 0, 'the table has no rows');
  for (const row of rows) assert.ok(row.fields.length > 0, `row "${row.group}" names no field`);
});

test('every FIELD_ORDER field is in the table, machine and hook_tags included', () => {
  const missing = FIELD_ORDER.filter((field) => !named.includes(field));
  assert.deepEqual(missing, [], `missing from hooks/README.md: ${missing.join(', ')}`);
  assert.ok(named.includes('machine'));
  assert.ok(named.includes('hook_tags'));
});

test('the table names nothing that is not a field', () => {
  const unknown = named.filter((field) => !FIELD_ORDER.includes(field));
  assert.deepEqual(unknown, [], `not in FIELD_ORDER: ${unknown.join(', ')}`);
});

test('no field is named twice', () => {
  const twice = named.filter((field, i) => named.indexOf(field) !== i);
  assert.deepEqual(twice, [], `named more than once: ${twice.join(', ')}`);
});
