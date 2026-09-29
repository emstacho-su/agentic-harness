/**
 * Per-machine redaction rules (R-106; harness R-E3).
 *
 * `HARNESS_REDACT_EXTRA` (shell or machine file) names a JSON file:
 *
 *   { "rules": [{ "name": "<id>", "pattern": "<regex>", "flags": "i", "to": "[REDACTED:<id>]" }] }
 *
 * `loadExtraRules` validates and compiles it; `installExtraRulesFrom` also
 * installs the result into `redact.mjs`, whose `redact()` applies it after the
 * built-in rules. The entry points that write notes call it once at start:
 * `session-capture.mjs`, `sweep-transcripts.mjs`, `collect-checkpoints.mjs`.
 * `/checkpoint` never does (a cloud session has no machine file).
 *
 * Nothing here throws. A missing file, malformed JSON or a bad rule is reported
 * once through `report` and skipped, because a hook must still write its note
 * with the built-in rules. A report never quotes the file or a pattern: a
 * machine's own rules may spell out exactly what it wants kept secret, and a
 * RegExp or JSON error message would echo it into a log.
 *
 * The replacement is literal: `to` is written as given, `$1` and `$&` included.
 */

import fs from 'node:fs';
import path from 'node:path';

import { installExtraRules } from './redact.mjs';

export const EXTRA_RULES_ENV_VAR = 'HARNESS_REDACT_EXTRA';

/** A file larger than this is refused unread: it is a rules list, not data. */
export const MAX_EXTRA_FILE_BYTES = 256 * 1024;
/** Rules past this are dropped: every rule runs on every string of every note. */
export const MAX_EXTRA_RULES = 100;
export const MAX_EXTRA_PATTERN_CHARS = 1000;
export const MAX_EXTRA_MARKER_CHARS = 200;
/** `g` is always added; `y` would anchor the rule and `d` is meaningless here. */
export const ALLOWED_EXTRA_FLAGS = 'imsu';

const RULE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const PREFIX = 'redact-extra: ';

/**
 * Load, validate and compile the extra rules the environment names.
 *
 * @param {Record<string, string|undefined>} env  the merged environment (shell over machine file)
 * @param {(line: string) => void} [report]  called once per problem
 * @returns {readonly {name: string, re: RegExp, to: () => string}[]}  frozen; empty when unset or unusable
 */
export function loadExtraRules(env = process.env, report = () => {}) {
  const file = String(env?.[EXTRA_RULES_ENV_VAR] ?? '').trim();
  if (!file) return Object.freeze([]);
  const say = (line) => report(`${PREFIX}${line}`);

  if (!path.isAbsolute(file)) {
    say(`${EXTRA_RULES_ENV_VAR} must be an absolute path; ignoring ${JSON.stringify(file.slice(0, 200))}`);
    return Object.freeze([]);
  }
  const text = readRulesFile(file, say);
  if (text === null) return Object.freeze([]);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    say(`not valid JSON; no extra rules loaded (${file})`);
    return Object.freeze([]);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.rules)) {
    say(`expected an object with a "rules" array; no extra rules loaded (${file})`);
    return Object.freeze([]);
  }

  let entries = parsed.rules;
  if (entries.length > MAX_EXTRA_RULES) {
    say(`${entries.length} rules; only the first ${MAX_EXTRA_RULES} are loaded (${file})`);
    entries = entries.slice(0, MAX_EXTRA_RULES);
  }

  const seen = new Set();
  const compiled = [];
  entries.forEach((entry, index) => {
    const result = compileRule(entry, seen);
    if (result.ok) {
      seen.add(result.rule.name);
      compiled.push(result.rule);
    } else {
      say(`rule ${index + 1}${result.name ? ` (${result.name})` : ''} skipped: ${result.problem}`);
    }
  });
  return Object.freeze(compiled);
}

/** Load the environment's extra rules and install them. Returns how many are installed. */
export function installExtraRulesFrom(env = process.env, report = () => {}) {
  return installExtraRules(loadExtraRules(env, report));
}

function readRulesFile(file, say) {
  try {
    const size = fs.statSync(file).size;
    if (size > MAX_EXTRA_FILE_BYTES) {
      say(`file is ${size} bytes, over the ${MAX_EXTRA_FILE_BYTES}-byte limit; no extra rules loaded (${file})`);
      return null;
    }
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    const reason = err?.code === 'ENOENT' ? 'not found' : `unreadable (${err?.code || 'error'})`;
    say(`${reason}; no extra rules loaded (${file})`);
    return null;
  }
}

/**
 * One rule, or why not. `name` is returned with a failure only when it is a
 * valid name, so a report can cite it without echoing arbitrary text.
 */
function compileRule(entry, seen) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail('', 'not an object');
  const name = typeof entry.name === 'string' && RULE_NAME.test(entry.name) ? entry.name : '';
  if (!name) return fail('', 'name must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit');
  if (seen.has(name)) return fail(name, 'duplicate name');

  const { pattern } = entry;
  if (typeof pattern !== 'string' || pattern === '') return fail(name, 'pattern must be a non-empty string');
  if (pattern.length > MAX_EXTRA_PATTERN_CHARS) return fail(name, `pattern is over ${MAX_EXTRA_PATTERN_CHARS} characters`);

  const flags = entry.flags ?? '';
  if (typeof flags !== 'string' || !validFlags(flags)) {
    return fail(name, `flags must be distinct letters from "${ALLOWED_EXTRA_FLAGS}"`);
  }

  const marker = entry.to ?? `[REDACTED:${name}]`;
  if (typeof marker !== 'string' || marker.length > MAX_EXTRA_MARKER_CHARS) {
    return fail(name, `to must be a string of at most ${MAX_EXTRA_MARKER_CHARS} characters`);
  }

  let re;
  try {
    re = new RegExp(pattern, `${flags}g`);
  } catch {
    return fail(name, 'pattern is not a valid regular expression');
  }
  // A rule that matches nothing at all would write its marker between every
  // character of every note.
  if (new RegExp(pattern, flags).test('')) return fail(name, 'pattern matches the empty string');

  return { ok: true, rule: Object.freeze({ name, re, to: () => marker }) };
}

function validFlags(flags) {
  return [...flags].every((flag, i) => ALLOWED_EXTRA_FLAGS.includes(flag) && flags.indexOf(flag) === i);
}

function fail(name, problem) {
  return { ok: false, name, problem };
}
