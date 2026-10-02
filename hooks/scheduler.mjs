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
 * A lock older than this is taken over, whoever holds it. Age is the only
 * signal (see `acquireRunLock`), so the window has to outlast any real job:
 * six hours is far beyond a full re-embed of the vault. What it costs is delay,
 * never a lost run. A lock is released in a `finally` on every exit the
 * process survives; one left behind (SIGKILL, a host crash) makes the next job
 * wait, still due, and it starts on the first tick after the window.
 */
export const RUN_LOCK_STALE_MS = 6 * 60 * 60_000;

/** Who took the lock, for the "busy" line. Not evidence of anything: only the token is. */
export const OWNER_LOOP = 'scheduler loop';
export const OWNER_RUN_NOW = '--run-now';

const LOCK_CONTENDED = 'lock contended';

export const EXIT_OK = 0;
export const EXIT_USAGE = 64;
export const EXIT_INTERNAL = 70;
export const EXIT_BUSY = 75;
/** A setting that cannot be used (a secret file that is missing or empty): EX_CONFIG, as the entrypoint. */
export const EXIT_CONFIG = 78;

/**
 * The variables that may arrive as `<NAME>_FILE`, a file holding the value
 * (a Docker secret). The same list as scripts/jobs-entrypoint.sh, explicit for
 * the same reason: HARNESS_INGEST_STATE_FILE ends in _FILE and is a path.
 */
export const SECRET_FILE_VARS = Object.freeze(['DATABASE_URL']);

/**
 * The environment with each `<NAME>_FILE` of SECRET_FILE_VARS read into
 * `<NAME>`: what scripts/jobs-entrypoint.sh does for the processes it starts,
 * done again here for the ones it does not start. `docker compose exec` gives
 * a process the service's environment (the file's name) and not the
 * entrypoint's exports (its content), so without this an exec'd
 * `scheduler.mjs --run-now nightly` would run the ingest with no store.
 *
 * Returns `{ ok: true, env, fromFiles }` with a new object (the input is not
 * changed), or `{ ok: false, problem }`. A value the entrypoint already
 * exported passes through. A file that is named but missing or empty is a
 * problem, and so is having both names set: the same three refusals as the
 * entrypoint. A problem names the variable and the path, never a value.
 */
export function envWithSecretFiles(env, { readFile = (file) => fs.readFileSync(file, 'utf8') } = {}) {
  const resolved = { ...env };
  const fromFiles = [];
  for (const name of SECRET_FILE_VARS) {
    const fileVar = `${name}_FILE`;
    const file = env[fileVar];
    if (!file) continue;
    if (env[name]) return { ok: false, problem: `${name} and ${fileVar} are both set; set only ${fileVar}` };
    let text;
    try {
      text = readFile(file);
    } catch {
      return { ok: false, problem: `${fileVar} names ${file}, which is not a readable file` };
    }
    const value = text.replace(/[\r\n]/g, '');
    if (!value) return { ok: false, problem: `${fileVar} names ${file}, which is empty` };
    resolved[name] = value;
    delete resolved[fileVar];
    fromFiles.push(name);
  }
  return { ok: true, env: resolved, fromFiles };
}
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

/**
 * Read a lock file into `{ ok, text, token, holder, ageMs }`, or `{ ok: false, code }`.
 * The holder is who to name in a message; the token is what a release compares.
 * When the JSON or its startedAt cannot be trusted, the file's mtime stands in
 * for the start time, so an unreadable lock ages out and is never taken as free.
 */
