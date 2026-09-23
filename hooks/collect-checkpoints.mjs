#!/usr/bin/env node
/**
 * collect-checkpoints.mjs — bring /checkpoint notes from git into the vault.
 *
 *   node hooks/collect-checkpoints.mjs [--vault <dir>] [--repo <path>]... [--no-fetch] [--dry-run]
 *
 * Step 0b of the nightly reconcile. For each repository (default: the two
 * where cloud sessions run) it fetches, reads every `.harness/sessions/*.md`
 * off every branch, validates and redacts each note, and files it under the
 * vault collection it names. The ingest that follows embeds them.
 *
 * Exit codes: 0 clean, 1 if a note was refused or a repo could not be fetched
 * (the run still completed), 2 bad usage or a missing vault. A note deferred
 * because the nightly sync holds its realm's lock is not a problem: it is
 * filed on the next run, so deferrals alone still exit 0.
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCollect } from './lib/checkpoints.mjs';
import {
  DEFAULT_CHECKPOINT_REPO_SEGMENTS,
  DEFAULT_VAULT_SEGMENTS,
  SWEEP_INGEST_BATCH,
  VAULT_ENV_VAR,
} from './lib/constants.mjs';
import { enqueueIngest, inBatches } from './lib/enqueue-ingest.mjs';
import { createLogger } from './lib/logger.mjs';
import { loadMachineEnv } from './lib/machine-env.mjs';

export const LOG_ENV_VAR = 'HARNESS_CHECKPOINT_LOG';
export const EXIT_OK = 0;
export const EXIT_PROBLEMS = 1;
export const EXIT_USAGE = 2;

const USAGE = `usage: node collect-checkpoints.mjs [options]
  --vault <dir>     vault root (default: $${VAULT_ENV_VAR} or the OneDrive vault)
  --repo <path>     a repository to collect from; repeatable (default: ~/agentic-harness, ~/projects/bb2dash)
  --no-fetch        read the refs already on disk, do not git fetch
  --author <email>  accept only notes whose last commit has this author email; repeatable
                    (default: any author, i.e. anyone who can push to the repository)
  --ingest          start one detached ingest per batch of notes written (the twice-daily task uses this)
  --dry-run         report what would be filed, write nothing
  --help`;

export function parseArgs(argv, env = process.env, home = os.homedir()) {
  const options = {
    vaultRoot: env[VAULT_ENV_VAR] || path.join(home, ...DEFAULT_VAULT_SEGMENTS),
    repos: [],
    authors: [],
    fetch: true,
    ingest: false,
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
        case '--vault': options.vaultRoot = next(); break;
        case '--repo': options.repos.push(next()); break;
        case '--author': options.authors.push(next()); break;
        case '--no-fetch': options.fetch = false; break;
        case '--ingest': options.ingest = true; break;
        case '--dry-run': options.dryRun = true; break;
        case '--help': case '-h': options.help = true; break;
        default: throw new Error(`unknown option ${arg}`);
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  if (options.repos.length === 0) {
    options.repos = DEFAULT_CHECKPOINT_REPO_SEGMENTS.map((segments) => path.join(home, ...segments));
  }
  return { ok: true, options };
}

export function run(argv, { env = process.env, out = console.log, err = console.error } = {}) {
  env = loadMachineEnv(env, os.homedir(), err);
  const parsed = parseArgs(argv, env);
  if (!parsed.ok) {
    err(`error: ${parsed.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const options = parsed.options;
  if (options.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const log = createLogger(env[LOG_ENV_VAR] || path.join(os.homedir(), '.claude', 'hooks', 'collect-checkpoints.log'));
  const mode = options.dryRun ? 'dry-run' : 'apply';
  log(`=== collect starting (${mode}) vault=${options.vaultRoot} repos=${options.repos.join(', ')} fetch=${options.fetch}`);

  let summary;
  try {
    summary = runCollect({ repos: options.repos, vaultRoot: options.vaultRoot, dryRun: options.dryRun, fetch: options.fetch, authors: options.authors, log });
  } catch (error) {
    err(`error: ${error.message}`);
    log(`=== collect refused: ${error.message}`);
    return EXIT_USAGE;
  }

  for (const repo of summary.repos) {
    out(`repo ${repo.repoRoot}: ${repo.status}${repo.refs !== undefined ? `, ${repo.refs} ref(s), ${repo.notes} note(s)` : ''}`);
  }
  for (const result of summary.results) {
    out(`  ${result.action} ${result.notePath ?? result.file}${result.reason ? ` (${result.reason})` : ''}`);
  }
  let ingestFailures = 0;
  if (options.ingest && !options.dryRun && summary.touchedPaths.length) {
    // One detached ingest per batch, as the sweep does: a Windows command line
    // tops out at 32 KiB and each ingest process loads the embedding model once.
    for (const batch of inBatches(summary.touchedPaths, SWEEP_INGEST_BATCH)) {
      const result = enqueueIngest({ notePaths: batch, vaultRoot: options.vaultRoot, log, env });
      if (!result.enqueued) {
        ingestFailures += 1;
        err(`ingest not started for ${batch.length} note(s): ${result.reason}`);
      }
    }
    out(`ingest: ${summary.touchedPaths.length} note(s), ${ingestFailures} batch(es) failed to start`);
  }

  // `summary.deferred` is left out on purpose: a locked realm is waited out, not a failure.
  const problems = summary.skipped + summary.errors + summary.repos.filter((repo) => repo.status !== 'ok').length + ingestFailures;
  const line =
    `found=${summary.found} created=${summary.created} merged=${summary.merged} ` +
    `unchanged=${summary.unchanged} skipped=${summary.skipped} deferred=${summary.deferred} errors=${summary.errors} repos=${summary.repos.length}`;
  out(`collect ${mode}: ${line}`);
  log(`=== collect finished (${mode}) ${line}`);
  return problems > 0 ? EXIT_PROBLEMS : EXIT_OK;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(run(process.argv.slice(2)));
