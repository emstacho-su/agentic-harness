/**
 * The container scheduler as a process (R-90, P-106): state on disk, the run
 * lock, and the tick that starts what is due.
 *
 * Every test works in a scratch state folder with a scripted clock and a
 * scripted runner, so nothing here starts the nightly reconcile or the
 * collector. The time rules themselves are in schedule.test.mjs.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EMPTY_STATE, JOB_COLLECT, JOB_NIGHTLY, serializeState, withStart } from '../lib/schedule.mjs';
import {
  DEFAULT_STATE_FILE,
  EXIT_BUSY,
  EXIT_OK,
  EXIT_SPAWN_FAILED,
  EXIT_USAGE,
  RUN_LOCK_FILENAME,
  RUN_LOCK_STALE_MS,
  STATE_ENV_VAR,
  TICK_MS,
  acquireRunLock,
  main,
  parseArgs,
  readState,
  releaseRunLock,
  runLoop,
  tick,
  writeStateAtomic,
} from '../scheduler.mjs';

const at = (iso) => Date.parse(iso);
const HOST = 'jobs-container';
const DEAD_PID = 999_999;

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, stateFile: path.join(root, 'scheduler.json'), lockPath: path.join(root, RUN_LOCK_FILENAME) };
}

/** A state in which both jobs last started at `iso`. */
function bothRanAt(iso) {
  const run = { startedAtMs: at(iso), windowMs: at(iso) };
  return withStart(withStart(EMPTY_STATE, JOB_NIGHTLY, run), JOB_COLLECT, run);
}

/** A runner that records each job it is asked to run and exits with `code`. */
function recordingRunner(code = 0) {
  const ran = [];
  const runner = async (job) => {
    ran.push(job);
    return code;
  };
  return { ran, runner };
}

/** Dependencies for `tick` and `main`: a fixed clock, a quiet log, one host. */
function deps(s, now, extra = {}) {
  return { stateFile: s.stateFile, now: () => at(now), log: () => {}, host: HOST, pid: process.pid, ...extra };
}

const stateOnDisk = (s) => JSON.parse(fs.readFileSync(s.stateFile, 'utf8'));

test('the defaults are the contract: /state/scheduler.json, a 30 s tick', () => {
  assert.equal(DEFAULT_STATE_FILE, '/state/scheduler.json');
  assert.equal(STATE_ENV_VAR, 'HARNESS_SCHEDULER_STATE');
  assert.equal(TICK_MS, 30_000);
  assert.equal(RUN_LOCK_FILENAME, 'scheduler.lock');
});

test('parseArgs reads --run-now and --state, and refuses anything else', () => {
  assert.deepEqual(parseArgs([], {}), { ok: true, options: { stateFile: DEFAULT_STATE_FILE, runNow: '', help: false } });
  assert.equal(parseArgs([], { [STATE_ENV_VAR]: '/tmp/s.json' }).options.stateFile, '/tmp/s.json');
  assert.equal(parseArgs(['--state', '/x/s.json'], { [STATE_ENV_VAR]: '/tmp/s.json' }).options.stateFile, '/x/s.json');
  assert.equal(parseArgs(['--run-now', 'nightly'], {}).options.runNow, 'nightly');
  assert.equal(parseArgs(['--run-now', 'collect'], {}).options.runNow, 'collect');
  assert.match(parseArgs(['--run-now', 'weekly'], {}).error, /nightly\|collect/);
  assert.match(parseArgs(['--run-now'], {}).error, /needs a value/);
  assert.match(parseArgs(['--state'], {}).error, /needs a value/);
  assert.match(parseArgs(['--nightly'], {}).error, /unknown argument/);
});

test('the state is written to a temporary file and renamed into place', (t) => {
  const s = scratch(t);
  const calls = [];
  const recordingFs = {
    ...fs,
    writeFileSync: (file, ...rest) => { calls.push(['write', path.basename(file)]); return fs.writeFileSync(file, ...rest); },
    renameSync: (from, to) => { calls.push(['rename', path.basename(from), path.basename(to)]); return fs.renameSync(from, to); },
  };
  const state = bothRanAt('2026-10-31T07:00:00.000Z');
  writeStateAtomic(s.stateFile, state, { fsImpl: recordingFs });

  assert.equal(calls.length, 2);
  const [write, rename] = calls;
  assert.equal(write[0], 'write');
  assert.notEqual(write[1], 'scheduler.json', 'the first write never goes to the state file itself');
  assert.deepEqual(rename, ['rename', write[1], 'scheduler.json']);
  assert.deepEqual(fs.readdirSync(s.root), ['scheduler.json'], 'no temporary file is left');
  assert.deepEqual(readState(s.stateFile), state);
});