function readLock(lockPath, now, fsImpl = fs) {
  let text;
  let mtimeMs;
  try {
    text = fsImpl.readFileSync(lockPath, 'utf8');
    mtimeMs = fsImpl.statSync(lockPath).mtimeMs;
  } catch (err) {
    return Object.freeze({ ok: false, code: describe(err) });
  }
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null; // Unparseable: judged by the file's age alone.
  }
  const startedMs = Date.parse(body?.startedAt ?? '');
  const valid = Number.isFinite(startedMs);
  const holder = Object.freeze({
    pid: Number.isInteger(body?.pid) ? body.pid : null,
    owner: typeof body?.owner === 'string' ? body.owner : '',
    job: typeof body?.job === 'string' ? body.job : '',
    startedAt: valid ? new Date(startedMs).toISOString() : '',
  });
  const token = typeof body?.token === 'string' ? body.token : '';
  return Object.freeze({ ok: true, text, token, holder, ageMs: now - (valid ? startedMs : mtimeMs) });
}

const lockHeld = (holder) => Object.freeze({ ok: false, reason: 'held', holder });
const lockFailed = (error) => Object.freeze({ ok: false, reason: 'error', error });

/**
 * Move a stale lock aside and make sure it was the one we judged. Returns
 * `{ step: 'retry' }` to loop, `{ step: 'done', result }` to stop.
 *
 * If the file we moved carries another token, it is a fresh lock written after
 * we judged, and it goes back with an exclusive write. When that write finds
 * the path taken (a third contender, EEXIST) or fails any other way, nobody can
 * be named as the holder: the result is an error, "lock contended", and the
 * aside copy stays, being the only copy of the fresh holder's lock. The same
 * steps and the same outcome as lib/realm-lock.mjs.
 */
function evictStaleLock(lockPath, judged, now, fsImpl) {
  const aside = `${lockPath}.stale-${randomUUID()}`;
  try {
    fsImpl.renameSync(lockPath, aside);
  } catch (err) {
    if (err?.code === 'ENOENT') return { step: 'retry' }; // Another contender won the rename.
    return { step: 'done', result: lockFailed(describe(err)) };
  }
  const moved = readLock(aside, now, fsImpl);
  if (moved.ok && moved.token !== judged.token) {
    try {
      fsImpl.writeFileSync(lockPath, moved.text, { flag: 'wx' });
    } catch (err) {
      return { step: 'done', result: lockFailed(err?.code === 'EEXIST' ? LOCK_CONTENDED : describe(err)) };
    }
    fsImpl.rmSync(aside, { force: true });
    return { step: 'done', result: lockHeld(moved.holder) };
  }
  fsImpl.rmSync(aside, { force: true });
  return { step: 'retry' };
}

/**
 * Take the run lock beside the state file, or say who holds it. Frozen:
 * `{ ok: true, lockPath, token }`, `{ ok: false, reason: 'held', holder }` or
 * `{ ok: false, reason: 'error', error }`.
 *
 * The lock is a file created with an exclusive open; its existence is the
 * lock. Whether a holder is still there is judged by the lock's age and
 * nothing else. There is no pid liveness check, for the reason realm-lock.mjs
 * gives and a stronger one: in a container the scheduler is the same small pid
 * after every restart and every `exec` draws from the same few numbers, so "is
 * pid 7 alive" is yes for a lock left by a dead scheduler and "the lock names
 * my pid" is true of a lock that is not mine. `pid` and `owner` are written
 * for the message; only the token says whose lock it is. `fsImpl` is for the tests.
 */
export function acquireRunLock(stateFile, { job, owner = '', pid = process.pid, now = Date.now(), fsImpl = fs } = {}) {
  const lockPath = path.join(path.dirname(stateFile), RUN_LOCK_FILENAME);
  const token = randomUUID();
  const text = `${JSON.stringify({ pid, owner: String(owner), job, startedAt: new Date(now).toISOString(), token })}\n`;
  try {
    fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true });
    for (let pass = 0; pass < ACQUIRE_MAX_PASSES; pass += 1) {
      try {
        fsImpl.writeFileSync(lockPath, text, { flag: 'wx' });
        return Object.freeze({ ok: true, lockPath, token });
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
      }
      const current = readLock(lockPath, now, fsImpl);
      if (!current.ok) {
        if (current.code === 'ENOENT') continue; // Released between our create and our read.
        return lockFailed(current.code);
      }
      if (current.ageMs <= RUN_LOCK_STALE_MS) return lockHeld(current.holder);
      const evicted = evictStaleLock(lockPath, current, now, fsImpl);
      if (evicted.step === 'done') return evicted.result;
    }
  } catch (err) {
    return lockFailed(describe(err));
  }
  return lockFailed(LOCK_CONTENDED);
}

