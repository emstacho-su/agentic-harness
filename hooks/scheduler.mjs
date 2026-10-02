#!/usr/bin/env node
/**
 * scheduler.mjs — the harness jobs on a timer, for the jobs container (R-90).
 *
 *   node hooks/scheduler.mjs                           # run forever: start whatever is due, every 30 s
 *   node hooks/scheduler.mjs --run-now nightly|collect # run one job now, whether or not it is due
 *   node hooks/scheduler.mjs --state <file>            # the state file (default: $HARNESS_SCHEDULER_STATE
 *                                                      #   or /state/scheduler.json)
 *
 * `nightly` (scripts/nightly-ingest.sh) is due at 03:00 and `collect`
 * (collect-checkpoints.mjs --ingest) at 12:00 and 18:00, New York time; the
 * rules are in lib/schedule.mjs. The loop does not wait for a timer to fire at
 * 03:00. Every tick it compares the wall clock with each job's `last_run_at`,
 * so a machine that slept through a window runs the job once when it wakes.
 *
 * Three guarantees, each with a test in tests/scheduler.test.mjs:
 *   - `last_run_at` is written (temporary file, then rename) before the job
 *     starts. A scheduler killed mid-run and restarted does not run it again
 *     in the same window; the next window does.
 *   - One job at a time. Jobs in the loop run one after another, and a lock
 *     file beside the state makes a second process (`--run-now` from
 *     `docker compose exec`) stand down instead of overlapping.
 *   - A job that cannot be started is recorded and logged, never thrown: the
 *     loop outlives a bad night.
 *
 * Exit codes of `--run-now`: the job's own. The scheduler's own are taken from
 * sysexits so they cannot be mistaken for the nightly's 1 or 2: 64 bad usage,
 * 75 another job is running, 70 the state or the lock could not be written.
 * Child output goes straight to this process's stdout and stderr.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './lib/entry-point.mjs';
import {
  EMPTY_STATE,
  JOB_NAMES,
  SCHEDULE,
  dueJobs,
  jobCommand,
  latestWindowMs,
  nextWindowMs,
  parseState,
  serializeState,
  withFinish,
  withStart,
} from './lib/schedule.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** On the `job-state` volume in the container; elsewhere pass --state. */
export const DEFAULT_STATE_FILE = '/state/scheduler.json';
export const STATE_ENV_VAR = 'HARNESS_SCHEDULER_STATE';

/** How often the loop looks at the clock. A window is caught at most this late. */
export const TICK_MS = 30_000;

export const RUN_LOCK_FILENAME = 'scheduler.lock';

/**
 * A lock older than this is taken over whoever holds it. Six hours is several
 * times the longest nightly on record, and short enough that a lock left by a
 * removed container never costs more than one window.
 */
export const RUN_LOCK_STALE_MS = 6 * 60 * 60_000;

export const EXIT_OK = 0;
export const EXIT_USAGE = 64;
export const EXIT_INTERNAL = 70;
export const EXIT_BUSY = 75;
/** What a shell reports for a command it could not start. */
export const EXIT_SPAWN_FAILED = 127;
/** A child ended by signal n is reported as 128 + n, as a shell does. */
const SIGNAL_EXIT_BASE = 128;

/** Passes through create → judge → take over before giving up on a busy lock. */
const ACQUIRE_MAX_PASSES = 3;

const RUN_NOW_FLAG = '--run-now';
const STATE_FLAG = '--state';
const USAGE = `usage: node hooks/scheduler.mjs [${RUN_NOW_FLAG} ${JOB_NAMES.join('|')}] [${STATE_FLAG} <file>]`;

const describe = (err) => err?.code || err?.message || String(err);

/** Parse argv into `{ ok: true, options }` or `{ ok: false, error }`; it never exits. */
export function parseArgs(argv, env = process.env) {
  const options = { stateFile: env[STATE_ENV_VAR] || DEFAULT_STATE_FILE, runNow: '', help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === RUN_NOW_FLAG || arg === STATE_FLAG) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return { ok: false, error: `${arg} needs a value` };
      if (arg === RUN_NOW_FLAG && !JOB_NAMES.includes(value)) {
        return { ok: false, error: `${RUN_NOW_FLAG} takes ${JOB_NAMES.join('|')}, not '${value}'` };
      }
      if (arg === RUN_NOW_FLAG) options.runNow = value;
      else options.stateFile = value;
      index += 1;
    } else {
      return { ok: false, error: `unknown argument: ${arg}` };
    }
  }
  return { ok: true, options };
}

