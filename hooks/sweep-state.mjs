#!/usr/bin/env node
/**
 * sweep-state.mjs — remove session-start records older than a week (SC-2).
 *
 *   node hooks/sweep-state.mjs [--state-dir <dir>] [--max-age-days 7] [--dry-run]
 *
 * The SessionStart hook writes one `<session_id>.json` per session under
 * `~/.harness/state/session-start/`; capture reads it and deletes nothing.
 * The nightly job runs this right after the transcript sweep. What it may
 * remove is narrow on purpose: see lib/state-sweep.mjs.
 *
 * Exit codes: 0 clean (a missing folder included), 1 if a file could not be
 * judged or removed, 2 bad usage.
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMachineEnv } from './lib/machine-env.mjs';
import { STATE_DIR_ENV_VAR, defaultStateDir } from './lib/session-start.mjs';
import { DEFAULT_STATE_MAX_AGE_DAYS, sweepState } from './lib/state-sweep.mjs';

export const EXIT_OK = 0;
export const EXIT_ERRORS = 1;
export const EXIT_USAGE = 2;

const USAGE = `usage: node sweep-state.mjs [options]
  --state-dir <dir>      folder to sweep (default: $${STATE_DIR_ENV_VAR}/session-start
                         or ~/.harness/state/session-start)
  --max-age-days <n>     remove *.json files older than n whole days (default ${DEFAULT_STATE_MAX_AGE_DAYS})
  --dry-run              say what would go, remove nothing
  --help`;

/**
 * Parse argv. Returns `{ ok: true, options }` or `{ ok: false, error }`; it
 * never exits, so the CLI wrapper below owns every exit code.
 */
export function parseArgs(argv, env = process.env, home = os.homedir()) {
  const options = {
    stateDir: defaultStateDir(env, home),
    maxAgeDays: DEFAULT_STATE_MAX_AGE_DAYS,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length || argv[i].startsWith('--')) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    try {
      switch (arg) {
        case '--state-dir': options.stateDir = next(); break;
        case '--max-age-days': options.maxAgeDays = positiveInteger(arg, next()); break;
        case '--dry-run': options.dryRun = true; break;
        case '--help': case '-h': options.help = true; break;
        default: throw new Error(`unknown option ${arg}`);
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return { ok: true, options };
}

function positiveInteger(flag, raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${flag} must be a whole number >= 1, got ${raw}`);
  return value;
}

/** The CLI body. Returns the exit code; `main` below is the only caller that exits. */
export function run(argv, { env = process.env, out = console.log, err = console.error, now = Date.now() } = {}) {
  env = loadMachineEnv(env, os.homedir(), err);
  const parsed = parseArgs(argv, env);
  if (!parsed.ok) {
    err(`error: ${parsed.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const { stateDir, maxAgeDays, dryRun, help } = parsed.options;
  if (help) {
    out(USAGE);
    return EXIT_OK;
  }

  let result;
  try {
    result = sweepState({ stateDir, maxAgeDays, now, dryRun });
  } catch (error) {
    err(`error: cannot sweep ${stateDir}: ${error.code || error.message}`);
    return EXIT_ERRORS;
  }

  if (result.missing) {
    out(`nothing to sweep: ${stateDir} does not exist`);
    return EXIT_OK;
  }
  for (const failure of result.errors) err(`could not sweep ${failure.name}: ${failure.code}`);

  const label = dryRun ? 'session-start state (dry run): would sweep' : 'session-start state: swept';
  out(`${label} ${result.swept.length}, kept ${result.kept} (older than ${maxAgeDays} days) dir=${stateDir}`);
  return result.errors.length > 0 ? EXIT_ERRORS : EXIT_OK;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(run(process.argv.slice(2)));
}
