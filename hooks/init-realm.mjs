#!/usr/bin/env node
/**
 * Make a realm's one baseline commit (R-C2).
 *
 *   node hooks/init-realm.mjs --vault <dir> --realm <name> [--remote <url>] [--source <label>] [--dry-run]
 *
 * In `<vault>/<name>`: write `.realm`, `.gitattributes` and `.gitignore`,
 * `git init -b main` unless `.git` is already there, stage the sync paths
 * after the same guard the nightly sync runs, renormalise, and commit as
 * HARNESS_MACHINE <HARNESS_GIT_EMAIL>. `--remote` adds origin; nothing is ever
 * pushed or fetched. A realm that already has a commit is left alone. See
 * lib/realm-baseline.mjs for the rules.
 *
 * Reads HARNESS_VAULT (when --vault is not given), HARNESS_MACHINE and
 * HARNESS_GIT_EMAIL from the environment or ~/.harness/machine.env. Prints one
 * line per policy file, then `init:`, `staged:`, `not staged:`, `reported:`,
 * `commit:` (or `would-commit:`) and `remote:` as they apply, and on a stop one
 * line with the reason. Exit 0 when the baseline is made (or would be), 2 when
 * it is refused, fails, or was already made, 1 on a usage error.
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VAULT_ENV_VAR } from './lib/constants.mjs';
import { gitEmail, loadMachineEnv, machineName } from './lib/machine-env.mjs';
import { BASELINE_BRANCH, baselineRealm, checkRemoteUrl, checkSourceLabel, DEFAULT_SOURCE_LABEL, PATHS_NAMED } from './lib/realm-baseline.mjs';
import { REALM_NAME } from './lib/realm-sync.mjs';

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_ATTENTION = 2;

const USAGE = 'usage: node hooks/init-realm.mjs --vault <dir> --realm <name> [--remote <url>] [--source <label>] [--dry-run]';

/** The flags that take a value, and the option each one sets. */
const VALUE_FLAGS = Object.freeze({ '--vault': 'vaultRoot', '--realm': 'name', '--remote': 'remote', '--source': 'sourceLabel' });

const INIT_WORDS = Object.freeze({ initialised: `git init -b ${BASELINE_BRANCH}`, existing: 'already a checkout', 'would-init': 'would-init' });

const usage = (error) => ({ ok: false, error });

function validate(options) {
  if (!options.vaultRoot) return usage(`pass --vault (or set ${VAULT_ENV_VAR})`);
  if (!options.name) return usage('pass --realm');
  if (!REALM_NAME.test(options.name)) return usage(`'${options.name}' is not a realm name (${REALM_NAME})`);
  const bad = checkSourceLabel(options.sourceLabel) || (options.remote ? checkRemoteUrl(options.remote) : '');
  return bad ? usage(bad) : { ok: true, options: Object.freeze(options) };
}

export function parseArgs(argv, env = process.env) {
  let options = { vaultRoot: env[VAULT_ENV_VAR] || '', name: '', remote: '', sourceLabel: DEFAULT_SOURCE_LABEL, dryRun: false };
  const given = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options = { ...options, dryRun: true };
      continue;
    }
    if (!Object.hasOwn(VALUE_FLAGS, arg)) return usage(`unknown argument: ${arg}`);
    if (given.has(arg)) return usage(`${arg} given twice`);
    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) return usage(`${arg} needs a value`);
    given.add(arg);
    options = { ...options, [VALUE_FLAGS[arg]]: value };
    index += 1;
  }
  return validate(options);
}

/** `a, b, c` or `a, b, c, …N more`, naming the first `shown` of `total`. */
function listed(shown, total, separator) {
  const more = total - shown.length;
  return more > 0 ? `${shown.join(separator)}${separator}…${more} more` : shown.join(separator);
}

function stopLine({ outcome, error }) {
  if (outcome === 'ok') return '';
  return outcome === 'already' ? error : `${outcome}: ${error}`;
}

/** The report, one line per fact, in the order the steps ran. */
export function formatBaseline(result) {
  const { staged, notStaged, remote } = result;
  return Object.freeze(
    [
      ...result.files.map(({ relPath, action }) => `${relPath}: ${action}`),
      result.init ? `init: ${INIT_WORDS[result.init]}` : '',
      staged.count > 0 ? `staged: ${staged.count} paths (${listed(staged.sample, staged.count, ', ')})` : '',
      notStaged.length > 0 ? `not staged: ${listed(notStaged.slice(0, PATHS_NAMED), notStaged.length, '; ')}` : '',
      ...result.notes,
      result.commit ? (result.dryRun ? result.commit : `commit: ${result.commit}`) : '',
      remote ? `remote: origin ${remote.url} ${remote.action}` : '',
      stopLine(result),
    ].filter(Boolean),
  );
}

export function run(argv, { env = process.env, out = console.log, err = console.error, runGit, stat, clock, pid } = {}) {
  const merged = loadMachineEnv(env, os.homedir(), err);
  const parsed = parseArgs(argv, merged);
  if (!parsed.ok) {
    err(`error: ${parsed.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const result = baselineRealm({
    ...parsed.options,
    machine: machineName(merged),
    email: gitEmail(merged),
    baseEnv: env,
    runGit,
    stat,
    clock,
    pid,
  });
  for (const line of formatBaseline(result)) out(line);
  return result.outcome === 'ok' ? EXIT_OK : EXIT_ATTENTION;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(run(process.argv.slice(2)));
}