/**
 * The state on disk. A missing file is EMPTY_STATE; so is a damaged one, after
 * `report` is told why. A file that exists but cannot be read is thrown: the
 * caller must not treat "could not look" as "never ran".
 */
export function readState(stateFile, { report = () => {} } = {}) {
  let text;
  try {
    text = fs.readFileSync(stateFile, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return EMPTY_STATE;
    throw err;
  }
  const parsed = parseState(text);
  if (!parsed.ok) report(`state ${stateFile} is unreadable (${parsed.problem}); every job counts as never run`);
  return parsed.state;
}

/**
 * Write the state to a temporary file beside it, then rename it into place. A
 * crash mid-write leaves the previous state whole: a truncated file would read
 * as "never ran" and start every job again. `fsImpl` is a parameter for the tests.
 */
export function writeStateAtomic(stateFile, state, { fsImpl = fs } = {}) {
  const temporary = `${stateFile}.tmp-${process.pid}`;
  fsImpl.mkdirSync(path.dirname(stateFile), { recursive: true });
  try {
    fsImpl.writeFileSync(temporary, serializeState(state), 'utf8');
    fsImpl.renameSync(temporary, stateFile);
  } catch (err) {
    try {
      fsImpl.rmSync(temporary, { force: true });
    } catch {
      // The temporary copy is inert; the failure worth reporting is the one above.
    }
    throw err;
  }
}

/** Is a process with this pid running here? EPERM means yes, owned by someone else. */
function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** Read a lock file into `{ ok, text, holder, mtimeMs }`, or `{ ok: false, code }`. */
function readLock(lockPath) {
  let text;
  let mtimeMs;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch (err) {
    return Object.freeze({ ok: false, code: describe(err) });
  }
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null; // Unparseable: judged by the file's age alone.
  }
  const holder = Object.freeze({
    pid: Number.isInteger(body?.pid) ? body.pid : null,
    host: typeof body?.host === 'string' ? body.host : '',
    job: typeof body?.job === 'string' ? body.job : '',
    startedAt: typeof body?.startedAt === 'string' ? body.startedAt : '',
    token: typeof body?.token === 'string' ? body.token : '',
  });
  return Object.freeze({ ok: true, text, holder, mtimeMs });
}

/**
 * Whether a lock's holder is gone. Past the stale window, always. Inside it,
 * only a holder on this host can be probed: it is gone when its process is, or
 * when the lock names this very process (which has not taken it, so it was
 * left by an earlier life of the container that reused the pid).
 */
function holderIsGone({ holder, mtimeMs }, { pid, host, now, isAlive }) {
  const startedMs = Date.parse(holder.startedAt);
  if (now - (Number.isFinite(startedMs) ? startedMs : mtimeMs) > RUN_LOCK_STALE_MS) return true;
  if (holder.pid === null || holder.host !== host) return false;
  return holder.pid === pid || !isAlive(holder.pid);
}

/**
 * Move a dead holder's lock aside. `'retry'` when the path is free again;
 * a holder when the file we moved turned out to be a fresh lock written after
 * we judged (it is put back). The same dance as lib/realm-lock.mjs.
 */
function evictLock(lockPath, judged) {
  const aside = `${lockPath}.stale-${randomUUID()}`;
  try {
    fs.renameSync(lockPath, aside);
  } catch (err) {
    if (err?.code === 'ENOENT') return 'retry'; // Another contender moved it first.
    throw err;
  }
  const moved = readLock(aside);
  if (moved.ok && moved.holder.token !== judged.holder.token) {
    try {
      fs.writeFileSync(lockPath, moved.text, { flag: 'wx' });
      fs.rmSync(aside, { force: true });
    } catch {
      // A third contender took the path: the aside copy is the only copy of the fresh lock, so it stays.
    }
    return moved.holder;
  }
  fs.rmSync(aside, { force: true });
  return 'retry';
}

