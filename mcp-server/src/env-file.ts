/**
 * Secrets stay in the repo's `.env`; the MCP registration names the file.
 *
 * `claude mcp get` prints a server's env block in clear text, so a connection
 * string placed there is a connection string on every screen that shows it.
 * The registration therefore carries `HARNESS_ENV_FILE` (a path) and the
 * server reads the file itself at start, then `~/.harness/machine.env` for the
 * rest. The process environment always wins, so a value exported for one run
 * still overrides both. Same rules as ingest/src/ingest/envfile.py.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const ENV_FILE_VAR = 'HARNESS_ENV_FILE';
export const MACHINE_ENV_VAR = 'HARNESS_MACHINE_ENV';
export const MACHINE_ENV_SEGMENTS = ['.harness', 'machine.env'] as const;

const KEY = /^[A-Z_][A-Z0-9_]*$/;

export type Env = Record<string, string | undefined>;

/** Parse KEY=value lines: `export` prefixes, single or double quotes, `#` comments. */
export function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (!line || line.startsWith('#')) continue;
    const pair = line.startsWith('export ') ? line.slice(7).trim() : line;
    const at = pair.indexOf('=');
    const key = at === -1 ? '' : pair.slice(0, at).trim();
    if (!KEY.test(key)) throw new Error(`line ${index + 1}: expected KEY=value`);
    values[key] = unquote(pair.slice(at + 1).trim());
  }
  return values;
}

function unquote(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

export interface EnvFileOptions {
  /** Where `.env` is looked for when HARNESS_ENV_FILE is unset. */
  repoRoot: string;
  home?: string;
  /** A file that exists but will not parse is reported here and skipped. */
  report?: (message: string) => void;
}

/**
 * `env` with the `.env` file and then the machine file filled in underneath it.
 * Returns a new object; a missing file is the ordinary case and not an error.
 */
export function loadEnvFiles(env: Env, options: EnvFileOptions): Env {
  const home = options.home ?? homedir();
  const report = options.report ?? (() => {});
  const files = [
    env[ENV_FILE_VAR] || path.join(options.repoRoot, '.env'),
    env[MACHINE_ENV_VAR] || path.join(home, ...MACHINE_ENV_SEGMENTS),
  ];
  let merged: Env = { ...env };
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') report(`${file}: unreadable (${code ?? String(err)})`);
      continue;
    }
    try {
      merged = { ...parseEnvText(text), ...merged };
    } catch (err) {
      report(`${file}: ${(err as Error).message}`);
    }
  }
  return merged;
}
