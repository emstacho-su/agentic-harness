#!/usr/bin/env node
/**
 * One-shot: name every collection's hub note after its folder (R-N1, SC-3).
 *
 *   node hooks/rename-hubs.mjs (--dry-run | --apply | --check) [--vault <dir>]
 *
 * `--dry-run` prints every move and `up:` rewrite it would make and writes
 * nothing. `--apply` makes them: `git mv` in a realm that is a git work tree,
 * a plain rename elsewhere, then a one-line textual edit per linking note (see
 * `lib/rename-hubs.mjs` for why never a re-serialise).
 *
 * `--check` is how the live apply is verified. It resolves every `up:` link
 * and verifies the hub links: each one naming a missing file is listed as
 * broken. Worker links (`[[<uuid>]]`, or a path into a `sessions/` folder) to
 * a missing parent are only reported, as pending with a tally per parent:
 * a worker's note is written long before its parent session's note, so an
 * unresolved one is the ordinary state, not breakage.
 *
 * Exit 0 when everything was (or would be) done, 2 when anything was refused
 * or could not be read, or — for `--check` — a hub link is broken; pending
 * worker links alone never fail a check. 1 on a usage error.
 * It never commits, never runs `ingest`, never removes a file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_VAULT_SEGMENTS, VAULT_ENV_VAR } from './lib/constants.mjs';
import { checkUpLinks, renameHubs } from './lib/rename-hubs.mjs';

const USAGE = 'usage: node hooks/rename-hubs.mjs (--dry-run | --apply | --check) [--vault <dir>]';
const MODES = new Map([
  ['--dry-run', 'dry-run'],
  ['--apply', 'apply'],
  ['--check', 'check'],
]);

/** Enough parents to see where the pending worker links come from, not every one. */
const PENDING_PARENTS_SHOWN = 10;

class UsageError extends Error {}

function parseArgs(argv) {
  const modes = [];
  let vault = process.env[VAULT_ENV_VAR] || path.join(os.homedir(), ...DEFAULT_VAULT_SEGMENTS);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (MODES.has(arg)) modes.push(MODES.get(arg));
    else if (arg === '--vault') {
      vault = argv[index + 1];
      if (!vault) throw new UsageError('--vault needs a value');
      index += 1;
    } else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (modes.length !== 1) throw new UsageError('exactly one of --dry-run, --apply, --check is required');
  return { mode: modes[0], vault };
}

function printProblems(label, problems) {
  for (const problem of problems) console.log(`${label}: ${problem.path}: ${problem.error}`);
}

function runCheck(vault) {
  const report = checkUpLinks({ vault });
  for (const offender of report.broken) console.log(`${offender.path}: up: ${offender.value}`);
  printProblems('unreadable', report.unreadable);
  console.log(`up links checked: ${report.checked}, unreadable: ${report.unreadable.length}`);
  console.log(`broken hub links: ${report.broken.length}`);
  console.log(`pending worker links: ${report.pending.length} (parent session not captured yet)`);
  for (const { parent, count } of report.pendingByParent.slice(0, PENDING_PARENTS_SHOWN)) console.log(`  ${parent}: ${count} workers`);
  const hidden = report.pendingByParent.length - PENDING_PARENTS_SHOWN;
  if (hidden > 0) console.log(`  … and ${hidden} more parents`);
  return report.broken.length || report.unreadable.length ? 2 : 0;
}

function runRename(vault, apply) {
  const report = renameHubs({ vault, apply, log: (line) => console.log(line) });
  printProblems('refused', report.refused);
  printProblems('unreadable', report.unreadable);
  const rewrites = report.rewrites.reduce((sum, rewrite) => sum + rewrite.changes.length, 0);
  console.log(`moves: ${report.moves.length}, rewrites: ${rewrites}, refused: ${report.refused.length}, unreadable: ${report.unreadable.length}`);
  if (!apply) console.log('dry run: nothing was written');
  return report.refused.length || report.unreadable.length ? 2 : 0;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`rename-hubs: ${err.message}\n${USAGE}`);
    return 1;
  }
  if (!fs.existsSync(args.vault)) throw new Error(`vault not found: ${args.vault}`);
  return args.mode === 'check' ? runCheck(args.vault) : runRename(args.vault, args.mode === 'apply');
}

// Importable for the tests; only a direct run hits main().
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`rename-hubs failed: ${err?.message || err}`);
    process.exitCode = 1;
  }
}
