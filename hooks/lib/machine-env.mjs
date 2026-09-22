/**
 * `~/.harness/machine.env`: what this machine is.
 *
 * The vault root, the realms it may hold, its name in `machine:` — everything
 * that differs from one machine to the next and used to be a hard-coded
 * default. KEY=value, because both tiers already read that without a
 * dependency (the Python side is `ingest/src/ingest/envfile.py`, and this is a
 * deliberate mirror of its rules): the process environment always wins, a
 * malformed line is reported by number, values are never logged.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MACHINE_NAME_PATTERN, MACHINE_NAME_VAR } from './constants.mjs';

/** Overrides the file's location — the tests use it; a VM may too. */
export const MACHINE_ENV_VAR = 'HARNESS_MACHINE_ENV';
export const MACHINE_ENV_SEGMENTS = Object.freeze(['.harness', 'machine.env']);

const KEY = /^[A-Z_][A-Z0-9_]*$/;

/** Parse KEY=value lines: `export` prefixes, single or double quotes, `#` comments. */
export function parseEnvText(text) {
  const values = {};
  const lines = String(text ?? '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const pair = line.startsWith('export ') ? line.slice(7).trim() : line;
    const at = pair.indexOf('=');
    const key = at === -1 ? '' : pair.slice(0, at).trim();
    if (!KEY.test(key)) throw new Error(`machine.env line ${index + 1}: expected KEY=value`);
    values[key] = unquote(pair.slice(at + 1).trim());
  }
  return values;
}

function unquote(value) {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) return value.slice(1, -1);
  return value;
}

/** This machine's name for `machine:`, or '' when unset or not a name. */
export function machineName(env = process.env) {
  const value = String(env?.[MACHINE_NAME_VAR] ?? '').trim();
  return MACHINE_NAME_PATTERN.test(value) ? value : '';
}

/**
 * The environment with the repo's `.env` filled in underneath it.
 *
 * For the installer and the doctor only: the hook never loads secrets, and the
 * detached ingest reads the same file itself. Same rules as the machine file.
 */
export function loadRepoEnv(env = process.env, repoRoot, report = () => {}) {
  const file = path.join(repoRoot, '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') report(`.env unreadable (${err?.code || err?.message}): ${file}`);
    return { ...env };
  }
  try {
    return { ...parseEnvText(text), ...env };
  } catch (err) {
    report(`${err.message} (${file})`);
    return { ...env };
  }
}

/**
 * The environment with the machine file's values filled in underneath it.
 *
 * Returns a new object; `env` is not touched. A missing file is the ordinary
 * case on a machine that has not been set up, so it is not an error. A file
 * that will not parse is reported through `report` and ignored: a hook must
 * still write its note.
 */
export function loadMachineEnv(env = process.env, home = os.homedir(), report = () => {}) {
  const file = env[MACHINE_ENV_VAR] || path.join(home, ...MACHINE_ENV_SEGMENTS);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') report(`machine.env unreadable (${err?.code || err?.message}): ${file}`);
    return { ...env };
  }
  let values;
  try {
    values = parseEnvText(text);
  } catch (err) {
    report(`${err.message} (${file})`);
    return { ...env };
  }
  return { ...values, ...env };
}
