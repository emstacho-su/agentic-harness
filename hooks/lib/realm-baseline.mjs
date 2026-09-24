/**
 * A realm's first commit: the folder as it is, in one baseline (R-C2), made
 * under the same rules as every nightly commit after it.
 *
 *   1. Survey first, write after. Both runs list the folder through a
 *      throwaway git directory under the temp folder, with the policy
 *      `.gitignore` passed as `--exclude` rules, and put every candidate
 *      through the sync's guard (R-A3, R-A4). A refusal, or any failure up to
 *      here, leaves the folder byte-identical: no policy file, no `.git`, no
 *      lock. The dry run stops after the survey, so the count it prints is the
 *      count the real run stages.
 *   2. Then the policy files (R-A1, R-A2): `.realm`, `.gitattributes`,
 *      `.gitignore`, so the line endings and ignore rules already apply the
 *      first time the realm's own git looks at the folder.
 *   3. `git init` when there is no `.git`, then the lock, the sync's
 *      pathspecs, `git add --renormalize .` (R-A1), and a check that the index
 *      holds nothing the survey did not see.
 *   4. The job's identity on the commit (R-B4), or no commit at all.
 *   5. Once only: a realm with a commit on HEAD is `already` and left alone; a
 *      `.git` git cannot read is an error, never mistaken for an unborn one.
 *   6. Never a push or a fetch. `--remote` only names origin; the push is a
 *      separate live step. Every url in a message has its user part removed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runGitSync } from './git-log.mjs';
import { livePathspecs } from './realm-guard.mjs';
import { realmPolicyFiles, writeRealmFiles } from './realm-init.mjs';
import { acquireRealmLock, describeHolder, gitDirKind, holderAgeMinutes, releaseRealmLock } from './realm-lock.mjs';
import { describe, git, guardCandidates, listSyncCandidates, namePaths, NO_SUCH_REMOTE_STATUS, redactRemoteUrl, splitZ } from './realm-steps.mjs';
import { REALM_MARKER, REALM_NAME, syncGitEnv } from './realm-sync.mjs';

export const BASELINE_BRANCH = 'main';
/** How many paths the report names on its `staged:` and `not staged:` lines before `…N more`. */
export const PATHS_NAMED = 10;
/** The `from <label>` in the commit subject when the caller names no source. */
export const DEFAULT_SOURCE_LABEL = 'vault';
export const IDENTITY_REQUIRED = 'set HARNESS_MACHINE and HARNESS_GIT_EMAIL (machine file or shell) before initialising a realm';

/** The whole folder goes in at once: far more than the handful of notes a nightly commit stages. */
const BASELINE_GIT_TIMEOUT_MS = 120_000;
const ORIGIN = 'origin';
/** `git rev-parse --verify --quiet` exits 1, silently, when HEAD does not resolve: an unborn branch. */
const UNRESOLVED_REV_STATUS = 1;
const LOCK_OWNER = 'init-realm';
/** Where the throwaway survey git directory is made, under the temp folder. */
const SCRATCH_PREFIX = 'init-realm-survey-';
/** One line of a commit subject, short enough to read in `git log --oneline`. */
// eslint-disable-next-line no-control-regex
const SOURCE_LABEL = /^[^\u0000-\u001f\u007f]{1,80}$/;
/** One argument git takes as a URL: no whitespace or control characters, and not an option. */
// eslint-disable-next-line no-control-regex
const REMOTE_URL = /^[^\s\u0000-\u001f\u007f-][^\s\u0000-\u001f\u007f]*$/;

/** Why `label` cannot go into the commit subject, or '' when it can. */
export function checkSourceLabel(label) {
  return SOURCE_LABEL.test(String(label ?? '')) ? '' : '--source must be 1-80 printable characters on one line';
}

/** Why git would not take `url` as a remote, or '' when it would. */
export function checkRemoteUrl(url) {
  return REMOTE_URL.test(String(url ?? '')) ? '' : `'${redactRemoteUrl(url)}' is not a remote URL (no spaces, no leading '-')`;
}