/**
 * Take the run lock beside the state file, or say who holds it. Frozen:
 * `{ ok: true, lockPath, token }`, `{ ok: false, reason: 'held', holder }` or
 * `{ ok: false, reason: 'error', error }`.
 */
export function acquireRunLock(stateFile, { job, pid = process.pid, host = os.hostname(), now = Date.now(), isAlive = pidIsAlive } = {}) {
  const lockPath = path.join(path.dirname(stateFile), RUN_LOCK_FILENAME);
  const token = randomUUID();
  const text = `${JSON.stringify({ pid, host, job, startedAt: new Date(now).toISOString(), token })}\n`;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    for (let pass = 0; pass < ACQUIRE_MAX_PASSES; pass += 1) {
      try {
        fs.writeFileSync(lockPath, text, { flag: 'wx' });
        return Object.freeze({ ok: true, lockPath, token });
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
      }
      const current = readLock(lockPath);
      if (!current.ok) {
        if (current.code === 'ENOENT') continue; // Released between our create and our read.
        return Object.freeze({ ok: false, reason: 'error', error: current.code });
      }
      if (!holderIsGone(current, { pid, host, now, isAlive })) {
        return Object.freeze({ ok: false, reason: 'held', holder: current.holder });
      }
      const evicted = evictLock(lockPath, current);
      if (evicted !== 'retry') return Object.freeze({ ok: false, reason: 'held', holder: evicted });
    }
  } catch (err) {
    return Object.freeze({ ok: false, reason: 'error', error: describe(err) });
  }
  return Object.freeze({ ok: false, reason: 'error', error: 'lock contended' });
}