test('a write that cannot be renamed leaves the old state whole and no temporary file', (t) => {
  const s = scratch(t);
  const old = bothRanAt('2026-10-30T07:00:00.000Z');
  writeStateAtomic(s.stateFile, old);
  const failingFs = { ...fs, renameSync: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } };

  assert.throws(() => writeStateAtomic(s.stateFile, bothRanAt('2026-10-31T07:00:00.000Z'), { fsImpl: failingFs }), /EBUSY|busy/);
  assert.deepEqual(readState(s.stateFile), old);
  assert.deepEqual(fs.readdirSync(s.root), ['scheduler.json']);
});

test('a missing state reads as empty; a corrupt one is reported and reads as empty', (t) => {
  const s = scratch(t);
  assert.deepEqual(readState(s.stateFile), EMPTY_STATE);
  fs.writeFileSync(s.stateFile, '{"jobs":');
  const reports = [];
  assert.deepEqual(readState(s.stateFile, { report: (line) => reports.push(line) }), EMPTY_STATE);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /scheduler\.json/);
});

test('a missed window runs once at start', async (t) => {
  const s = scratch(t);
  writeStateAtomic(s.stateFile, withStart(bothRanAt('2026-10-31T12:59:00.000Z'), JOB_NIGHTLY, {
    startedAtMs: at('2026-10-30T07:00:03.000Z'),
    windowMs: at('2026-10-30T07:00:00.000Z'),
  }));
  const { ran, runner } = recordingRunner();

  const results = await tick(deps(s, '2026-10-31T13:00:00.000Z', { runner }));

  assert.deepEqual(ran, ['nightly']);
  assert.deepEqual(results, [{ job: 'nightly', ran: true, exitCode: 0 }]);
  assert.deepEqual(stateOnDisk(s).jobs.nightly, {
    last_run_at: '2026-10-31T13:00:00.000Z',
    window: '2026-10-31T07:00:00.000Z',
    finished_at: '2026-10-31T13:00:00.000Z',
    exit_code: 0,
  });
});

test('two missed windows also run once, and the next tick runs nothing', async (t) => {
  const s = scratch(t);
  writeStateAtomic(s.stateFile, withStart(bothRanAt('2026-10-31T12:59:00.000Z'), JOB_NIGHTLY, {
    startedAtMs: at('2026-10-28T07:00:03.000Z'),
    windowMs: at('2026-10-28T07:00:00.000Z'),
  }));
  const { ran, runner } = recordingRunner();

  await tick(deps(s, '2026-10-31T13:00:00.000Z', { runner }));
  await tick(deps(s, '2026-10-31T13:00:30.000Z', { runner }));

  assert.deepEqual(ran, ['nightly'], 'three missed nights are one catch-up run');
});

test('last_run_at is on disk before the job starts', async (t) => {
  const s = scratch(t);
  writeStateAtomic(s.stateFile, bothRanAt('2026-10-30T22:30:00.000Z'));
  let seen = null;
  const runner = async () => {
    seen = stateOnDisk(s).jobs.nightly;
    return 0;
  };

  await tick(deps(s, '2026-10-31T07:00:10.000Z', { runner }));

  assert.deepEqual(seen, {
    last_run_at: '2026-10-31T07:00:10.000Z',
    window: '2026-10-31T07:00:00.000Z',
    finished_at: null,
    exit_code: null,
  });
});

