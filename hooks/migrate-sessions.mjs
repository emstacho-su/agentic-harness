#!/usr/bin/env node
/**
 * One-time migration: every session note to schema v2, in the right collection,
 * under its full session id (R-27.1, task loop 7).
 *
 *   node hooks/migrate-sessions.mjs --vault "<vault>" --backup "<dir>" [--dry-run]
 *                                   [--repo bb2dash=C:/Users/estac/projects/bb2dash]
 *                                   [--no-network]
 *
 * Safety, in the order it matters:
 *   1. `--dry-run` prints the whole plan and writes nothing. Rehearse on a copy
 *      of the vault first; that is the SOP and it is not optional.
 *   2. Every original is copied to `--backup` before anything is written.
 *   3. A note whose frontmatter will not parse is reported and left alone.
 *   4. A move that would overwrite an existing note is refused, not resolved.
 *
 * It never runs `ingest`. Re-ingesting is the PM's step at integration.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { backfillSession } from './lib/backfill.mjs';
import { DEFAULT_VAULT_SEGMENTS, VAULT_ENV_VAR } from './lib/constants.mjs';
import { serializeFrontmatter } from './lib/frontmatter.mjs';
import { COLLECTION_OVERRIDES, RETIRED_FOLDERS, alreadyMigrated, migrateNote, planNote } from './lib/migrate.mjs';
import { makeRepoResolver } from './lib/paths.mjs';
import { resolveRepo } from './lib/repo.mjs';
import { toPosix } from './lib/text.mjs';
import { readSessionNotes } from './untagged-sessions.mjs';

/** Where `git log` runs for a collection. Explicit, never searched for. */
const DEFAULT_REPO_ROOTS = {
  bb2dash: 'C:/Users/estac/projects/bb2dash',
  'agentic-harness': 'C:/Users/estac/agentic-harness',
};

/**
 * The remote identity of a collection whose checkout is gone.
 *
 * `repo:` is one of the fields the Definition of done requires on every session
 * note, and a note filed by the override table has no cwd left to resolve. This
 * is the same kind of typed decision as the override table itself.
 */
const DEFAULT_REPO_FULL_NAMES = {
  bb2dash: 'emstacho-su/bb2dash',
  'agentic-harness': 'emstacho-su/agentic-harness',
};

/** Fill in `repo` from the table when the cwd could not supply it. */
function withKnownRepo(plan) {
  if (plan.repoFullName) return plan;
  return { ...plan, repoFullName: DEFAULT_REPO_FULL_NAMES[plan.collection] || '' };
}

function parseArgs(argv) {
  const args = {
    vault: process.env[VAULT_ENV_VAR] || path.join(os.homedir(), ...DEFAULT_VAULT_SEGMENTS),
    backup: '',
    dryRun: false,
    force: false,
    network: true,
    repoRoots: { ...DEFAULT_REPO_ROOTS },
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--no-network') args.network = false;
    else if (arg === '--vault' || arg === '--backup') {
      if (!value) throw new Error(`${arg} needs a value`);
      args[arg === '--vault' ? 'vault' : 'backup'] = value;
      index += 1;
    } else if (arg === '--repo') {
      if (!value || !value.includes('=')) throw new Error('--repo needs <collection>=<path>');
      const at = value.indexOf('=');
      args.repoRoots[value.slice(0, at)] = value.slice(at + 1);
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }

  if (!args.dryRun && !args.backup) throw new Error('a real run needs --backup <dir>');
  return args;
}

/** `gh` disabled: a runner that reports the reason instead of reaching the network. */
const OFFLINE_GH = () => ({ ok: false, stdout: '', error: 'network disabled with --no-network' });

function buildPlan(args) {
  const { notes, problems } = readSessionNotes(args.vault);
  const repoFor = makeRepoResolver();
  const resolveRepoFor = (cwd) => (cwd && fs.existsSync(cwd) ? resolveRepo(cwd) : null);

  const plans = notes.map((note) => {
    const plan = withKnownRepo(planNote({ note, resolveRepoFor, overrides: COLLECTION_OVERRIDES }));
    const from = toPosix(note.path);
    const to = toPosix(path.join(args.vault, plan.area, plan.collection, 'sessions', plan.filename));
    return { note, plan, from, to, repoFor };
  });

  return { plans, problems };
}

function backfillFor({ plan, note, args }) {
  const collection = plan.collection;
  const repoRoot = args.repoRoots[collection] || '';
  const repoFullName = plan.repoFullName || DEFAULT_REPO_FULL_NAMES[collection] || '';

  if (!repoRoot || !fs.existsSync(repoRoot)) {
    return { commits: [], prs: [], branch: '', notes: [`no repo root on disk for ${collection}`] };
  }
  return backfillSession({
    repoRoot,
    repoFullName,
    startedAt: String(note.fields.started_at ?? ''),
    endedAt: String(note.fields.ended_at ?? ''),
    runGh: args.network ? undefined : OFFLINE_GH,
  });
}

/** Copy every file under `dir` into the backup, preserving vault-relative paths. */
function backupTree(dir, vaultRoot, backupDir) {
  if (!backupDir) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    backupOriginal(path.join(entry.parentPath ?? entry.path ?? dir, entry.name), vaultRoot, backupDir);
    count += 1;
  }
  return count;
}

