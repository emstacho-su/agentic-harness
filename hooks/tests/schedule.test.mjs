/**
 * The container scheduler's clock and its "is this job due" rule (R-90).
 *
 * Everything here is pure: wall-clock times in America/New_York become UTC
 * instants, a job is due when a window has opened since its last start, and a
 * state value is never changed in place. The process that acts on these
 * answers is `scheduler.mjs`, tested in scheduler.test.mjs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_STATE,
  JOBS_CONTAINER_VAR,
  JOB_COLLECT,
  JOB_NAMES,
  JOB_NIGHTLY,
  SCHEDULE,
  SCHEDULE_TIME_ZONE,
  STATE_SCHEMA_VERSION,
  dueJobs,
  jobCommand,
  latestWindowMs,
  nextWindowMs,
  parseState,
  serializeState,
  wallClockToUtcMs,
  withFinish,
  withStart,
} from '../lib/schedule.mjs';

const at = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString();
const NIGHTLY = SCHEDULE[JOB_NIGHTLY];
const COLLECT = SCHEDULE[JOB_COLLECT];

test('the schedule is nightly 03:00 and collect 12:00 and 18:00, New York time', () => {
  assert.equal(SCHEDULE_TIME_ZONE, 'America/New_York');
  assert.deepEqual([...JOB_NAMES], ['nightly', 'collect']);
  assert.deepEqual([...NIGHTLY], ['03:00']);
  assert.deepEqual([...COLLECT], ['12:00', '18:00']);
  assert.ok(Object.isFrozen(SCHEDULE) && Object.isFrozen(NIGHTLY) && Object.isFrozen(COLLECT));
});

test('03:00 New York is 07:00Z in daylight time and 08:00Z in standard time', () => {
  const nightlyOn = (year, month, day) => iso(wallClockToUtcMs({ year, month, day }, '03:00', SCHEDULE_TIME_ZONE));
  assert.equal(nightlyOn(2026, 10, 31), '2026-10-31T07:00:00.000Z', 'the last night of daylight time');
  assert.equal(nightlyOn(2026, 11, 1), '2026-11-01T08:00:00.000Z', 'the night the clocks go back');
  assert.equal(nightlyOn(2027, 3, 13), '2027-03-13T08:00:00.000Z', 'the last night of standard time');
  assert.equal(nightlyOn(2027, 3, 14), '2027-03-14T07:00:00.000Z', 'the night the clocks go forward');
});

test('a wall-clock time the spring change skips is pushed past the gap by its length', () => {
  // 02:30 does not exist on 2027-03-14: the clock reads 01:59 EST, then 03:00 EDT. It becomes 03:30 EDT.
  const skipped = wallClockToUtcMs({ year: 2027, month: 3, day: 14 }, '02:30', SCHEDULE_TIME_ZONE);
  assert.equal(iso(skipped), '2027-03-14T07:30:00.000Z');
});

test('wallClockToUtcMs refuses a time that is not HH:MM', () => {
  const date = { year: 2026, month: 10, day: 31 };
  for (const bad of ['3:00', '24:00', '03:60', '0300', '', 'noon']) {
    assert.throws(() => wallClockToUtcMs(date, bad, SCHEDULE_TIME_ZONE), /HH:MM/, bad);
  }
});

test('the latest window is the most recent start at or before now, across midnight and DST', () => {
  const latest = (times, now) => iso(latestWindowMs(times, at(now), SCHEDULE_TIME_ZONE));
  assert.equal(latest(NIGHTLY, '2026-10-31T07:00:00.000Z'), '2026-10-31T07:00:00.000Z', 'exactly at the window');
  assert.equal(latest(NIGHTLY, '2026-10-31T06:59:59.000Z'), '2026-10-30T07:00:00.000Z', 'one second before it');
  assert.equal(latest(NIGHTLY, '2026-11-01T07:30:00.000Z'), '2026-10-31T07:00:00.000Z', '02:30 EST after the fall change: not yet 03:00');
  assert.equal(latest(NIGHTLY, '2026-11-01T08:00:00.000Z'), '2026-11-01T08:00:00.000Z');
  assert.equal(latest(NIGHTLY, '2027-03-14T07:00:00.000Z'), '2027-03-14T07:00:00.000Z');
  assert.equal(latest(COLLECT, '2026-10-31T15:59:00.000Z'), '2026-10-30T22:00:00.000Z', 'before noon: yesterday 18:00');
  assert.equal(latest(COLLECT, '2026-10-31T16:00:00.000Z'), '2026-10-31T16:00:00.000Z', 'noon');
  assert.equal(latest(COLLECT, '2026-10-31T23:00:00.000Z'), '2026-10-31T22:00:00.000Z', '18:00');
});

test('the next window is the first start after now', () => {
  const next = (times, now) => iso(nextWindowMs(times, at(now), SCHEDULE_TIME_ZONE));
  assert.equal(next(NIGHTLY, '2026-10-31T07:00:00.000Z'), '2026-11-01T08:00:00.000Z', 'at the window: the following night, in standard time');
  assert.equal(next(NIGHTLY, '2027-03-13T09:00:00.000Z'), '2027-03-14T07:00:00.000Z');
  assert.equal(next(COLLECT, '2026-10-31T16:00:00.000Z'), '2026-10-31T22:00:00.000Z');
  assert.equal(next(COLLECT, '2026-10-31T23:00:00.000Z'), '2026-11-01T17:00:00.000Z', 'noon EST the next day');
});

test('with no state every job is due once, nightly first', () => {
  assert.deepEqual(dueJobs(EMPTY_STATE, at('2026-10-31T12:00:00.000Z')), ['nightly', 'collect']);
});

test('a missed window runs once at start, and two missed windows also run once', () => {
  const ranOn = (lastRunAt) => withStart(EMPTY_STATE, JOB_NIGHTLY, { startedAtMs: at(lastRunAt), windowMs: at(lastRunAt) });
  const now = at('2026-10-31T13:00:00.000Z'); // 09:00 New York: the lid opens

  const oneMissed = withStart(ranOn('2026-10-30T07:00:05.000Z'), JOB_COLLECT, { startedAtMs: now, windowMs: now });
  assert.deepEqual(dueJobs(oneMissed, now), ['nightly'], 'last night was missed');

  const twoMissed = withStart(ranOn('2026-10-29T07:00:05.000Z'), JOB_COLLECT, { startedAtMs: now, windowMs: now });
  assert.deepEqual(dueJobs(twoMissed, now), ['nightly'], 'two nights were missed: still one entry');

  const caughtUp = withStart(twoMissed, JOB_NIGHTLY, { startedAtMs: now, windowMs: at('2026-10-31T07:00:00.000Z') });
  assert.deepEqual(dueJobs(caughtUp, now), [], 'once started, the same windows are not due again');
  assert.deepEqual(dueJobs(caughtUp, at('2026-11-01T07:59:59.000Z')), ['collect'], 'still not due a second before the next night');
  assert.deepEqual(dueJobs(caughtUp, at('2026-11-01T08:00:00.000Z')), ['nightly', 'collect'], 'due again at the next 03:00');
});

test('a job started inside its window is not due again until the next one', () => {
  const state = withStart(EMPTY_STATE, JOB_COLLECT, { startedAtMs: at('2026-10-31T16:00:01.000Z'), windowMs: at('2026-10-31T16:00:00.000Z') });
  assert.ok(!dueJobs(state, at('2026-10-31T21:59:59.000Z')).includes('collect'));
  assert.ok(dueJobs(state, at('2026-10-31T22:00:00.000Z')).includes('collect'), '18:00 is a new window');
});

test('withStart and withFinish return new frozen states and leave the old one alone', () => {
  const started = withStart(EMPTY_STATE, JOB_NIGHTLY, { startedAtMs: at('2026-10-31T07:00:02.000Z'), windowMs: at('2026-10-31T07:00:00.000Z') });
  assert.deepEqual(EMPTY_STATE.jobs, {}, 'the empty state is untouched');
  assert.ok(Object.isFrozen(started) && Object.isFrozen(started.jobs) && Object.isFrozen(started.jobs.nightly));
  assert.deepEqual(started.jobs.nightly, {
    last_run_at: '2026-10-31T07:00:02.000Z',
    window: '2026-10-31T07:00:00.000Z',
    finished_at: null,
    exit_code: null,
  });

  const finished = withFinish(started, JOB_NIGHTLY, { finishedAtMs: at('2026-10-31T07:09:00.000Z'), exitCode: 0 });
  assert.equal(started.jobs.nightly.finished_at, null, 'the started state is untouched');
  assert.equal(finished.jobs.nightly.finished_at, '2026-10-31T07:09:00.000Z');
  assert.equal(finished.jobs.nightly.exit_code, 0);
  assert.equal(finished.jobs.nightly.last_run_at, '2026-10-31T07:00:02.000Z');
  assert.throws(() => withStart(EMPTY_STATE, 'weekly', { startedAtMs: 0, windowMs: 0 }), /unknown job/);
});

test('a state survives serialize and parse, and carries its schema version', () => {
  const state = withStart(EMPTY_STATE, JOB_NIGHTLY, { startedAtMs: at('2026-10-31T07:00:02.000Z'), windowMs: at('2026-10-31T07:00:00.000Z') });
  const text = serializeState(state);
  assert.ok(text.endsWith('\n'));
  assert.equal(JSON.parse(text).schema_version, STATE_SCHEMA_VERSION);
  const parsed = parseState(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.state, state);
});

test('an unreadable state is reported and read as empty; unknown jobs and bad dates are dropped', () => {
  for (const bad of ['', '{', '[]', '"x"', 'null', '{"jobs": 3}']) {
    const parsed = parseState(bad);
    assert.equal(parsed.ok, false, JSON.stringify(bad));
    assert.deepEqual(parsed.state, EMPTY_STATE);
    assert.ok(parsed.problem.length > 0);
  }
  const mixed = parseState(JSON.stringify({
    schema_version: 1,
    jobs: {
      nightly: { last_run_at: 'yesterday', window: null },
      collect: { last_run_at: '2026-10-31T16:00:01.000Z', window: '2026-10-31T16:00:00.000Z', finished_at: null, exit_code: null },
      weekly: { last_run_at: '2026-10-31T16:00:01.000Z' },
    },
  }));
  assert.equal(mixed.ok, true);
  assert.deepEqual(Object.keys(mixed.state.jobs), ['collect']);
});

test('nightly runs the reconcile script; collect runs the collector with the listed repos and authors', () => {
  const repoRoot = '/app';
  const node = '/usr/local/bin/node';
  assert.deepEqual(jobCommand(JOB_NIGHTLY, { repoRoot, node, env: {} }), {
    command: 'bash',
    args: ['/app/scripts/nightly-ingest.sh'],
  });
  assert.deepEqual(jobCommand(JOB_COLLECT, { repoRoot, node, env: {} }), {
    command: node,
    args: ['/app/hooks/collect-checkpoints.mjs', '--ingest'],
  });
  const env = { HARNESS_CHECKPOINT_REPOS: '/repos/agentic-harness, /repos/bb2dash,', HARNESS_CHECKPOINT_AUTHORS: 'a@example.com,b@example.com' };
  assert.deepEqual(jobCommand(JOB_COLLECT, { repoRoot, node, env }).args, [
    '/app/hooks/collect-checkpoints.mjs',
    '--ingest',
    '--repo', '/repos/agentic-harness',
    '--repo', '/repos/bb2dash',
    '--author', 'a@example.com',
    '--author', 'b@example.com',
  ]);
  assert.throws(() => jobCommand('weekly', { repoRoot, node, env: {} }), /unknown job/);
});

test('in the jobs container collect is skipped when no repository is listed, and runs when one is', () => {
  const context = (env) => ({ repoRoot: '/app', node: '/usr/local/bin/node', env });
  assert.equal(JOBS_CONTAINER_VAR, 'HARNESS_JOBS_CONTAINER');

  assert.deepEqual(jobCommand(JOB_COLLECT, context({ HARNESS_JOBS_CONTAINER: '1' })), {
    skip: 'skipped in the jobs container (HARNESS_CHECKPOINT_REPOS is not set)',
  });
  assert.deepEqual(jobCommand(JOB_COLLECT, context({ HARNESS_JOBS_CONTAINER: '1', HARNESS_CHECKPOINT_REPOS: ' , ' })), {
    skip: 'skipped in the jobs container (HARNESS_CHECKPOINT_REPOS is not set)',
  }, 'a list with no entry in it is not a list');
  assert.deepEqual(jobCommand(JOB_COLLECT, context({ HARNESS_JOBS_CONTAINER: '1', HARNESS_CHECKPOINT_REPOS: '/repos/bb2dash' })).args, [
    '/app/hooks/collect-checkpoints.mjs', '--ingest', '--repo', '/repos/bb2dash',
  ]);
  assert.deepEqual(jobCommand(JOB_COLLECT, context({ HARNESS_JOBS_CONTAINER: '0' })).args, ['/app/hooks/collect-checkpoints.mjs', '--ingest'],
    'on a host the collector keeps its own default repositories');
  assert.equal(jobCommand(JOB_NIGHTLY, context({ HARNESS_JOBS_CONTAINER: '1' })).command, 'bash', 'the nightly decides its own steps');
});
