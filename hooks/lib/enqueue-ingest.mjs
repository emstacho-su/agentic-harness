/**
 * enqueue-ingest.mjs — hand one freshly written session note to the ingest
 * pipeline, without making `SessionEnd` wait for it.
 *
 * `SessionEnd` hooks share a ~1.5 s budget and session-capture.mjs keeps itself
 * inside 1,200 ms of that. A vault ingest loads a 130 MB ONNX model and talks to
 * Postgres over TLS; it is seconds of work, not milliseconds. So this module
 * does not run the ingest — it *starts* it, fully detached, and returns. The
 * measured cost is one `openSync` plus one `spawn`, well under 100 ms.
 *
 * Design rules, inherited from the hook it is called from:
 *   1. NEVER throw. Every path returns a result object. A capture hook that
 *      fails on session exit is worse than no capture at all.
 *   2. NEVER block. `detached: true` + `unref()` means Node exits while the
 *      child keeps running; its output goes to a log file, not to a pipe whose
 *      buffer would tie the parent to the child.
 *   3. NEVER build a shell string. The note path comes from the session's cwd
 *      and could hold anything; it is passed as one element of an argument
 *      array with `shell: false`, so no quoting rule can turn it into a command.
 *
 * Kill switch: `HARNESS_INGEST_ON_CAPTURE=0`.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DISABLE_VALUES } from './constants.mjs';

/** `0` (or `false`/`off`/`no`) disables the enqueue. Anything else enables it. */
export const ENV_ENABLED = 'HARNESS_INGEST_ON_CAPTURE';
/** Directory holding the `ingest` uv project (the one with pyproject.toml). */
export const ENV_PROJECT_DIR = 'HARNESS_INGEST_PROJECT';
/** Absolute path to the `uv` executable, when it is not on PATH. */
export const ENV_UV_BIN = 'HARNESS_UV_BIN';
/** Where the detached run's own stdout and stderr land. */
export const ENV_RUN_LOG = 'HARNESS_INGEST_LOG';

/**
 * The main checkout, not any worktree: worktrees come and go, and a hook
 * pointing into a deleted one fails silently every night. Override with
 * HARNESS_INGEST_PROJECT.
 */
export const DEFAULT_PROJECT_DIR = path.join(os.homedir(), 'agentic-harness', 'ingest');
export const DEFAULT_RUN_LOG = path.join(os.homedir(), '.claude', 'hooks', 'ingest-on-capture.log');

const MARKDOWN_SUFFIXES = ['.md', '.markdown', '.mdx'];

/**
 * How the child reaches `ingest.cli.main`.
 *
 * On POSIX the project script `ingest` is fine. On Windows it is not: this
 * process is spawned DETACHED, so it owns no console, and the console-subsystem
 * `python.exe` that `uv run ingest` starts therefore gets a brand-new, visible
 * console window on every session end. `pythonw.exe` is the same interpreter
 * built for the GUI subsystem; it never allocates a console, and its output is
 * still captured because stdio is redirected to the run log. Verified on this
 * machine: the `python` chain owns a conhost.exe, the `pythonw` chain owns none.
 */
export const WINDOWLESS_ENTRY = Object.freeze([
  'pythonw',
  '-c',
  'from ingest.cli import main; raise SystemExit(main())',
]);

export function ingestEntry(platform) {
  return platform === 'win32' ? [...WINDOWLESS_ENTRY] : ['ingest'];
}
const RUN_LOG_MAX_BYTES = 256 * 1024;

/** Reasons the enqueue did not happen. Stable strings — the tests assert them. */
export const Reason = {
  ENQUEUED: 'enqueued',
  DISABLED: 'disabled by HARNESS_INGEST_ON_CAPTURE',
  BAD_ARGUMENTS: 'bad arguments',
  NOTHING_TO_DO: 'no note changed on disk',
  OUTSIDE_VAULT: 'note is outside the vault',
  NOT_MARKDOWN: 'note is not markdown',
  NO_PROJECT: 'ingest project directory not found',
  NO_UV: 'uv executable not found',
  SPAWN_FAILED: 'spawn failed',
};

