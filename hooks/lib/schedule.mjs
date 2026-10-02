/**
 * The container scheduler's rules, with no I/O (R-90).
 *
 * Two jobs, on New York wall-clock time: `nightly` at 03:00 and `collect` at
 * 12:00 and 18:00, the times the two Windows scheduled tasks use. Each time is
 * the start of a window that stays open until the job's next time. A job is
 * due when a window has opened since it last started, so:
 *
 *   - a laptop asleep at 03:00 runs the nightly when it wakes (catch-up);
 *   - three nights asleep are one run, not three, because only the latest
 *     window is ever compared;
 *   - a job that was started in a window is not started again in it, whatever
 *     happened to that run. `last_run_at` is the start, written before the job
 *     runs, which is what makes a restart mid-run safe.
 *
 * There is no cron library on purpose. node-cron's `missedExecutionTolerance`
 * is drift tolerance (how late a tick may fire and still count), not catch-up:
 * a run missed while the process was frozen is dropped (P-106). Comparing the
 * wall clock with a stored timestamp needs nothing but `Intl`.
 *
 * `scheduler.mjs` owns the state file, the lock and the child processes.
 */

export const SCHEDULE_TIME_ZONE = 'America/New_York';

export const JOB_NIGHTLY = 'nightly';
export const JOB_COLLECT = 'collect';

/** In start order: when both are due, the nightly goes first (it collects too). */
export const JOB_NAMES = Object.freeze([JOB_NIGHTLY, JOB_COLLECT]);

/** Window starts per job, `HH:MM` in SCHEDULE_TIME_ZONE. */
export const SCHEDULE = Object.freeze({
  [JOB_NIGHTLY]: Object.freeze(['03:00']),
  [JOB_COLLECT]: Object.freeze(['12:00', '18:00']),
});

export const STATE_SCHEMA_VERSION = 1;

/** No job has ever started. Frozen: states are replaced, never edited. */
export const EMPTY_STATE = Object.freeze({ schema_version: STATE_SCHEMA_VERSION, jobs: Object.freeze({}) });

/** Comma-separated checkout paths the collector fetches; unset means its own defaults. */
export const CHECKPOINT_REPOS_VAR = 'HARNESS_CHECKPOINT_REPOS';
/** Comma-separated author emails the collector accepts; unset means any author. */
export const CHECKPOINT_AUTHORS_VAR = 'HARNESS_CHECKPOINT_AUTHORS';

const WALL_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A window can start today, yesterday or (across a DST change) the day before. */
const DAYS_BACK = Object.freeze([0, -1, -2]);
/** The next window starts today, tomorrow or the day after. */
const DAYS_AHEAD = Object.freeze([0, 1, 2]);

const formatters = new Map();

/** One cached formatter per zone: building one costs more than using it. */
function formatterFor(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }));
  }
  return formatters.get(timeZone);
}

/** The wall clock in `timeZone` at the instant `utcMs`, as numbers. */
function zonedParts(utcMs, timeZone) {
  const parts = Object.fromEntries(
    formatterFor(timeZone).formatToParts(new Date(utcMs)).map((part) => [part.type, Number(part.value)]),
  );
  return Object.freeze({ year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second });
}