/** Give the lock back. Only a file carrying our token is removed. */
export function releaseRunLock({ lockPath, token }) {
  const current = readLock(lockPath, Date.now());
  if (!current.ok) return current.code === 'ENOENT' ? { ok: true } : { ok: false, error: current.code };
  if (current.token !== token) return { ok: false, error: 'not ours' };
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
export async function runJob(job, { stateFile, now = Date.now, runner, log = () => {}, owner = OWNER_LOOP, pid }) {
  const lock = acquireRunLock(stateFile, { job, owner, pid, now: now() });
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

const busyLine = (holder) => `busy: ${holder.job || 'a job'} running since ${holder.startedAt || 'an unknown time'} (${holder.owner || 'unknown owner'}, pid ${holder.pid ?? 'unknown'})`;

/**
 * Start every job that is due, one after another. Each is checked again just
 * before it starts, because the job before it may have run for an hour and a
 * `--run-now` from another process may have covered the window meanwhile. A
 * job that finds the lock held stays due and is tried on the next tick.
 *
 * `shouldStop` is asked before every job: a stop that arrives while one job
 * runs must not be answered by starting the next. The job not started is not
 * stamped, so it is still due at the next start.
 */
export async function tick(deps) {
  const { stateFile, now = Date.now, log = () => {}, shouldStop = () => false } = deps;
  const results = [];
  if (shouldStop()) return results;
  for (const job of dueJobs(readState(stateFile, { report: log }), now())) {
    if (shouldStop()) break;
    if (!dueJobs(readState(stateFile), now()).includes(job)) continue;
    const result = await runJob(job, deps);
    if (result.busy) log(`${job}: waiting, ${busyLine(result.holder)}`);
    results.push(result);
  }
  return results;
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Tick, sleep, repeat until `shouldStop`. A tick that throws is logged and the
 * loop goes on. A stop that arrived during the tick ends the loop before the
 * sleep, not 30 seconds after it.
 */
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
    if (shouldStop()) break;
    await sleep(TICK_MS);
  }
  log('stopped');
}

/**
 * The real runner: spawn the job's command with this process's stdout and
 * stderr, and resolve with its exit code. The working directory is the home
 * directory and the script is named by its full path, the package's spawn rule
 * (lib/spawn.mjs). `onChild` hears the running child, then null when it ends.
 *
 * `spawn` has no default on purpose. This is the one function that turns a job
 * name into the real nightly or the real collector, and the only caller that
 * may do that is the process entry point, which passes node's own spawn. A
 * caller that forgets it gets an error, not a reconcile of the live vault.
 */
export function spawnRunner({ env, repoRoot = path.resolve(HERE, '..'), onChild = () => {}, spawn: spawnImpl } = {}) {
  if (typeof spawnImpl !== 'function') throw new Error('spawnRunner needs the spawn to use');
  return (job) => spawnJob(jobCommand(job, { repoRoot, node: process.execPath, env }), { env, onChild, spawn: spawnImpl });
}

const WINDOWS = 'win32';

/**
 * Start one job's command and resolve with its exit code.
 *
 * On POSIX the child is started `detached`, which makes it the leader of a new
 * process group. A job is a tree (bash, then node, git, uv, python), and a
 * signal sent to the child alone stops bash and leaves the rest running: a
 * `docker stop` would then wait out its grace period and SIGKILL a git in the
 * middle of its work. With a group, `signalJob` reaches all of them at once.
 * On Windows `detached` opens a console window and gives no group to signal,
 * so the child is started plainly; the scheduler's home is the Linux container.
 */
export function spawnJob({ command, args }, { env = process.env, onChild = () => {}, spawn: spawnImpl = spawn, platform = process.platform } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd: os.homedir(),
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
      detached: platform !== WINDOWS,
    });
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
 * Pass a stop signal to a running job: to its whole process group on POSIX (a
 * negative pid), to the child alone on Windows. A group that has already ended
 * (ESRCH) is not an error: the stop and the job's own exit can cross.
 */
