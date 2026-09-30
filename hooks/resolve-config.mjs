#!/usr/bin/env node
/**
 * resolve-config.mjs — where this machine keeps the vault and the ingest project.
 *
 *   node hooks/resolve-config.mjs [--json] [--require-realm <name>]
 *
 * Prints `{ machineFile, machine, vault, ingestProject, realms, realmCheck }`
 * from `resolveHarnessConfig` (lib/machine-env.mjs): the shell wins, then
 * `$HARNESS_MACHINE_ENV` or `~/.harness/machine.env`. No other key of the
 * machine file is printed, and there is no OneDrive fallback. A skill that
 * writes into the vault (`/inbox-apply`'s Step 0) calls this first (H-4, P-110).
 *
 * Exit codes: 0 when the vault exists and, with `--require-realm`,
 * `<vault>/<name>/.realm` reads `<name>`; 2 otherwise (and on bad usage), with
 * the path it resolved in the message on stderr.
 */

import fs from 'node:fs';
import os from 'node:os';

import { VAULT_ENV_VAR } from './lib/constants.mjs';
import { isEntryPoint } from './lib/entry-point.mjs';
import { resolveHarnessConfig } from './lib/machine-env.mjs';

export const EXIT_OK = 0;
export const EXIT_UNRESOLVED = 2;

const USAGE = 'usage: node resolve-config.mjs [--json] [--require-realm <name>]';

export function parseArgs(argv) {
  const options = { json: false, requireRealm: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--json': options.json = true; break;
      case '--help': case '-h': options.help = true; break;
      case '--require-realm': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) return { ok: false, error: '--require-realm needs a realm name' };
        options.requireRealm = value;
        i += 1;
        break;
      }
      default: return { ok: false, error: `unknown option ${arg}` };
    }
  }
  return { ok: true, options };
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Why the config cannot be used, or '' when it can. */
function refusal(config) {
  if (!config.vault) return `${VAULT_ENV_VAR} is not set in the shell or in ${config.machineFile}`;
  if (!isDirectory(config.vault)) return `vault ${config.vault} does not exist (from ${config.machineFile} or the shell)`;
  if (config.realmCheck && !config.realmCheck.ok) return `realm ${config.realmCheck.realm}: ${config.realmCheck.problem}`;
  return '';
}

function asLines(config) {
  const check = config.realmCheck;
  return [
    `machineFile=${config.machineFile}`,
    `machine=${config.machine}`,
    `vault=${config.vault}`,
    `ingestProject=${config.ingestProject}`,
    `realms=${config.realms.map((realm) => `${realm.name}:${realm.policy}`).join(',')}`,
    `realmCheck=${check ? `${check.realm} ${check.ok ? 'ok' : 'FAILED'}` : ''}`,
  ];
}

/** The CLI body. Returns the exit code; only the entry-point block exits. */
export function run(argv, { env = process.env, home = os.homedir(), out = console.log, err = console.error } = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    err(`resolve-config: ${parsed.error}\n${USAGE}`);
    return EXIT_UNRESOLVED;
  }
  if (parsed.options.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const config = resolveHarnessConfig({
    env,
    home,
    report: (problem) => err(`resolve-config: ${problem}`),
    requireRealm: parsed.options.requireRealm,
  });
  if (parsed.options.json) out(JSON.stringify(config, null, 2));
  else for (const line of asLines(config)) out(line);

  const problem = refusal(config);
  if (problem) {
    err(`resolve-config: ${problem}`);
    return EXIT_UNRESOLVED;
  }
  return EXIT_OK;
}

if (isEntryPoint(import.meta.url)) process.exit(run(process.argv.slice(2)));
