/**
 * A realm's first commit: the folder as it is, in one baseline (R-C2), made
 * under the same rules as every nightly commit after it.
 *
 *   1. The policy files go in first (R-A1, R-A2): `.realm`, `.gitattributes`,
 *      `.gitignore`, so the line endings and ignore rules already apply the
 *      first time git looks at the folder.
 *   2. The same guard and the same pathspecs as the sync (R-A3, R-A4, R-B2): a
 *      refused name stops the baseline with nothing staged, and whatever the
 *      pathspecs would not take is named on a `not staged:` line.
 *   3. `git add --renormalize .` before the commit (R-A1).
 *   4. The job's identity on the commit (R-B4), or no commit at all.
 *   5. Once only: a realm with a commit on HEAD is `already` and left alone.
 *   6. Never a push or a fetch. `--remote` only names origin; the push is a
 *      separate live step.
 *
 * A dry run writes nothing in the realm. When there is no `.git` yet it lists
 * the folder through a throwaway git directory under the temp folder, with the
 * `.gitignore` it would write passed as `--exclude` rules, so the count it
 * prints is the count the real run stages.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runGitSync } from './git-log.mjs';
import { livePathspecs, scanRealm, SYNC_PATHSPECS } from './realm-guard.mjs';
import { realmPolicyFiles, writeRealmFiles } from './realm-init.mjs';
import { acquireRealmLock, describeHolder, gitDirKind, holderAgeMinutes, releaseRealmLock } from './realm-lock.mjs';
import { namePaths, splitZ } from './realm-steps.mjs';
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
/** `git remote get-url` exits 2 when the remote does not exist; anything else is a real failure. */
const NO_SUCH_REMOTE_STATUS = 2;
/** `git rev-list HEAD` exits 128 on an unborn branch: `git init` ran, nothing was committed. */
const UNBORN_STATUS = 128;
const LOCK_OWNER = 'init-realm';
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
  return REMOTE_URL.test(String(url ?? '')) ? '' : `'${url}' is not a remote URL (no spaces, no leading '-')`;
}

// ------------------------------------------------------------------ helpers

function stopWith(outcome, error, extra = {}) {
  return { stop: { outcome, error, ...extra } };
}

/** One git call in the realm with the job's env, the long timeout and stderr capture. */
function git(ctx, args) {
  return ctx.runGit(args, { cwd: ctx.dir, timeoutMs: BASELINE_GIT_TIMEOUT_MS, env: ctx.env, captureStderr: true });
}