test('a restart mid-run never runs it twice', async (t) => {
  const s = scratch(t);
  // What a scheduler killed inside the nightly leaves on disk: the lock it took
  // and the last_run_at it wrote before starting the job, with no finish.
  const startedAtMs = at('2026-10-31T07:00:10.000Z');
  const dead = acquireRunLock(s.stateFile, { job: JOB_NIGHTLY, pid: DEAD_PID, host: HOST, now: startedAtMs, isAlive: () => true });
  assert.equal(dead.ok, true);
  writeStateAtomic(s.stateFile, withStart(bothRanAt('2026-10-30T22:30:00.000Z'), JOB_NIGHTLY, {
    startedAtMs,
    windowMs: at('2026-10-31T07:00:00.000Z'),
  }));
  assert.equal(stateOnDisk(s).jobs.nightly.finished_at, null);

  // The restarted scheduler, minutes later, inside the same window.
  const { ran, runner } = recordingRunner();
  const results = await tick(deps(s, '2026-10-31T07:05:00.000Z', { runner, isAlive: () => false }));

  assert.deepEqual(ran, [], 'the interrupted nightly is not started again');
  assert.deepEqual(results, []);

  // The dead lock does not block the next job that comes due.
  const later = await tick(deps(s, '2026-10-31T16:00:00.000Z', { runner, isAlive: () => false }));
  assert.deepEqual(ran, ['collect']);
  assert.equal(later[0].ran, true);
  assert.ok(!fs.existsSync(s.lockPath), 'the lock is released after the run');
});

test('a runner that cannot start is recorded and never thrown', async (t) => {
  const s = scratch(t);
  writeStateAtomic(s.stateFile, bothRanAt('2026-10-30T22:30:00.000Z'));
  const lines = [];

  const results = await tick(deps(s, '2026-10-31T07:00:10.000Z', {
    runner: async () => { throw new Error('spawn bash ENOENT'); },
    log: (line) => lines.push(line),
  }));

  assert.deepEqual(results, [{ job: 'nightly', ran: true, exitCode: EXIT_SPAWN_FAILED }]);
  assert.equal(stateOnDisk(s).jobs.nightly.exit_code, EXIT_SPAWN_FAILED);
  assert.ok(lines.some((line) => /spawn bash ENOENT/.test(line)));
  assert.ok(!fs.existsSync(s.lockPath));
});