/**
 * Start `uv run ingest --source obsidian --path <vault> --only <note> …` detached.
 *
 * Every note goes into **one** child process. A `SessionEnd` regularly touches
 * more than one note — a resume rewrites the note it supersedes, a
 * `SubagentStop` rewrites its parent's `child_sessions` — and each ingest
 * process loads a 130 MB embedding model, so one process per note would pay
 * that once per note for no benefit.
 *
 * @param {object} options
 * @param {string} options.vaultRoot      Vault directory the notes were written into.
 * @param {string[]} options.notePaths    Absolute paths of the notes just written.
 * @param {(line: string) => void} [options.log]  Hook logger; failures go here.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {typeof nodeSpawn} [options.spawn]      Injected for tests.
 * @returns {{enqueued: boolean, reason: string, notes?: string[],
 *            command?: string[], runLog?: string}}
 */
export function enqueueIngest(options) {
  const {
    log = () => {},
    env = process.env,
    spawn = nodeSpawn,
    platform = process.platform,
  } = options ?? {};

  try {
    return run(options ?? {}, { log, env, spawn, platform });
  } catch (error) {
    // Rule 1. Anything unforeseen is a logged non-event, never an exception
    // travelling up into SessionEnd.
    safely(log, `ingest-enqueue failed: ${describe(error)}`);
    return { enqueued: false, reason: Reason.SPAWN_FAILED };
  }
}

function run({ vaultRoot, notePaths }, { log, env, spawn, platform }) {
  if (!isEnabled(env)) {
    return { enqueued: false, reason: Reason.DISABLED };
  }

  if (!isNonEmptyString(vaultRoot) || !Array.isArray(notePaths)) {
    safely(log, 'ingest-enqueue skipped: vaultRoot and a notePaths array are both required');
    return { enqueued: false, reason: Reason.BAD_ARGUMENTS };
  }

  const vault = path.resolve(vaultRoot);

  if (notePaths.length === 0) {
    // Not a defect: the capture ran, decided the note on disk was already
    // exactly what it would have written, and changed nothing.
    safely(log, 'ingest-enqueue skipped: no note changed on disk');
    return { enqueued: false, reason: Reason.NOTHING_TO_DO };
  }

  const selection = selectNotes(vault, notePaths, { log, platform });
  if (selection.notes.length === 0) {
    // selectNotes always sets a refusal when it returns nothing — the only
    // empty input is handled above — but a reason of `undefined` would be a
    // worse bug than a slightly generic one.
    return { enqueued: false, reason: selection.refusal ?? Reason.BAD_ARGUMENTS };
  }

  const projectDir = resolveProjectDir(env);
  if (!existsSafely(projectDir)) {
    safely(
      log,
      `ingest-enqueue skipped: no ingest project at ${projectDir} (set ${ENV_PROJECT_DIR})`,
    );
    return { enqueued: false, reason: Reason.NO_PROJECT };
  }

  const uv = resolveUv(env);
  if (uv === null) {
    safely(log, `ingest-enqueue skipped: uv was not found (set ${ENV_UV_BIN})`);
    return { enqueued: false, reason: Reason.NO_UV };
  }

  const runLog = resolveRunLog(env);
  const command = [
    uv,
    // --directory rather than spawning with cwd: on Windows libuv resolves a
    // bare command name against the child's cwd BEFORE PATH, so a `uv.exe`
    // dropped into the project directory would be preferred over the real one.
    // uv is always absolute here, and the child inherits no chosen cwd.
    '--directory',
    projectDir,
    'run',
    ...ingestEntry(platform),
    '--source',
    'obsidian',
    '--path',
    vault,
    // `--only` is repeatable on the ingest side, so every note this capture
    // touched is embedded by this one process.
    ...selection.notes.flatMap((note) => ['--only', note]),
  ];

  // Make the invariant the comment above relies on impossible to lose in a
  // later edit: nothing relative ever reaches spawn.
  if (!path.isAbsolute(command[0])) {
    safely(log, `ingest-enqueue skipped: uv path is not absolute (${command[0]})`);
    return { enqueued: false, reason: Reason.NO_UV };
  }

  let output = null;
  let child = null;
  try {
    output = openRunLog(runLog);
    child = spawn(command[0], command.slice(1), {
      // No shell. The note path is data, and a shell would re-parse it.
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: output === null ? 'ignore' : ['ignore', output, output],
      env: {
        ...env,
        // The child is a fresh process tree; without this it would try to
        // enqueue again if it ever ran a hook of its own.
        [ENV_ENABLED]: '0',
      },
    });

    // A safety net, not the report. `error` is delivered on the next tick and
    // session-capture.mjs calls process.exit(0) immediately after main(), so
    // this listener almost never runs — it exists so that an 'error' event with
    // no listener cannot throw, which is how EventEmitter treats one.
    child.on('error', (error) => {
      safely(log, `ingest-enqueue failed after start: ${describe(error)}`);
    });
    child.unref();
  } catch (error) {
    safely(log, `ingest-enqueue spawn failed: ${describe(error)}`);
    return { enqueued: false, reason: Reason.SPAWN_FAILED };
  } finally {
    if (output !== null) closeSafely(output);
  }

  const listed = selection.notes
    .map((note) => path.relative(vault, note).split(path.sep).join('/'))
    .join(', ');

  // The one failure this process can still see for itself. libuv leaves `pid`
  // undefined when CreateProcess/execvp failed, and reports the reason through
  // the asynchronous 'error' event above, which this process does not live long
  // enough to receive. Without this check the log claimed an ingest had started
  // for a child that never existed.
  if (typeof child?.pid !== 'number') {
    safely(log, `ingest-enqueue spawn returned no pid for ${listed}; nothing started`);
    return { enqueued: false, reason: Reason.SPAWN_FAILED, command, runLog };
  }

  // "requested", not "started": all this process knows is that the spawn was
  // accepted. Whether the ingest itself got anywhere is in the run log.
  //
  // A dropped note is named on its own line above this one; saying here that
  // some were dropped is what correlates the two, so a partial enqueue cannot
  // read as a complete one.
  const partial = selection.dropped > 0 ? `, ${selection.dropped} dropped (see above)` : '';
  safely(log, `ingest-enqueue spawn requested for ${listed} (pid=${child.pid})${partial}`);
  return {
    enqueued: true,
    reason: Reason.ENQUEUED,
    notes: selection.notes,
    dropped: selection.dropped,
    command,
    runLog,
  };
}