export function signalJob(child, signal, { platform = process.platform, kill = (pid, sig) => process.kill(pid, sig) } = {}) {
  if (platform === WINDOWS) {
    child.kill(signal);
    return;
  }
  try {
    kill(-child.pid, signal);
  } catch (err) {
    if (err?.code !== 'ESRCH') throw err;
  }
}

/**
 * One invocation: `--run-now <job>` runs that job and returns its exit code;
 * no flag runs the loop until `shouldStop`. Everything that touches the clock,
 * the processes or the terminal is a parameter, for the tests.
 *
 * Jobs are run by `runner` when one is given, otherwise by the real commands
 * through `spawn`. With neither, nothing is started and the exit is 70: only
 * the entry point below passes node's spawn. The jobs' environment is `env`
 * with its secret files read in (`envWithSecretFiles`), so a process started
 * by `docker compose exec` runs them as the entrypoint's own child would.
 */
export async function main(argv, { env = process.env, out = console.log, err = console.error, runner, spawn: spawnImpl, onChild, ...overrides } = {}) {
  const parsed = parseArgs(argv, env);
  if (!parsed.ok) {
    err(`error: ${parsed.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (parsed.options.help) {
    out(USAGE);
    return EXIT_OK;
  }
  const secrets = envWithSecretFiles(env);
  if (!secrets.ok) {
    err(`error: ${secrets.problem}`);
    return EXIT_CONFIG;
  }
  if (typeof runner !== 'function' && typeof spawnImpl !== 'function') {
    err('error: no runner and no spawn were given, so no job can be started');
    return EXIT_INTERNAL;
  }
  const deps = {
    now: Date.now,
    log: (line) => out(`${new Date().toISOString()} scheduler: ${line}`),
    ...overrides,
    runner: runner ?? spawnRunner({ env: secrets.env, onChild, spawn: spawnImpl }),
    stateFile: parsed.options.stateFile,
  };

  const { runNow } = parsed.options;
  if (!runNow) {
    await runLoop(deps);
    return EXIT_OK;
  }
  const result = await runJob(runNow, { ...deps, owner: OWNER_RUN_NOW });
  if (result.ran) return result.exitCode;
  if (result.busy) {
    err(`${busyLine(result.holder)}; ${runNow} not started`);
    return EXIT_BUSY;
  }
  err(`error: ${runNow} not started (${result.error})`);
  return EXIT_INTERNAL;
}

/**
 * What a stop request (SIGTERM, SIGINT) changes, as four functions that share
 * one flag: `stop(signal)` passes the signal to the running job and wakes the
 * loop's sleep; `shouldStop()` is what `tick` and `runLoop` ask; `sleep(ms)`
 * is the loop's sleep; `onChild` is how the runner says which job is running.
 */
export function createStopper({ signalJob: signalRunning = signalJob } = {}) {
  let stopping = false;
  let child = null;
  let wake = () => {};
  return Object.freeze({
    stop(signal) {
      stopping = true;
      if (child) signalRunning(child, signal);
      wake();
    },
    shouldStop: () => stopping,
    sleep: (ms) => new Promise((resolve) => {
      if (stopping) {
        resolve(); // The stop came first: there is nothing left to wait for.
        return;
      }
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    }),
    onChild(running) {
      child = running;
    },
  });
}

/** SIGTERM and SIGINT: pass the signal to the running job, then let the loop end. */
function runAsProcess() {
  const stopper = createStopper();
  process.once('SIGTERM', () => stopper.stop('SIGTERM'));
  process.once('SIGINT', () => stopper.stop('SIGINT'));
  return main(process.argv.slice(2), { spawn, onChild: stopper.onChild, sleep: stopper.sleep, shouldStop: stopper.shouldStop });
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