// ------------------------------------------------------------------ helpers

function stopWith(outcome, error, extra = {}) {
  return { stop: { outcome, error, ...extra } };
}

/** Every baseline git call: the sync's runner, with the long timeout. */
function baselineGit(ctx, args) {
  return git(ctx, args, BASELINE_GIT_TIMEOUT_MS);
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false; // Absent or unreadable: either way there is no folder to initialise.
  }
}

/** lstat, not stat: git commits a symlink as the link itself. */
function fileSize(file) {
  return fs.lstatSync(file).size;
}

function summarise(paths) {
  return { count: paths.length, sample: paths.slice(0, PATHS_NAMED) };
}

function commitSubject(ctx) {
  return `init realm ${ctx.name}: baseline from ${ctx.sourceLabel} ${ctx.clock().toISOString()}`;
}

function freezeResult(fields) {
  const staged = fields.staged ?? { count: 0, sample: [] };
  return Object.freeze({
    name: fields.name,
    dir: fields.dir ?? '',
    outcome: fields.outcome ?? 'ok',
    dryRun: Boolean(fields.dryRun),
    init: fields.init ?? '',
    files: Object.freeze((fields.files ?? []).map(({ relPath, action }) => Object.freeze({ relPath, action }))),
    staged: Object.freeze({ count: staged.count, sample: Object.freeze([...staged.sample]) }),
    notStaged: Object.freeze([...(fields.notStaged ?? [])]),
    notes: Object.freeze([...(fields.notes ?? [])]),
    commit: fields.commit ?? '',
    remote: fields.remote ? Object.freeze({ url: fields.remote.url, action: fields.remote.action }) : null,
    error: fields.error ?? '',
  });
}

// ------------------------------------------------------------ before writing

function invalidInput({ vaultRoot, name, remote, sourceLabel }) {
  if (!REALM_NAME.test(String(name ?? ''))) return `'${name}' is not a realm name (${REALM_NAME})`;
  if (!vaultRoot) return 'no vault folder given';
  if (fs.existsSync(path.join(vaultRoot, REALM_MARKER))) {
    return `${vaultRoot} is itself a realm (it has a ${REALM_MARKER}); a folder realm cannot sit inside it`;
  }
  return checkSourceLabel(sourceLabel) || (remote ? checkRemoteUrl(remote) : '');
}

/**
 * Nothing on HEAD yet, or a stop. `rev-parse --verify --quiet` exits 1 only
 * for a name that does not resolve; exit 128 (not a repository, dubious
 * ownership) or no exit at all (a timeout) is git failing, and says nothing
 * about the history.
 */
function checkUnborn(probe) {
  const head = baselineGit(probe, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!head.ok && head.status === UNRESOLVED_REV_STATUS) return {};
  if (!head.ok) return stopWith('error', `git rev-parse failed (${describe(head)})`);
  const answer = baselineGit(probe, ['rev-list', '--count', 'HEAD']);
  if (!answer.ok) return stopWith('error', `git rev-list failed (${describe(answer)})`);
  const count = Number.parseInt(answer.stdout.trim(), 10);
  if (!Number.isInteger(count)) return stopWith('error', `git rev-list gave an unreadable count '${answer.stdout.trim()}'`);
  return stopWith('already', `already initialised (${count} commits)`);
}

/**
 * What `--remote` will do, the same in both runs: a fresh `git init` has no
 * remotes, and an existing `.git` is asked (read-only) what origin is.
 */
function planRemote(probe, url, kind, dryRun) {
  const adding = { plan: { url, action: dryRun ? 'would-add' : 'add' } };
  if (kind === 'none') return adding;
  const current = baselineGit(probe, ['remote', 'get-url', ORIGIN]);
  if (current.ok) {
    const existing = current.stdout.trim();
    if (existing === url) return { plan: { url, action: 'unchanged' } };
    return stopWith('error', `${ORIGIN} is already ${redactRemoteUrl(existing)}, not ${redactRemoteUrl(url)}; change it by hand if that is meant`);
  }
  if (current.status === NO_SUCH_REMOTE_STATUS) return adding;
  return stopWith('error', `git remote get-url failed (${describe(current)})`);
}

