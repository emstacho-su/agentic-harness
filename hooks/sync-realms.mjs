#!/usr/bin/env node
/**
 * Sync this machine's realms with their remotes.
 *
 *   node hooks/sync-realms.mjs --pull [--dry-run]     # before the night's work
 *   node hooks/sync-realms.mjs --push [--dry-run]     # after it
 *
 * Reads HARNESS_VAULT and HARNESS_REALMS (from the environment or
 * ~/.harness/machine.env). Exit 0 when every realm is in order, 2 when one
 * needs a person (a conflict, a failed push), 1 on a usage error. Nothing is
 * ever forced; see lib/realm-sync.mjs.
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_VAULT_SEGMENTS, VAULT_ENV_VAR } from './lib/constants.mjs';
import { loadMachineEnv, machineName } from './lib/machine-env.mjs';
import { parseRealmPolicies, pullRealms, pushRealms } from './lib/realm-sync.mjs';

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_ATTENTION = 2;

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

export function run(argv, { env = process.env, out = console.log, err = console.error } = {}) {
  env = loadMachineEnv(env, os.homedir(), err);
  const parsed = parseArgs(argv, env);
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

  const results =
    options.mode === 'pull'
      ? pullRealms({ vaultRoot: options.vaultRoot, policies, dryRun: options.dryRun })
      : pushRealms({ vaultRoot: options.vaultRoot, policies, machine: machineName(env), dryRun: options.dryRun });

  let attention = 0;
  for (const result of results) {
    out(`${result.name}: ${result.action}${result.error ? ` (${result.error})` : ''}`);
    if (result.action === 'conflict' || result.action === 'error') attention += 1;
  }
  return attention ? EXIT_ATTENTION : EXIT_OK;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(run(process.argv.slice(2)));
}