/**
 * The notes worth putting on the command line, and why any were dropped.
 *
 * Defence in depth: `ingest --only` refuses each of these again on the other
 * side, but the cheap check here keeps a bad path out of the argument list
 * entirely. One unusable path does not cost the others their ingest — the
 * capture wrote them all, and dropping the good ones over a bad one would lose
 * real work — so each refusal is logged on its own line.
 *
 * @returns {{notes: string[], dropped: number, refusal: string|null}}
 */
function selectNotes(vault, notePaths, { log, platform }) {
  const notes = [];
  const seen = new Set();
  let dropped = 0;
  let refusal = null;
  const refuse = (reason, line) => {
    safely(log, line);
    refusal = refusal ?? reason;
    dropped += 1;
  };

  for (const raw of notePaths) {
    if (!isNonEmptyString(raw)) {
      refuse(Reason.BAD_ARGUMENTS, `ingest-enqueue skipped a note path that is not a string: ${raw}`);
      continue;
    }

    const note = path.resolve(raw);
    if (!isInside(vault, note)) {
      refuse(Reason.OUTSIDE_VAULT, `ingest-enqueue skipped: ${note} is outside ${vault}`);
      continue;
    }
    if (!MARKDOWN_SUFFIXES.includes(path.extname(note).toLowerCase())) {
      refuse(Reason.NOT_MARKDOWN, `ingest-enqueue skipped: ${note} is not markdown`);
      continue;
    }

    // A resume can name the same note twice, and the ingest would then embed it
    // twice. Case-folded on Windows, where the two spellings are one file — and
    // from the injected `platform`, like every other platform decision here, so
    // a test that pins one platform gets that platform's rule throughout.
    const key = platform === 'win32' ? note.toLowerCase() : note;
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push(note);
  }

  return { notes, dropped, refusal };
}