/** How far `timeZone` is ahead of UTC at `utcMs`, in ms (negative in New York). */
function zoneOffsetMs(utcMs, timeZone) {
  const p = zonedParts(utcMs, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The UTC instant at which `timeZone`'s clock reads `time` on `date`.
 *
 * The offset is looked up at a first guess and again at the answer, because
 * the two differ on the day the clocks change. A time the spring change skips
 * (02:30 on that night) never appears on the clock; it is pushed past the gap
 * by the gap's length (03:30 daylight time), as java.time and Temporal do.
 *
 * @param {{year: number, month: number, day: number}} date  calendar date in `timeZone`, month 1-12
 * @param {string} time  `HH:MM`, 24-hour
 */
export function wallClockToUtcMs(date, time, timeZone) {
  const match = WALL_CLOCK.exec(String(time));
  if (!match) throw new Error(`'${time}' is not an HH:MM time`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const asIfUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const firstGuess = asIfUtc - zoneOffsetMs(asIfUtc, timeZone);
  const answer = asIfUtc - zoneOffsetMs(firstGuess, timeZone);
  const shown = zonedParts(answer, timeZone);
  return shown.hour === hour && shown.minute === minute ? answer : firstGuess;
}

/** The calendar date `days` after `date` (days may be negative). */
function shiftDate(date, days) {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * DAY_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** Every window start of `times` on the days `offsets` away from today in `timeZone`. */
function windowsAround(times, nowMs, timeZone, offsets) {
  const today = zonedParts(nowMs, timeZone);
  return offsets.flatMap((days) => times.map((time) => wallClockToUtcMs(shiftDate(today, days), time, timeZone)));
}

/** The most recent window start at or before `nowMs`. */
export function latestWindowMs(times, nowMs, timeZone = SCHEDULE_TIME_ZONE) {
  return Math.max(...windowsAround(times, nowMs, timeZone, DAYS_BACK).filter((start) => start <= nowMs));
}

/** The first window start after `nowMs`. */
export function nextWindowMs(times, nowMs, timeZone = SCHEDULE_TIME_ZONE) {
  return Math.min(...windowsAround(times, nowMs, timeZone, DAYS_AHEAD).filter((start) => start > nowMs));
}

function assertJob(job) {
  if (!JOB_NAMES.includes(job)) throw new Error(`unknown job '${job}' (${JOB_NAMES.join('|')})`);
}

/**
 * The jobs to start now, in JOB_NAMES order: those with no recorded start, or
 * whose latest window opened after their last start.
 */
export function dueJobs(state, nowMs) {
  return JOB_NAMES.filter((job) => {
    const lastRunMs = Date.parse(state.jobs[job]?.last_run_at ?? '');
    return !Number.isFinite(lastRunMs) || latestWindowMs(SCHEDULE[job], nowMs) > lastRunMs;
  });
}

function withJob(state, job, record) {
  return Object.freeze({
    schema_version: STATE_SCHEMA_VERSION,
    jobs: Object.freeze({ ...state.jobs, [job]: Object.freeze(record) }),
  });
}

/** A new state in which `job` started at `startedAtMs` for the window `windowMs`. */
export function withStart(state, job, { startedAtMs, windowMs }) {
  assertJob(job);
  return withJob(state, job, {
    last_run_at: new Date(startedAtMs).toISOString(),
    window: new Date(windowMs).toISOString(),
    finished_at: null,
    exit_code: null,
  });
}

/** A new state in which `job`'s recorded run ended at `finishedAtMs` with `exitCode`. */
export function withFinish(state, job, { finishedAtMs, exitCode }) {
  assertJob(job);
  return withJob(state, job, {
    ...state.jobs[job],
    finished_at: new Date(finishedAtMs).toISOString(),
    exit_code: Number.isInteger(exitCode) ? exitCode : null,
  });
}

/** The state file's text: stable key order, one trailing newline. */
export function serializeState(state) {
  return `${JSON.stringify({ schema_version: STATE_SCHEMA_VERSION, jobs: state.jobs }, null, 2)}\n`;
}

const isoOrNull = (value) => (Number.isFinite(Date.parse(value ?? '')) ? new Date(Date.parse(value)).toISOString() : null);

/**
 * Read a state file's text. `{ ok, state, problem }`: text that is not a state
 * object reads as EMPTY_STATE with the reason, so a damaged file means "run
 * what is due", never "run nothing ever again". Inside a good file, a job this
 * version does not know, or a record without a usable `last_run_at`, is dropped.
 */
export function parseState(text) {
  const unreadable = (problem) => Object.freeze({ ok: false, state: EMPTY_STATE, problem });
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    return unreadable(`not JSON (${err.message})`);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return unreadable('not a JSON object');
  const jobs = body.jobs;
  if (jobs === null || typeof jobs !== 'object' || Array.isArray(jobs)) return unreadable("no 'jobs' object");

  const kept = {};
  for (const job of JOB_NAMES) {
    const lastRunAt = isoOrNull(jobs[job]?.last_run_at);
    if (lastRunAt === null) continue;
    kept[job] = Object.freeze({
      last_run_at: lastRunAt,
      window: isoOrNull(jobs[job].window),
      finished_at: isoOrNull(jobs[job].finished_at),
      exit_code: Number.isInteger(jobs[job].exit_code) ? jobs[job].exit_code : null,
    });
  }
  const state = Object.freeze({ schema_version: STATE_SCHEMA_VERSION, jobs: Object.freeze(kept) });
  return Object.freeze({ ok: true, state, problem: '' });
}

/** A comma-separated setting as its non-empty, trimmed entries. */
function listSetting(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * The program and arguments that run `job`. An argument array, never a shell
 * string: repo paths and author emails come from the environment.
 *
 * `nightly` is the reconcile the Linux hosts already run (scripts/nightly-ingest.sh);
 * `collect` is the collector with `--ingest`, as the twice-daily Windows task
 * runs it. Both read HARNESS_VAULT and the rest from the environment themselves.
 *
 * @param {string} job
 * @param {{repoRoot: string, node: string, env: Record<string, string | undefined>}} context
 * @returns {{command: string, args: string[]}}
 */
export function jobCommand(job, { repoRoot, node, env }) {
  assertJob(job);
  if (job === JOB_NIGHTLY) return { command: 'bash', args: [`${repoRoot}/scripts/nightly-ingest.sh`] };
  const repos = listSetting(env[CHECKPOINT_REPOS_VAR]).flatMap((repo) => ['--repo', repo]);
  const authors = listSetting(env[CHECKPOINT_AUTHORS_VAR]).flatMap((author) => ['--author', author]);
  return { command: node, args: [`${repoRoot}/hooks/collect-checkpoints.mjs`, '--ingest', ...repos, ...authors] };
}
