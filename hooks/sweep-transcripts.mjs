#!/usr/bin/env node
/**
 * sweep-transcripts.mjs — capture the sessions the SessionEnd hook never saw.
 *
 *   node hooks/sweep-transcripts.mjs [--vault <dir>] [--projects <dir>]
 *        [--min-idle-hours 6] [--limit N] [--session <id>]... [--dry-run] [--ingest]
 *
 * Walks `~/.claude/projects/`, finds every transcript with no note in the vault
 * that has been idle for the window, and runs it through the hook's own capture
 * code (see lib/sweep.mjs). The nightly job runs this first, then the full
 * ingest; `--ingest` is for a run by hand and starts one detached ingest over
 * every note the sweep touched.
 *
 * Runs from the main checkout, not from ~/.claude/hooks: it is a maintenance
 * command with a console, not a hook with a deadline.
 *
 * Exit codes: 0 clean, 1 if any candidate raised (it should not), 2 bad usage.
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SWEEP_IDLE_HOURS,
  DEFAULT_VAULT_SEGMENTS,
  SWEEP_EXCLUDED_CWD_SEGMENTS,
  SWEEP_INGEST_BATCH,
  VAULT_ENV_VAR,
} from './lib/constants.mjs';
import { enqueueIngest, inBatches } from './lib/enqueue-ingest.mjs';
import { createLogger } from './lib/logger.mjs';
import { runSweep } from './lib/sweep.mjs';
import { isSafeFilenameSegment } from './lib/text.mjs';

export const LOG_ENV_VAR = 'HARNESS_TRANSCRIPT_SWEEP_LOG';

export const EXIT_OK = 0;
export const EXIT_ERRORS = 1;
export const EXIT_USAGE = 2;
const HOUR_MS = 60 * 60 * 1000;

const USAGE = `usage: node sweep-transcripts.mjs [options]
  --vault <dir>          vault root (default: $${VAULT_ENV_VAR} or the OneDrive vault)
  --projects <dir>       transcript tree (default: ~/.claude/projects)
  --min-idle-hours <n>   leave transcripts modified within n hours alone (default ${DEFAULT_SWEEP_IDLE_HOURS})
  --limit <n>            capture at most n sessions this run
  --session <id>         only this session id; repeatable
  --exclude <text>       skip transcripts whose cwd contains this; repeatable
                         (always: ${SWEEP_EXCLUDED_CWD_SEGMENTS.join(', ')})
  --dry-run              list candidates, write nothing
  --ingest               start one detached ingest over every note touched
  --help`;

/**
 * Parse argv. Returns `{ ok: true, options }` or `{ ok: false, error }`; it
 * never exits, so the CLI wrapper below owns every exit code.
 */
export function parseArgs(argv, env = process.env, home = os.homedir()) {
  const options = {
    vaultRoot: env[VAULT_ENV_VAR] || path.join(home, ...DEFAULT_VAULT_SEGMENTS),
    projectsRoot: path.join(home, '.claude', 'projects'),
    minIdleHours: DEFAULT_SWEEP_IDLE_HOURS,
    limit: 0,
    only: null,
    dryRun: false,
    ingest: false,
    help: false,
  };
  const sessions = [];
  const excludes = [...SWEEP_EXCLUDED_CWD_SEGMENTS];

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
        case '--projects': options.projectsRoot = next(); break;
        case '--min-idle-hours': options.minIdleHours = nonNegative(arg, next()); break;
        case '--limit': options.limit = nonNegative(arg, next()); break;
        case '--session': sessions.push(safeSession(next())); break;
        case '--exclude': excludes.push(next()); break;
        case '--dry-run': options.dryRun = true; break;
        case '--ingest': options.ingest = true; break;
        case '--help': case '-h': options.help = true; break;
        default: throw new Error(`unknown option ${arg}`);
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return { ok: true, options: { ...options, only: sessions.length ? new Set(sessions) : null, excludes } };
}

function nonNegative(flag, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} must be a number >= 0, got ${raw}`);
  return value;
}

function safeSession(raw) {
  if (!isSafeFilenameSegment(raw)) {
    throw new Error(`--session is not a safe session id: ${JSON.stringify(String(raw).slice(0, 64))}`);
  }
  return raw;
}

/** The CLI body. Returns the exit code; `main` below is the only caller that exits. */
export function run(argv, { env = process.env, out = console.log, err = console.error } = {}) {
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

  const log = createLogger(env[LOG_ENV_VAR] || path.join(os.homedir(), '.claude', 'hooks', 'transcript-sweep.log'));
  const mode = options.dryRun ? 'dry-run' : 'apply';
  log(`=== sweep starting (${mode}) vault=${options.vaultRoot} projects=${options.projectsRoot} idle>=${options.minIdleHours}h`);

  let summary;
  try {
    summary = runSweep({
      projectsRoot: options.projectsRoot,
      vaultRoot: options.vaultRoot,
      minIdleMs: options.minIdleHours * HOUR_MS,
      limit: options.limit,
      only: options.only,
      dryRun: options.dryRun,
      excludes: options.excludes,
      log,
    });
  } catch (error) {
    // Only a bad root reaches here (runSweep validates both before it walks);
    // every per-session failure is a result, never a throw.
    err(`error: ${error.message}`);
    log(`=== sweep refused: ${error.message}`);
    return EXIT_USAGE;
  }

  if (options.dryRun) {
    for (const candidate of summary.candidates) {
      out(`candidate ${candidate.sessionId} ${new Date(candidate.mtimeMs).toISOString()} ${candidate.transcriptPath}`);
    }
  }
  const line =
    `transcripts=${summary.scanned} noted=${summary.skippedNoted} active=${summary.skippedActive} ` +
    `candidates=${summary.candidates.length} selected=${summary.selected} ` +
    `written=${summary.written} childNotes=${summary.childNotes} skipped=${summary.skipped} errors=${summary.errors}`;
  out(`sweep ${mode}: ${line}`);
  log(`=== sweep finished (${mode}) ${line}`);

  let ingestFailures = 0;
  if (options.ingest && summary.touchedPaths.length) {
    // One detached ingest per batch: a Windows command line tops out at 32 KiB,
    // and a full backlog can touch hundreds of notes.
    for (const batch of inBatches(summary.touchedPaths, SWEEP_INGEST_BATCH)) {
      const result = enqueueIngest({ notePaths: batch, vaultRoot: options.vaultRoot, log, env });
      if (!result.enqueued) {
        ingestFailures += 1;
        err(`ingest not started for ${batch.length} note(s): ${result.reason}`);
      }
    }
    out(`ingest: ${summary.touchedPaths.length} note(s) in ${Math.ceil(summary.touchedPaths.length / SWEEP_INGEST_BATCH)} batch(es), ${ingestFailures} failed to start`);
  }
  return summary.errors > 0 || ingestFailures > 0 ? EXIT_ERRORS : EXIT_OK;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(run(process.argv.slice(2)));
}