test('nightly and collect never overlap: the second starts after the first has ended', async (t) => {
  const s = scratch(t);
  const events = [];
  let releaseNightly;
  const nightlyDone = new Promise((resolve) => { releaseNightly = resolve; });
  const runner = async (job) => {
    events.push(`start ${job}`);
    if (job === 'nightly') await nightlyDone;
    events.push(`end ${job}`);
    return 0;
  };

  const running = tick(deps(s, '2026-10-31T16:00:00.000Z', { runner }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['start nightly'], 'collect waits while nightly runs');
  assert.equal(JSON.parse(fs.readFileSync(s.lockPath, 'utf8')).job, 'nightly');

  // A second process asked to run collect right now stands down instead of overlapping.
  const second = recordingRunner();
  const lines = [];
  const code = await main(['--run-now', 'collect', '--state', s.stateFile], {
    ...deps(s, '2026-10-31T16:00:05.000Z', { runner: second.runner, isAlive: () => true, pid: process.pid + 1 }),
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    env: {},
  });
  assert.equal(code, EXIT_BUSY);
  assert.deepEqual(second.ran, []);
  assert.ok(lines.some((line) => /busy: nightly/.test(line)), lines.join('\n'));
  assert.equal(stateOnDisk(s).jobs.collect, undefined, 'a refused run stamps nothing');

  releaseNightly();
  await running;
  assert.deepEqual(events, ['start nightly', 'end nightly', 'start collect', 'end collect']);
  assert.ok(!fs.existsSync(s.lockPath));
});

test('--run-now runs the job whether or not it is due and returns its exit code', async (t) => {
  const s = scratch(t);
  writeStateAtomic(s.stateFile, bothRanAt('2026-10-31T07:00:10.000Z'));
  const { ran, runner } = recordingRunner(4);

  const code = await main(['--run-now', 'nightly', '--state', s.stateFile], {
    ...deps(s, '2026-10-31T09:00:00.000Z', { runner }),
    out: () => {},
    err: () => {},
    env: {},
  });

  assert.equal(code, 4);
  assert.deepEqual(ran, ['nightly']);
  const record = stateOnDisk(s).jobs.nightly;
  assert.equal(record.last_run_at, '2026-10-31T09:00:00.000Z');
  assert.equal(record.window, '2026-10-31T07:00:00.000Z');
  assert.equal(record.exit_code, 4);
});

test('a bad argument is exit 64 with the usage, and nothing runs', async (t) => {
  const s = scratch(t);
  const { ran, runner } = recordingRunner();
  const lines = [];
  const code = await main(['--run-now', 'weekly'], { ...deps(s, '2026-10-31T09:00:00.000Z', { runner }), out: () => {}, err: (line) => lines.push(line), env: {} });
  assert.equal(code, EXIT_USAGE);
  assert.deepEqual(ran, []);
  assert.match(lines.join('\n'), /usage: node hooks\/scheduler\.mjs/);
  assert.ok(!fs.existsSync(s.stateFile));
});

test('the run lock: a live holder keeps it, a dead or too-old one is taken over', (t) => {
  const s = scratch(t);
  const now = at('2026-10-31T07:00:00.000Z');
  const first = acquireRunLock(s.stateFile, { job: 'nightly', pid: 41, host: HOST, now, isAlive: () => true });
  assert.equal(first.ok, true);
  assert.equal(first.lockPath, s.lockPath);

  const held = acquireRunLock(s.stateFile, { job: 'collect', pid: 42, host: HOST, now: now + 60_000, isAlive: () => true });
  assert.equal(held.ok, false);
  assert.equal(held.holder.job, 'nightly');
  assert.equal(held.holder.pid, 41);

  const overDead = acquireRunLock(s.stateFile, { job: 'collect', pid: 42, host: HOST, now: now + 60_000, isAlive: () => false });
  assert.equal(overDead.ok, true, 'a holder whose process is gone is taken over');
  assert.equal(JSON.parse(fs.readFileSync(s.lockPath, 'utf8')).job, 'collect');

  const otherHost = acquireRunLock(s.stateFile, { job: 'nightly', pid: 7, host: 'another-container', now: now + 120_000, isAlive: () => false });
  assert.equal(otherHost.ok, false, 'a holder on another host cannot be probed, so only its age counts');

  const tooOld = acquireRunLock(s.stateFile, { job: 'nightly', pid: 7, host: 'another-container', now: now + 60_000 + RUN_LOCK_STALE_MS + 1, isAlive: () => true });
  assert.equal(tooOld.ok, true, 'past the stale window any holder is taken over');

  const samePid = acquireRunLock(s.stateFile, { job: 'collect', pid: 7, host: 'another-container', now: now + 60_000 + RUN_LOCK_STALE_MS + 2, isAlive: () => true });
  assert.equal(samePid.ok, true, 'a lock naming this very process was left by a previous life of the container');
});

test('release removes only a lock carrying our token', (t) => {
  const s = scratch(t);
  const now = at('2026-10-31T07:00:00.000Z');
  const ours = acquireRunLock(s.stateFile, { job: 'nightly', pid: 41, host: HOST, now, isAlive: () => true });
  assert.deepEqual(releaseRunLock({ lockPath: ours.lockPath, token: 'someone-else' }), { ok: false, error: 'not ours' });
  assert.ok(fs.existsSync(s.lockPath));
  assert.deepEqual(releaseRunLock(ours), { ok: true });
  assert.ok(!fs.existsSync(s.lockPath));
  assert.deepEqual(releaseRunLock(ours), { ok: true }, 'releasing twice is not an error');
});

test('the loop catches up after a sleep: the clock jumps past 03:00 and nightly runs once', async (t) => {
  const s = scratch(t);
  writeStateAtomic(s.stateFile, bothRanAt('2026-10-30T22:30:00.000Z'));
  // 22:31 New York, lid closed; the next tick the process sees is 09:00, then 09:00:30.
  const clock = ['2026-10-31T02:31:00.000Z', '2026-10-31T13:00:00.000Z', '2026-10-31T13:00:30.000Z'].map(at);
  let reads = 0;
  const sleeps = [];
  const { ran, runner } = recordingRunner();

  await runLoop({
    ...deps(s, '2026-10-31T02:31:00.000Z', { runner }),
    now: () => clock[Math.min(reads, clock.length - 1)],
    sleep: async (ms) => { sleeps.push(ms); reads += 1; },
    shouldStop: () => reads >= clock.length,
  });

  assert.deepEqual(ran, ['nightly']);
  assert.deepEqual(sleeps, [TICK_MS, TICK_MS, TICK_MS]);
  assert.equal(stateOnDisk(s).jobs.nightly.window, '2026-10-31T07:00:00.000Z');
});

test('the state file the scheduler writes is the one schedule.mjs serializes', (t) => {
  const s = scratch(t);
  const state = bothRanAt('2026-10-31T07:00:00.000Z');
  writeStateAtomic(s.stateFile, state);
  assert.equal(fs.readFileSync(s.stateFile, 'utf8'), serializeState(state));
});