/**
 * Every check that asks git nothing about the folder's files: the inputs,
 * the folder, `.git`, the history on HEAD, the identity, and origin.
 */
function inspect(opts) {
  const invalid = invalidInput(opts);
  if (invalid) return stopWith('error', invalid);
  const dir = path.join(path.resolve(opts.vaultRoot), opts.name);
  if (!isDirectory(dir)) return stopWith('error', `${dir} is not a folder; copy the vault first`, { dir });
  const kind = gitDirKind(dir);
  if (kind === 'file') return stopWith('error', '.git is a file (a worktree or submodule); a realm needs a plain checkout', { dir });
  const env = syncGitEnv({ machine: opts.machine, email: opts.email, baseEnv: opts.baseEnv });
  const probe = Object.freeze({ dir, env, runGit: opts.runGit });
  if (kind === 'directory') {
    const history = checkUnborn(probe);
    if (history.stop) return { stop: { ...history.stop, dir } };
  }
  if (!opts.machine || !opts.email) return stopWith('error', IDENTITY_REQUIRED, { dir });
  const remote = opts.remote ? planRemote(probe, opts.remote, kind, opts.dryRun) : { plan: null };
  if (remote.stop) return { stop: { ...remote.stop, dir } };
  return { ctx: { dir, env, kind, remotePlan: remote.plan } };
}

/** The policy files' actions; `dryRun` only reads, and finds a marker naming another realm. */
function policyFiles(ctx, { dryRun }) {
  try {
    return { files: writeRealmFiles(ctx.dir, ctx.name, { dryRun }) };
  } catch (err) {
    return stopWith('error', err.message);
  }
}

// ------------------------------------------------------------------- survey

function policyPaths(name) {
  return realmPolicyFiles(name).map((file) => file.relPath);
}

/** The policy `.gitignore`, one `--exclude=` per line. */
function policyExcludeArgs(name) {
  const ignore = realmPolicyFiles(name).find((file) => file.relPath === '.gitignore');
  return ignore.text.split('\n').filter(Boolean).map((line) => `--exclude=${line}`);
}

/**
 * List and guard the folder through the throwaway `gitDir`. The policy
 * ignore rules come in as `--exclude`, and `--exclude-standard` is left out
 * on purpose: a `.gitignore` already on disk is overwritten before the real
 * add, so it plays no part in either run's survey. The policy files are
 * candidates whether or not they are on disk yet.
 */
function surveyThrough(ctx, gitDir) {
  const view = Object.freeze({ ...ctx, env: Object.freeze({ ...ctx.env, GIT_DIR: gitDir, GIT_WORK_TREE: ctx.dir }) });
  const excludeArgs = policyExcludeArgs(ctx.name);
  const listed = listSyncCandidates(view, { excludeArgs, timeoutMs: BASELINE_GIT_TIMEOUT_MS });
  if (listed.stop) return { stop: listed.stop };
  const untracked = baselineGit(view, ['ls-files', '-z', '--others', ...excludeArgs]);
  if (!untracked.ok) return stopWith('error', `git ls-files --others failed (${describe(untracked)})`);
  const candidates = Object.freeze([...new Set([...listed.candidates, ...policyPaths(ctx.name)])].sort());
  const taken = new Set(candidates);
  const notStaged = Object.freeze(splitZ(untracked.stdout).filter((relPath) => !taken.has(relPath)).sort());
  const guard = guardCandidates(view, candidates);
  if (guard.stop) return { stop: { ...guard.stop, notStaged, notes: guard.notes } };
  return { candidates, notStaged, notes: guard.notes };
}

/** '' when the throwaway is gone, a note naming it when it is not. */
function removeThrowaway(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    return '';
  } catch (err) {
    return `scratch git folder left behind (${err?.code || err?.message}): ${root}`;
  }
}