// ---------------------------------------------------------------- helpers

function isEnabled(env) {
  const raw = (env?.[ENV_ENABLED] ?? '').trim().toLowerCase();
  return raw === '' || !DISABLE_VALUES.has(raw);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** True when `child` is `parent` itself or sits under it. */
function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Split note paths into batches, one `enqueueIngest` call each.
 *
 * A Windows command line tops out at 32 KiB and every ingest process loads the
 * embedding model once, so callers with a backlog send it in slices.
 */
export function inBatches(items, size) {
  if (!Number.isInteger(size) || size < 1) throw new Error(`batch size must be a positive integer, got ${size}`);
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

export function resolveProjectDir(env = process.env) {
  const override = (env?.[ENV_PROJECT_DIR] ?? '').trim();
  return override ? path.resolve(override) : DEFAULT_PROJECT_DIR;
}

export function resolveRunLog(env = process.env) {
  const override = (env?.[ENV_RUN_LOG] ?? '').trim();
  return override ? path.resolve(override) : DEFAULT_RUN_LOG;
}

/**
 * Absolute path to `uv`, or null when it cannot be found.
 *
 * Never a bare `uv`. On Windows libuv resolves a command name with no
 * directory separator against the child's working directory before it looks at
 * `PATH`, so a bare name turns any writable directory the child starts in into
 * an execution vector. Refusing beats guessing: the log says `uv` was not
 * found and the nightly reconcile picks the note up.
 */
export function resolveUv(env = process.env) {
  const override = (env?.[ENV_UV_BIN] ?? '').trim();
  if (override) {
    // Checked like every other candidate. Returned unchecked, a stale override
    // left the enqueue reporting a started ingest for a spawn that could only
    // ever fail, and the note waited for the nightly run without saying so.
    const resolved = path.resolve(override);
    return existsSafely(resolved) ? resolved : null;
  }

  const executable = process.platform === 'win32' ? 'uv.exe' : 'uv';

  // Installed by the standalone installer; present in a login shell's PATH but
  // not necessarily in the environment a hook inherits.
  const local = path.join(homeDir(env), '.local', 'bin', executable);
  if (existsSafely(local)) return local;

  return searchPath(executable, env);
}

/**
 * Home directory as the CHILD will see it, not as this process sees it.
 * Taking it from the same mapping that becomes the child's environment keeps
 * resolution honest and makes it injectable from a test.
 */
function homeDir(env) {
  const fromEnv = (env?.USERPROFILE ?? env?.HOME ?? '').trim();
  return fromEnv || os.homedir();
}

/** Resolve an executable against PATH ourselves, so the result is absolute. */
function searchPath(executable, env) {
  const raw = env?.PATH ?? env?.Path ?? '';
  for (const entry of raw.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, '');
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    if (existsSafely(candidate)) return path.resolve(candidate);
  }
  return null;
}

function existsSafely(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

/**
 * Open the run log for append, rotating it once when it gets large. Returns a
 * file descriptor, or null when the log cannot be opened — in which case the
 * child still runs, with its output discarded.
 */
function openRunLog(target) {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const stat = fs.existsSync(target) ? fs.statSync(target) : null;
    if (stat && stat.size > RUN_LOG_MAX_BYTES) {
      fs.renameSync(target, `${target}.1`);
    }
    return fs.openSync(target, 'a');
  } catch {
    return null;
  }
}

function closeSafely(fd) {
  try {
    fs.closeSync(fd);
  } catch {
    /* the child holds its own handle; a failed close here changes nothing */
  }
}

function safely(log, line) {
  try {
    log(line);
  } catch {
    /* a logger that throws must not take the hook down with it */
  }
}

function describe(error) {
  return error?.code || error?.message || String(error);
}