function backupOriginal(from, vaultRoot, backupDir) {
  const relative = path.relative(vaultRoot, from);
  const destination = path.join(backupDir, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(from, destination);
  return destination;
}

/**
 * Retire a folder once nothing is left in it.
 *
 * `movedOut` is how a dry run tells the truth: the files are still on disk, so
 * the folder only counts as empty if every file in it is one the plan moves.
 */
function removeRetiredFolders(vaultRoot, dryRun, report, movedOut, backupDir) {
  for (const folder of RETIRED_FOLDERS) {
    const dir = path.join(vaultRoot, 'projects', folder);
    if (!fs.existsSync(dir)) continue;

    const sessions = path.join(dir, 'sessions');
    const leftovers = (fs.existsSync(sessions) ? fs.readdirSync(sessions) : []).filter(
      (name) => !movedOut.has(toPosix(path.join(sessions, name))),
    );
    if (leftovers.length) {
      report.push(`kept ${folder}/: ${leftovers.length} file(s) still in sessions/`);
      continue;
    }
    const remaining = fs.readdirSync(dir).filter((name) => name !== 'sessions' && name !== 'index.md');
    if (remaining.length) {
      report.push(`kept ${folder}/: unexpected contents ${remaining.join(', ')}`);
      continue;
    }
    if (dryRun) {
      report.push(`would remove projects/${folder}/ (empty sessions/ and its index.md)`);
      continue;
    }
    // The index note is hand-authored and `readSessionNotes` never saw it, so
    // it has not been backed up by the plan loop. Rule 2 says every original is
    // copied before anything is written; this is the rest of that promise.
    const saved = backupTree(dir, vaultRoot, backupDir);
    fs.rmSync(dir, { recursive: true, force: true });
    report.push(`removed projects/${folder}/ (${saved} file(s) backed up first)`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.vault)) throw new Error(`vault not found: ${args.vault}`);

  const { plans, problems } = buildPlan(args);
  console.log(`vault: ${args.vault}`);
  console.log(`${plans.length} session note(s), ${problems.length} unreadable`);
  for (const problem of problems) console.log(`  UNREADABLE ${problem.path}: ${problem.error}`);
  console.log('');

  const backupDir = args.dryRun ? '' : path.join(args.backup, `vault-sessions-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  if (backupDir) fs.mkdirSync(backupDir, { recursive: true });

  const report = [];
  const movedOut = new Set();
  // Two plans can name one destination: two v1 notes for one resumed session
  // carry the same session_id and both map to `<session_id>.md`. Tracking the
  // claims here means a dry run refuses the same one the real run will.
  const claimed = new Map();
  let written = 0;
  let refused = 0;
  let skipped = 0;

  for (const entry of plans) {
    const { note, plan, from, to, repoFor } = entry;

    if (alreadyMigrated(note) && !args.force) {
      console.log(`${relativeTo(args.vault, from)}
  -> already schema_version 2, left alone (--force to redo)`);
      skipped += 1;
      continue;
    }
    const backfill = backfillFor({ plan, note, args });
    const { fields, body, emptied } = migrateNote({ note, plan, backfill, repoFor });
    const text = `${serializeFrontmatter(fields)}\n\n${body.replace(/^\n+/, '')}`;

    // The destination is built from a note's own frontmatter, so containment is
    // asserted rather than assumed: a future change to the naming rules cannot
    // write outside the vault without failing here first.
    if (!isInsideVault(args.vault, to)) {
      console.log(`REFUSED ${relativeTo(args.vault, from)}: destination is outside the vault`);
      refused += 1;
      continue;
    }

    const moving = toPosix(from) !== toPosix(to);
    const claimant = claimed.get(toPosix(to));
    if (claimant) {
      console.log(
        `REFUSED ${relativeTo(args.vault, from)} -> ${relativeTo(args.vault, to)}: ` +
          `already claimed by ${relativeTo(args.vault, claimant)}`,
      );
      refused += 1;
      continue;
    }
    if (moving && fs.existsSync(to)) {
      console.log(`REFUSED ${relativeTo(args.vault, from)} -> ${relativeTo(args.vault, to)}: target exists`);
      refused += 1;
      continue;
    }
    claimed.set(toPosix(to), from);

    console.log(`${relativeTo(args.vault, from)}`);
    console.log(`  -> ${relativeTo(args.vault, to)}   (${plan.decidedBy})`);
    console.log(
      `     branch=${fields.branch || '(empty)'} commits=${fields.commits.length} ` +
        `prs=[${fields.prs.join(', ')}] phase=${fields.phase || '(empty)'} tags=[${fields.tags.join(', ')}]`,
    );
    if (emptied.length) console.log(`     left empty: ${emptied.join(', ')}`);
    for (const reason of backfill.notes ?? []) console.log(`     ${reason}`);

    if (moving) movedOut.add(toPosix(from));
    if (args.dryRun) continue;

    backupOriginal(from, args.vault, backupDir);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, text, 'utf8');
    if (moving) fs.rmSync(from);
    written += 1;
  }

  removeRetiredFolders(args.vault, args.dryRun, report, movedOut, backupDir);

  console.log('');
  for (const line of report) console.log(line);
  if (args.dryRun) {
    console.log(
      `\ndry run: ${plans.length - refused - skipped} note(s) would be written, ` +
        `${refused} refused, ${skipped} already migrated. Nothing changed.`,
    );
  } else {
    console.log(
      `\nwrote ${written} note(s), refused ${refused}, skipped ${skipped} already migrated. ` +
        `Originals backed up to ${backupDir}`,
    );
    console.log('ingest was NOT run; re-ingest at integration.');
  }
}

function relativeTo(root, file) {
  return toPosix(path.relative(root, file));
}

/** Is `candidate` strictly inside `vault`? */
function isInsideVault(vault, candidate) {
  const root = path.resolve(vault);
  const target = path.resolve(candidate);
  return target.startsWith(root + path.sep);
}

try {
  main();
} catch (err) {
  console.error(`migration failed: ${err?.message || err}`);
  process.exitCode = 1;
}