function surveyInScratch(ctx, root) {
  const made = baselineGit({ ...ctx, dir: root }, ['init', '-q']);
  if (!made.ok) return stopWith('error', `git init of a scratch folder failed (${describe(made)})`);
  return surveyThrough(ctx, path.join(root, '.git'));
}

/**
 * The survey both runs make before anything is written: `{ candidates,
 * notStaged, notes }` or a stop. The throwaway is removed on every path, and
 * a throwaway that will not go is named in the notes.
 */
function survey(ctx) {
  let root;
  try {
    root = fs.mkdtempSync(path.join(ctx.tmpRoot, SCRATCH_PREFIX));
  } catch (err) {
    return stopWith('error', `could not make a scratch git folder (${err?.code || err?.message})`);
  }
  let seen;
  let leftover = '';
  try {
    seen = surveyInScratch(ctx, root);
  } finally {
    leftover = removeThrowaway(root);
  }
  if (!leftover) return seen;
  if (seen.stop) return { stop: { ...seen.stop, notes: [...(seen.stop.notes ?? []), leftover] } };
  return { ...seen, notes: [...seen.notes, leftover] };
}

// ------------------------------------------------------------------- dry run

function rehearse(ctx, files) {
  const outline = { files, init: ctx.kind === 'none' ? 'would-init' : 'existing' };
  const seen = survey(ctx);
  if (seen.stop) return { ...outline, ...seen.stop };
  return {
    ...outline,
    staged: summarise(seen.candidates),
    notStaged: seen.notStaged,
    notes: seen.notes,
    commit: `would-commit: ${commitSubject(ctx)}`,
    remote: ctx.remotePlan,
  };
}

// ------------------------------------------------------------------ real run

/** Stage the live pathspecs, renormalise, then check the index holds only what the survey saw. */
function stage(ctx, candidates) {
  const specs = livePathspecs(candidates);
  // `git add --all --` with no pathspec at all would take the whole folder.
  if (specs.length === 0) return stopWith('error', 'nothing on the sync paths to stage; nothing committed');
  const added = baselineGit(ctx, ['add', '--all', '--', ...specs]);
  if (!added.ok) return stopWith('error', `git add failed (${describe(added)})`);
  const renormalized = baselineGit(ctx, ['add', '--renormalize', '.']);
  if (!renormalized.ok) return stopWith('error', `git add --renormalize failed (${describe(renormalized)})`);
  const cached = baselineGit(ctx, ['diff', '--cached', '--name-only', '-z']);
  if (!cached.ok) return stopWith('error', `git diff --cached failed (${describe(cached)})`);
  const paths = splitZ(cached.stdout);
  if (paths.length === 0) return stopWith('error', 'git staged nothing; nothing committed');
  const scanned = new Set(candidates);
  const stray = paths.filter((relPath) => !scanned.has(relPath));
  if (stray.length > 0) {
    const named = namePaths(stray);
    return stopWith('error', `${named} staged but never scanned (staged by hand, or new during the run); nothing committed, the tree is left staged but uncommitted`);
  }
  return { paths };
}

function addRemote(ctx) {
  const plan = ctx.remotePlan;
  if (!plan) return {};
  if (plan.action !== 'add') return { remote: plan };
  const added = baselineGit(ctx, ['remote', 'add', ORIGIN, plan.url]);
  if (!added.ok) return { outcome: 'error', error: `git remote add failed (${describe(added)}); the commit stands` };
  return { remote: { url: plan.url, action: 'added' } };
}

function stageAndCommit(ctx, { candidates, notStaged, notes }) {
  const staged = stage(ctx, candidates);
  if (staged.stop) return { ...staged.stop, notStaged, notes };
  const summary = { staged: summarise(staged.paths), notStaged, notes };
  const subject = commitSubject(ctx);
  const committed = baselineGit(ctx, ['commit', '--quiet', '-m', subject]);
  if (!committed.ok) return { ...summary, outcome: 'error', error: `git commit failed (${describe(committed)})` };
  return { ...summary, commit: subject, ...addRemote(ctx) };
}