/** `exit 128: fatal: …`, or just the code when git said nothing. */
function describe(result) {
  const code = result.error || (result.status != null ? `exit ${result.status}` : 'failed');
  return result.stderr ? `${code}: ${result.stderr}` : code;
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

const describePath = (entry) => `${entry.path}: ${entry.reason}`;

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

/** Nothing on HEAD yet, or a stop: `already` when there is history, `error` when git could not say. */
function checkUnborn(probe) {
  const answer = git(probe, ['rev-list', '--count', 'HEAD']);
  if (!answer.ok) return answer.status === UNBORN_STATUS ? {} : stopWith('error', `git rev-list failed (${describe(answer)})`);
  const count = Number.parseInt(answer.stdout.trim(), 10);
  if (!Number.isInteger(count)) return stopWith('error', `git rev-list gave an unreadable count '${answer.stdout.trim()}'`);
  return count > 0 ? stopWith('already', `already initialised (${count} commits)`) : {};
}

/**
 * What `--remote` will do. A dry run asks git nothing about it; a fresh
 * `git init` has no remotes to ask about.
 */
function planRemote(probe, url, kind, dryRun) {
  if (dryRun) return { plan: { url, action: 'would-add' } };
  if (kind === 'none') return { plan: { url, action: 'add' } };
  const current = git(probe, ['remote', 'get-url', ORIGIN]);
  if (current.ok) {
    const existing = current.stdout.trim();
    if (existing === url) return { plan: { url, action: 'unchanged' } };
    return stopWith('error', `${ORIGIN} is already ${existing}, not ${url}; change it by hand if that is meant`);
  }
  if (current.status === NO_SUCH_REMOTE_STATUS) return { plan: { url, action: 'add' } };
  return stopWith('error', `git remote get-url failed (${describe(current)})`);
}

/**
 * Every check that comes before a file is written: the inputs, the folder,
 * `.git`, the history on HEAD, the identity, and origin.
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

// ------------------------------------------------------------ list and stage

/**
 * The candidates (every path the sync pathspecs take, through the guard) and
 * the untracked paths they leave out. `excludes` and `implied` are for the
 * dry run: the ignore rules and policy files it has not written.
 */
function survey(ctx, { excludes = [], implied = [] } = {}) {
  const excludeArgs = excludes.map((pattern) => `--exclude=${pattern}`);
  const listed = git(ctx, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', ...excludeArgs, '--', ...SYNC_PATHSPECS]);
  if (!listed.ok) return stopWith('error', `git ls-files failed (${describe(listed)})`);
  const untracked = git(ctx, ['ls-files', '-z', '--others', '--exclude-standard', ...excludeArgs]);
  if (!untracked.ok) return stopWith('error', `git ls-files --others failed (${describe(untracked)})`);
  const candidates = Object.freeze([...new Set([...splitZ(listed.stdout), ...implied])].sort());
  const taken = new Set(candidates);
  const notStaged = Object.freeze(splitZ(untracked.stdout).filter((relPath) => !taken.has(relPath)).sort());
  const { refused, reported } = scanRealm(candidates, (relPath) => ctx.stat(path.join(ctx.dir, relPath)));
  const notes = reported.length > 0 ? [`reported: ${reported.map(describePath).join('; ')}`] : [];
  if (refused.length > 0) {
    return stopWith('refused', `${refused.length} path(s) refused: ${namePaths(refused.map(describePath))}`, { notStaged, notes });
  }
  return { candidates, notStaged, notes };
}

/** Stage the live pathspecs, renormalise, then check the index holds only what the guard saw. */
function stage(ctx, candidates) {
  const specs = livePathspecs(candidates);
  // `git add --all --` with no pathspec at all would take the whole folder.
  if (specs.length === 0) return stopWith('error', 'nothing on the sync paths to stage; nothing committed');
  const added = git(ctx, ['add', '--all', '--', ...specs]);
  if (!added.ok) return stopWith('error', `git add failed (${describe(added)})`);
  const renormalized = git(ctx, ['add', '--renormalize', '.']);
  if (!renormalized.ok) return stopWith('error', `git add --renormalize failed (${describe(renormalized)})`);
  const cached = git(ctx, ['diff', '--cached', '--name-only', '-z']);
  if (!cached.ok) return stopWith('error', `git diff --cached failed (${describe(cached)})`);
  const paths = splitZ(cached.stdout);
  if (paths.length === 0) return stopWith('error', 'git staged nothing; nothing committed');
  const scanned = new Set(candidates);
  const stray = paths.filter((relPath) => !scanned.has(relPath));
  if (stray.length > 0) {
    return stopWith('error', `${namePaths(stray)} staged but never scanned (staged by hand, or new during the run); nothing committed`);
  }
  return { paths };
}

function addRemote(ctx) {
  const plan = ctx.remotePlan;
  if (!plan) return {};
  if (plan.action !== 'add') return { remote: plan };
  const added = git(ctx, ['remote', 'add', ORIGIN, plan.url]);
  if (!added.ok) return { outcome: 'error', error: `git remote add failed (${describe(added)}); the commit stands` };
  return { remote: { url: plan.url, action: 'added' } };
}

function stageAndCommit(ctx) {
  const seen = survey(ctx);
  if (seen.stop) return seen.stop;
  const { candidates, notStaged, notes } = seen;
  const staged = stage(ctx, candidates);
  if (staged.stop) return { ...staged.stop, notStaged, notes };
  const summary = { staged: summarise(staged.paths), notStaged, notes };
  const subject = commitSubject(ctx);
  const committed = git(ctx, ['commit', '--quiet', '-m', subject]);
  if (!committed.ok) return { ...summary, outcome: 'error', error: `git commit failed (${describe(committed)})` };
  return { ...summary, commit: subject, ...addRemote(ctx) };
}

// ------------------------------------------------------------------ real run

/**
 * `git init` when there is no `.git`, then the rest under the realm's lock, so
 * a nightly sync that arrives mid-baseline stands down instead of committing
 * half of it as `harness: sync`.
 */
function commitBaseline(ctx) {
  const init = ctx.kind === 'none' ? 'initialised' : 'existing';
  if (ctx.kind === 'none') {
    const made = git(ctx, ['init', '-q', '-b', BASELINE_BRANCH]);
    if (!made.ok) return { outcome: 'error', error: `git init failed (${describe(made)})` };
  }
  const lock = acquireRealmLock(ctx.dir, { owner: LOCK_OWNER, pid: ctx.pid, now: ctx.clock() });
  if (!lock.ok) {
    const error = lock.reason === 'held' ? `held by ${describeHolder(lock.holder)}` : `lock: ${lock.error}`;
    return { init, outcome: 'error', error };
  }
  const before = lock.takenOver ? [`lock: taken over from ${describeHolder(lock.takenOver)} (${holderAgeMinutes(lock.takenOver)} min old)`] : [];
  let released = { ok: true };
  let done;
  try {
    done = stageAndCommit(ctx);
  } finally {
    released = releaseRealmLock(lock);
  }
  const after = released.ok ? [] : [`lock: not given back (${released.error}); remove ${lock.lockPath} by hand`];
  return { ...done, init, notes: [...before, ...(done.notes ?? []), ...after] };
}

// ------------------------------------------------------------------- dry run

function policyPaths(name) {
  return realmPolicyFiles(name).map((file) => file.relPath);
}

function policyIgnoreLines(name) {
  const ignore = realmPolicyFiles(name).find((file) => file.relPath === '.gitignore');
  return ignore.text.split('\n').filter(Boolean);
}

/** A git directory under the temp folder, so a realm with no `.git` can be listed without one. */
function throwawayGitDir(ctx) {
  let root;
  try {
    root = fs.mkdtempSync(path.join(ctx.tmpRoot, 'init-realm-dry-'));
  } catch (err) {
    return stopWith('error', `could not make a scratch git folder (${err?.code || err?.message})`);
  }
  const made = ctx.runGit(['init', '-q'], { cwd: root, timeoutMs: BASELINE_GIT_TIMEOUT_MS, env: ctx.env, captureStderr: true });
  if (!made.ok) {
    removeThrowaway(root);
    return stopWith('error', `git init of a scratch folder failed (${describe(made)})`);
  }
  return { root, gitDir: path.join(root, '.git') };
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

function listForDryRun(ctx, scratch) {
  const env = scratch ? Object.freeze({ ...ctx.env, GIT_DIR: scratch.gitDir, GIT_WORK_TREE: ctx.dir }) : ctx.env;
  const view = Object.freeze({ ...ctx, env });
  const seen = survey(view, { excludes: policyIgnoreLines(ctx.name), implied: policyPaths(ctx.name) });
  if (seen.stop) return seen.stop;
  return {
    staged: summarise(seen.candidates),
    notStaged: seen.notStaged,
    notes: seen.notes,
    commit: `would-commit: ${commitSubject(ctx)}`,
    remote: ctx.remotePlan,
  };
}

function rehearse(ctx) {
  const init = ctx.kind === 'none' ? 'would-init' : 'existing';
  const scratch = ctx.kind === 'none' ? throwawayGitDir(ctx) : null;
  if (scratch?.stop) return { init, ...scratch.stop };
  let done;
  let leftover = '';
  try {
    done = listForDryRun(ctx, scratch);
  } finally {
    if (scratch) leftover = removeThrowaway(scratch.root);
  }
  return { ...done, init, notes: [...(done.notes ?? []), ...(leftover ? [leftover] : [])] };
}

// -------------------------------------------------------------------- entry

/**
 * Make `<vaultRoot>/<name>`'s baseline commit, or say why not. `clock()` is
 * read for the lock and again for the commit subject. `baseEnv` is the
 * environment git inherits, consulted only for the user's own ssh command.
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
  let files;
  try {
    files = writeRealmFiles(ctx.dir, name, { dryRun });
  } catch (err) {
    return freezeResult({ ...base, dir: ctx.dir, outcome: 'error', error: err.message });
  }
  const done = dryRun ? rehearse(ctx) : commitBaseline(ctx);
  return freezeResult({ ...base, dir: ctx.dir, files, ...done });
}
