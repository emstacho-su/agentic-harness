#!/usr/bin/env node
/**
 * Sync this machine's realms with their remotes.
 *
 *   node hooks/sync-realms.mjs --pull [--dry-run]     # before the night's work
 *   node hooks/sync-realms.mjs --push [--dry-run]     # after it
 *
 * Per realm, under its lock: commit the sync paths, merge-pull, and (with
 * `--push`, for a `push` realm) push. Never forced, rebased or stashed; a
 * conflicting merge is aborted and reported. Author and committer are
 * HARNESS_MACHINE and HARNESS_GIT_EMAIL; credential prompts are off, so a
 * missing credential fails at once. See lib/realm-sync.mjs for the rules.
 *
 * Reads HARNESS_VAULT, HARNESS_REALMS, HARNESS_MACHINE and HARNESS_GIT_EMAIL
 * (from the environment or ~/.harness/machine.env). Prints one line per realm,
 * `projects: committed -> pulled -> pushed`, then one line per note. Exit 0
 * when every realm is in order, 2 when one needs a person (a conflict, an
 * error, a refused path, a lock someone else holds), 1 on a usage error.
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_VAULT_SEGMENTS, VAULT_ENV_VAR } from './lib/constants.mjs';
import { gitEmail, loadMachineEnv, machineName } from './lib/machine-env.mjs';
import { parseRealmPolicies, syncRealms } from './lib/realm-sync.mjs';

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_ATTENTION = 2;

/** Outcomes that end the run with exit 2: a person has to look. */
const NEEDS_A_PERSON = new Set(['conflict', 'error', 'refused', 'locked']);

/** ASCII on purpose: the PowerShell job decodes node's output in the OEM code page. */
const STEP_SEPARATOR = ' -> ';

const USAGE = `usage: node hooks/sync-realms.mjs (--pull | --push) [--vault <dir>] [--dry-run]`;

export function parseArgs(argv, env = process.env, home = os.homedir()) {
  const options = {
    vaultRoot: env[VAULT_ENV_VAR] || path.join(home, ...DEFAULT_VAULT_SEGMENTS),
    realms: env.HARNESS_REALMS ?? '',
    mode: '',
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pull' || arg === '--push') {
      if (options.mode) return { ok: false, error: 'pass --pull or --push, not both' };
      options.mode = arg.slice(2);
    } else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--vault') {
      const value = argv[index + 1];
      if (!value) return { ok: false, error: '--vault needs a value' };
      options.vaultRoot = value;
      index += 1;
    } else return { ok: false, error: `unknown argument: ${arg}` };
  }
  if (!options.mode) return { ok: false, error: 'pass --pull or --push' };
  return { ok: true, options };
}

/**
 * The realm's line: its steps, then the outcome when it is not `ok` (a dry
 * run that would be refused says `would-refuse`), then the error.
 */
export function formatResult({ name, steps, outcome, error, dryRun }) {
  if (outcome === 'skip') return `${name}: skip (${error})`;
  const shownOutcome = outcome === 'refused' && dryRun ? 'would-refuse' : outcome;
  const words = outcome === 'ok' ? [...steps] : [...steps, shownOutcome];
  return `${name}: ${words.join(STEP_SEPARATOR)}${error ? ` (${error})` : ''}`;
}

export function run(argv, { env = process.env, out = console.log, err = console.error, runGit, stat, clock } = {}) {
  const merged = loadMachineEnv(env, os.homedir(), err);
  const parsed = parseArgs(argv, merged);
  if (!parsed.ok) {
    err(`error: ${parsed.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const { options } = parsed;
  let policies;
  try {
    policies = parseRealmPolicies(options.realms);
  } catch (error) {
    err(`error: ${error.message}`);
    return EXIT_USAGE;
  }
  if (policies.length === 0) {
    out('no realms listed in HARNESS_REALMS; nothing to sync');
    return EXIT_OK;
  }

  const results = syncRealms({
    vaultRoot: options.vaultRoot,
    policies,
    mode: options.mode,
    machine: machineName(merged),
    email: gitEmail(merged),
    dryRun: options.dryRun,
    runGit,
    stat,
    clock,
  });
  for (const result of results) {
    out(formatResult(result));
    for (const note of result.notes) out(`${result.name}: ${note}`);
  }
  return results.some((result) => NEEDS_A_PERSON.has(result.outcome)) ? EXIT_ATTENTION : EXIT_OK;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(run(process.argv.slice(2)));
}