/**
 * Stage and commit under the realm's lock, so a nightly sync that arrives
 * mid-baseline stands down instead of committing half of it as `harness: sync`.
 */
function underLock(ctx, seen) {
  const lock = acquireRealmLock(ctx.dir, { owner: LOCK_OWNER, pid: ctx.pid, now: ctx.clock() });
  if (!lock.ok) {
    const error = lock.reason === 'held' ? `held by ${describeHolder(lock.holder)}` : `lock: ${lock.error}`;
    return { outcome: 'error', error, notStaged: seen.notStaged, notes: seen.notes };
  }
  const before = lock.takenOver ? [`lock: taken over from ${describeHolder(lock.takenOver)} (${holderAgeMinutes(lock.takenOver)} min old)`] : [];
  let released = { ok: true };
  let done;
  try {
    done = stageAndCommit(ctx, seen);
  } finally {
    released = releaseRealmLock(lock);
  }
  const after = released.ok ? [] : [`lock: not given back (${released.error}); remove ${lock.lockPath} by hand`];
  return { ...done, notes: [...before, ...(done.notes ?? []), ...after] };
}

/** `git init -b main` when there is no `.git`; the word the report prints either way. */
function initRealm(ctx) {
  if (ctx.kind !== 'none') return { init: 'existing' };
  const made = baselineGit(ctx, ['init', '-q', '-b', BASELINE_BRANCH]);
  return made.ok ? { init: 'initialised' } : stopWith('error', `git init failed (${describe(made)})`);
}

/** The survey, and only when it passes: the policy files, `git init`, the lock, the commit. */
function commitBaseline(ctx) {
  const seen = survey(ctx);
  if (seen.stop) return seen.stop;
  const written = policyFiles(ctx, { dryRun: false });
  if (written.stop) return { ...written.stop, notes: seen.notes };
  const made = initRealm(ctx);
  if (made.stop) return { files: written.files, ...made.stop, notes: seen.notes };
  return { files: written.files, init: made.init, ...underLock(ctx, seen) };
}

// -------------------------------------------------------------------- entry

/**
 * Make `<vaultRoot>/<name>`'s baseline commit, or say why not. `clock()` is
 * read for the lock and again for the commit subject. `baseEnv` is the
 * environment git inherits, consulted only for the user's own ssh command.
 * `tmpRoot` is where the survey's throwaway git directory is made.
 *
 * @returns {{name: string, dir: string, outcome: 'ok'|'refused'|'error'|'already', dryRun: boolean,
 *   init: ''|'initialised'|'existing'|'would-init', files: readonly {relPath: string, action: string}[],
 *   staged: {count: number, sample: readonly string[]}, notStaged: readonly string[], notes: readonly string[],
 *   commit: string, remote: {url: string, action: 'added'|'unchanged'|'would-add'} | null, error: string}} frozen
 */
export function baselineRealm({
  vaultRoot,
  name,
  remote = '',
  sourceLabel = DEFAULT_SOURCE_LABEL,
  machine = '',
  email = '',
  dryRun = false,
  runGit = runGitSync,
  stat = fileSize,
  clock = () => new Date(),
  pid = process.pid,
  baseEnv = process.env,
  tmpRoot = os.tmpdir(),
}) {
  const base = { name, dryRun };
  const checked = inspect({ vaultRoot, name, remote, sourceLabel, machine, email, dryRun, runGit, baseEnv });
  if (checked.stop) return freezeResult({ ...base, ...checked.stop });
  const ctx = Object.freeze({ ...checked.ctx, name, sourceLabel, runGit, stat, clock, pid, tmpRoot });
  // Read-only either way: finds a marker naming another realm before anything else is asked.
  const planned = policyFiles(ctx, { dryRun: true });
  if (planned.stop) return freezeResult({ ...base, dir: ctx.dir, ...planned.stop });
  const done = dryRun ? rehearse(ctx, planned.files) : commitBaseline(ctx);
  return freezeResult({ ...base, dir: ctx.dir, ...done });
}
