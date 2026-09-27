#!/usr/bin/env node
/**
 * One-shot: move the harness history into the harness realm (R-H3).
 *
 *   node hooks/move-to-realm.mjs (--dry-run | --apply | --plan-only) [--vault <dir>]
 *
 * Without `--vault` the vault is HARNESS_VAULT, from the shell or from
 * `~/.harness/machine.env`, the same one the hook writes to.
 *
 * `--dry-run` prints one line per note (from, to, reason), each hub it would
 * archive and each link it would repoint, and writes nothing. `--apply` makes
 * them under both realm locks (lib/move-to-realm-apply.mjs), and only when the
 * plan has no conflict and no unreadable note. Both need the harness realm on
 * disk and listed in HARNESS_REALMS, and no live realm lock. `--plan-only` is the dry
 * run for before the realm exists: it plans as if it did, and checks nothing.
 *
 * Exit 0 when everything was (or would be) done, 2 when a precondition fails,
 * a note conflicts or cannot be read, or an apply step fails; 1 on a usage
 * error. It never commits and never runs ingest: sync, then ingest, after it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_VAULT_SEGMENTS, VAULT_ENV_VAR } from './lib/constants.mjs';
import { loadMachineEnv } from './lib/machine-env.mjs';
import { checkPreconditions, defaultArchiveRoot, planBlockers, planMoveToRealm } from './lib/move-to-realm.mjs';
import { applyMoveToRealm } from './lib/move-to-realm-apply.mjs';
import { parseRealmPolicies } from './lib/realm-sync.mjs';

const USAGE = 'usage: node hooks/move-to-realm.mjs (--dry-run | --apply | --plan-only) [--vault <dir>]';
const MODES = new Map([
  ['--dry-run', 'dry-run'],
  ['--apply', 'apply'],
  ['--plan-only', 'plan-only'],
]);
const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_ATTENTION = 2;

export function parseArgs(argv, env) {
  const modes = [];
  let vault = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (MODES.has(arg)) modes.push(MODES.get(arg));
    else if (arg === '--vault') {
      vault = argv[index + 1] ?? '';
      if (!vault || vault.startsWith('--')) return { ok: false, error: '--vault needs a value' };
      index += 1;
    } else return { ok: false, error: `unknown argument: ${arg}` };
  }
  if (modes.length !== 1) return { ok: false, error: 'exactly one of --dry-run, --apply, --plan-only is required' };
  return { ok: true, mode: modes[0], vault: vault || env[VAULT_ENV_VAR] || path.join(os.homedir(), ...DEFAULT_VAULT_SEGMENTS) };
}

/** The realm names HARNESS_REALMS lists, or the parse error that says why there are none. */
function listedRealms(env) {
  try {
    return { names: parseRealmPolicies(env.HARNESS_REALMS ?? '').map((policy) => policy.name), error: '' };
  } catch (error) {
    return { names: [], error: error.message };
  }
}

function report(plan, out) {
  for (const move of plan.moves) {
    const note = move.alreadyThere ? ' [already there]' : move.replacesStub ? ` [replaces a stub hub, archived to ${move.stubArchiveTo}]` : '';
    out(`move ${move.from} -> ${move.to} (${move.reason})${note}`);
  }
  for (const archive of plan.archives) out(`archive ${archive.from} -> ${archive.to}`);
  for (const place of plan.hubsToCreate) out(`hub ${place}/${place.split('/')[1]}.md (created: moved notes link up to it)`);
  for (const rewrite of plan.rewrites) for (const change of rewrite.changes) out(`link ${rewrite.path}: up: ${change.old} -> ${change.new}`);
  for (const stay of plan.stays) out(`stays ${stay.path} (${stay.reason})`);
  for (const conflict of plan.conflicts) out(`conflict ${conflict.path}: ${conflict.error}`);
  for (const problem of plan.unreadable) out(`unreadable ${problem.path}: ${problem.error}`);
  const byDestination = new Map();
  for (const move of plan.moves) {
    const destination = move.to.split('/').slice(0, 2).join('/');
    byDestination.set(destination, (byDestination.get(destination) ?? 0) + 1);
  }
  for (const [destination, count] of [...byDestination].sort()) out(`  -> ${destination}: ${count}`);
  out(`moves: ${plan.moves.length}, archives: ${plan.archives.length}, links: ${plan.rewrites.length}, new hubs: ${plan.hubsToCreate.length}, stays: ${plan.stays.length}, conflicts: ${plan.conflicts.length}, unreadable: ${plan.unreadable.length}`);
}

/**
 * @param {string[]} argv
 * @param {object} [io] env, out, err, home, tmp, now — injectable for tests
 */
export function run(argv, { env = process.env, out = console.log, err = console.error, home = os.homedir(), tmp = os.tmpdir(), now = new Date() } = {}) {
  const merged = loadMachineEnv(env, home, (problem) => err(`move-to-realm: ${problem}`));
  const parsed = parseArgs(argv, merged);
  if (!parsed.ok) {
    err(`move-to-realm: ${parsed.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const { mode, vault } = parsed;
  if (!fs.existsSync(vault)) {
    err(`move-to-realm: vault not found: ${vault}`);
    return EXIT_ATTENTION;
  }
  // Printed first: a run against the wrong vault looks exactly like a clean one.
  out(`vault: ${vault}`);
  if (mode !== 'plan-only') {
    const listed = listedRealms(merged);
    const problems = [...(listed.error ? [listed.error] : []), ...checkPreconditions({ vault, realmsListed: listed.names })];
    if (problems.length) {
      for (const problem of problems) out(`refused: ${problem}`);
      return EXIT_ATTENTION;
    }
  }
  const plan = planMoveToRealm({ vault, home, tmp, archiveRoot: defaultArchiveRoot(now, home), ...(mode === 'plan-only' ? { holdsHarness: true } : {}) });
  report(plan, out);
  const blocker = planBlockers(plan);
  if (mode !== 'apply') {
    out(`${mode}: nothing was written`);
    return blocker ? EXIT_ATTENTION : EXIT_OK;
  }
  // All or nothing: a plan that leaves notes behind would orphan them from hubs it moves.
  if (blocker) {
    out(`refused: ${blocker}`);
    return EXIT_ATTENTION;
  }
  const result = applyMoveToRealm(plan);
  for (const problem of result.errors) out(`failed ${problem.path}: ${problem.error}`);
  for (const hub of result.kept) out(`kept ${hub.path}: ${hub.reason}`);
  out(`applied: moved ${result.moved}, links ${result.rewritten}, new hubs ${result.hubs}, archived ${result.archived}, failed ${result.errors.length}`);
  out('next: node hooks/sync-realms.mjs --push, then uv run ingest');
  return result.errors.length ? EXIT_ATTENTION : EXIT_OK;
}

// Importable for the tests; only a direct run hits run().
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(`move-to-realm failed: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
