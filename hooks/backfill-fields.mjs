#!/usr/bin/env node
/**
 * Fill bb2dash session notes' fields where they are derivable (brief 101 H-8).
 *
 *   node hooks/backfill-fields.mjs --vault <dir> --backup <dir> [--dry-run]
 *     [--report] [--json] [--repo bb2dash=<path>] [--no-network]
 *     [--relocate <session-prefix>=<realm>/<collection>]...
 *
 * `--dry-run` prints one line per change, `<note> <field>: <from> -> <to>
 * (<source>)`, and writes nothing. A real run needs `--backup`: every note it
 * changes is copied there first, and a relocated note's original is moved
 * there, never deleted. A second run changes nothing. It never runs `ingest`.
 *
 * `--report` adds the counts (`--json`: the report object alone on stdout).
 * Exit 0 on success, 1 on a usage error, 2 when any note was refused.
 */

import os from 'node:os';

import { DEFAULT_BB2DASH_CHECKOUT, parseRelocation, runBackfill } from './lib/backfill-fields.mjs';
import { isEntryPoint } from './lib/entry-point.mjs';
import { loadMachineEnv, machineName } from './lib/machine-env.mjs';
import { installExtraRulesFrom } from './lib/redact-extra.mjs';
import { toPosix } from './lib/text.mjs';

const VALUE_FLAGS = new Set(['--vault', '--backup', '--repo', '--relocate']);
const SWITCHES = new Set(['--dry-run', '--report', '--json', '--no-network']);

/** Flags to options; throws with a message naming the flag on anything it cannot use. */
export function parseArgs(argv) {
  const args = { vault: '', backup: '', dryRun: false, report: false, json: false, network: true, checkout: DEFAULT_BB2DASH_CHECKOUT, relocations: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (SWITCHES.has(flag)) {
      if (flag === '--dry-run') args.dryRun = true;
      if (flag === '--report') args.report = true;
      if (flag === '--json') args.json = true;
      if (flag === '--no-network') args.network = false;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    index += 1;
    if (flag === '--vault') args.vault = value;
    if (flag === '--backup') args.backup = value;
    if (flag === '--relocate') args.relocations.push(parseRelocation(value));
    if (flag === '--repo') args.checkout = parseRepoFlag(value);
  }
  if (!args.vault) throw new Error('--vault <dir> is required');
  if (!args.dryRun && !args.backup) throw new Error('a real run needs --backup <dir>');
  return args;
}

function parseRepoFlag(value) {
  const match = value.match(/^bb2dash=(.+)$/);
  if (!match) throw new Error(`--repo takes bb2dash=<path>: ${JSON.stringify(value)}`);
  return match[1];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const home = os.homedir();
  const say = (line) => console.error(line);
  const env = loadMachineEnv(process.env, home, say);
  installExtraRulesFrom(env, say);

  const result = runBackfill({
    vaultRoot: args.vault,
    backupDir: args.backup,
    dryRun: args.dryRun,
    checkout: args.checkout,
    home,
    projectsRoot: `${toPosix(home)}/.claude/projects`,
    relocations: args.relocations,
    network: args.network,
    machine: machineName(env),
  });

  if (args.json) {
    console.log(JSON.stringify(args.report ? result.report : { changes: result.report.changes, lines: result.lines }, null, 2));
  } else {
    for (const line of result.lines) console.log(line);
    if (args.report) for (const [key, value] of Object.entries(result.report)) console.log(`${key}: ${value}`);
    if (!args.dryRun && result.written.length) console.log(`${result.written.length} notes written; originals in ${args.backup}`);
  }
  for (const refusal of result.refused) say(`refused ${refusal.path}: ${refusal.error}`);
  if (result.refused.length) process.exitCode = 2;
}

if (isEntryPoint(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`backfill-fields: ${err?.message || err}`);
    process.exitCode = 1;
  }
}