/** Give the lock back. Only a file carrying our token is removed. */
export function releaseRunLock({ lockPath, token }) {
  const current = readLock(lockPath);
  if (!current.ok) return current.code === 'ENOENT' ? { ok: true } : { ok: false, error: current.code };
  if (current.holder.token !== token) return { ok: false, error: 'not ours' };
  try {
    fs.rmSync(lockPath, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

/**
 * Run one job under the lock: stamp its start, run it, stamp its end.
 *
 * Returns `{ job, ran: true, exitCode }`, or `{ job, ran: false, ... }` with
 * `busy` and `holder` when another job holds the lock, or `error` when the lock
 * or the start stamp could not be written. A job whose start cannot be stamped
 * is not run: without the stamp it would be due again on every tick.
 */
export async function runJob(job, { stateFile, now = Date.now, runner, log = () => {}, host, pid, isAlive }) {
  const lock = acquireRunLock(stateFile, { job, pid, host, now: now(), isAlive });
  if (!lock.ok) {
    if (lock.reason === 'held') return { job, ran: false, busy: true, holder: lock.holder };
    log(`${job}: not started, the run lock could not be taken (${lock.error})`);
    return { job, ran: false, error: lock.error };
  }
  try {
    const startedAtMs = now();
    const windowMs = latestWindowMs(SCHEDULE[job], startedAtMs);
    let started;
    try {
      started = withStart(readState(stateFile, { report: log }), job, { startedAtMs, windowMs });
      writeStateAtomic(stateFile, started);
    } catch (err) {
      log(`${job}: not started, ${stateFile} could not be written (${describe(err)})`);
      return { job, ran: false, error: describe(err) };
    }
    log(`${job}: starting for the window ${new Date(windowMs).toISOString()}`);

    let exitCode;
    try {
      exitCode = await runner(job);
    } catch (err) {
      log(`${job}: could not be run (${err?.message || describe(err)})`);
      exitCode = EXIT_SPAWN_FAILED;
    }

    const finishedAtMs = now();
    try {
      writeStateAtomic(stateFile, withFinish(started, job, { finishedAtMs, exitCode }));
    } catch (err) {
      log(`${job}: its end could not be recorded in ${stateFile} (${describe(err)})`);
    }
    log(`${job}: exit ${exitCode} after ${Math.round((finishedAtMs - startedAtMs) / 1000)} s`);
    return { job, ran: true, exitCode };
  } finally {
    const released = releaseRunLock(lock);
    if (!released.ok) log(`${job}: the run lock was not released (${released.error})`);
  }
}

const busyLine = (holder) => `busy: ${holder.job || 'a job'} running since ${holder.startedAt || 'an unknown time'} (pid ${holder.pid ?? 'unknown'})`;

/**
 * Start every job that is due, one after another. Each is checked again just
 * before it starts, because the job before it may have run for an hour and a
 * `--run-now` from another process may have covered the window meanwhile. A
 * job that finds the lock held stays due and is tried on the next tick.
 */
export async function tick(deps) {
  const { stateFile, now = Date.now, log = () => {} } = deps;
  const results = [];
  for (const job of dueJobs(readState(stateFile, { report: log }), now())) {
    if (!dueJobs(readState(stateFile), now()).includes(job)) continue;
    const result = await runJob(job, deps);
    if (result.busy) log(`${job}: waiting, ${busyLine(result.holder)}`);
    results.push(result);
  }
  return results;
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Tick, sleep, repeat until `shouldStop`. A tick that throws is logged and the loop goes on. */
export async function runLoop(deps) {
  const { stateFile, now = Date.now, log = () => {}, sleep = defaultSleep, shouldStop = () => false } = deps;
  const upcoming = JOB_NAMES.map((job) => `${job} ${new Date(nextWindowMs(SCHEDULE[job], now())).toISOString()}`).join(', ');
  log(`started; state ${stateFile}; next windows: ${upcoming}`);
  while (!shouldStop()) {
    try {
      await tick(deps);
    } catch (err) {
      log(`tick failed (${err?.message || describe(err)}); trying again in ${TICK_MS / 1000} s`);
    }
    await sleep(TICK_MS);
  }
  log('stopped');
}

/**
 * The real runner: spawn the job's command with this process's stdout and
 * stderr, and resolve with its exit code. The working directory is the home
 * directory and the script is named by its full path, the package's spawn rule
 * (lib/spawn.mjs). `onChild` hears the running child, then null when it ends.
 */
export function spawnRunner({ env = process.env, repoRoot = path.resolve(HERE, '..'), onChild = () => {} } = {}) {
  return (job) => new Promise((resolve, reject) => {
    const { command, args } = jobCommand(job, { repoRoot, node: process.execPath, env });
    const child = spawn(command, args, { cwd: os.homedir(), env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    onChild(child);
    child.once('error', (err) => {
      onChild(null);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      onChild(null);
      resolve(Number.isInteger(code) ? code : SIGNAL_EXIT_BASE + (os.constants.signals[signal] ?? 0));
    });
  });
}

/**
 * One invocation: `--run-now <job>` runs that job and returns its exit code;
 * no flag runs the loop until `shouldStop`. Everything that touches the clock,
 * the processes or the terminal is a parameter, for the tests.
 */
export async function main(argv, { env = process.env, out = console.log, err = console.error, ...overrides } = {}) {
  const parsed = parseArgs(argv, env);
  if (!parsed.ok) {
    err(`error: ${parsed.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (parsed.options.help) {
    out(USAGE);
    return EXIT_OK;
  }
  const deps = {
    now: Date.now,
    log: (line) => out(`${new Date().toISOString()} scheduler: ${line}`),
    runner: spawnRunner({ env }),
    ...overrides,
    stateFile: parsed.options.stateFile,
  };

  const { runNow } = parsed.options;
  if (!runNow) {
    await runLoop(deps);
    return EXIT_OK;
  }
  const result = await runJob(runNow, deps);
  if (result.ran) return result.exitCode;
  if (result.busy) {
    err(`${busyLine(result.holder)}; ${runNow} not started`);
    return EXIT_BUSY;
  }
  err(`error: ${runNow} not started (${result.error})`);
  return EXIT_INTERNAL;
}

/** SIGTERM and SIGINT: pass the signal to the running job, then let the loop end. */
function runAsProcess() {
  let stopping = false;
  let child = null;
  let wake = () => {};
  const stop = (signal) => {
    stopping = true;
    if (child) child.kill(signal);
    wake();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));

  const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  const runner = spawnRunner({ onChild: (running) => { child = running; } });
  return main(process.argv.slice(2), { runner, sleep, shouldStop: () => stopping });
}

if (isEntryPoint(import.meta.url)) {
  runAsProcess().then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error(`scheduler: ${err?.stack || err}`);
      process.exitCode = EXIT_INTERNAL;
    },
  );
}
