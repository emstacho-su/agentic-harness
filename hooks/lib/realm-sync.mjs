/**
 * Moving realms between machines: commit what changed, merge the remote in,
 * push what the remote does not have.
 *
 * A realm is one git repo of notes under the vault, named by its `.realm`
 * marker; `HARNESS_REALMS` says which ones this machine holds and whether each
 * may leave it (`push`) or not (`local`). Only the markdown travels — every
 * machine rebuilds its own chunks and embeddings from it.
 *
 * Rules, in the order they matter:
 *
 *   1. Never force, rebase or stash. The order is commit → `pull --no-rebase`
 *      → push (R-B1). A merge that conflicts is aborted with `merge --abort`
 *      and reported; the local commit stays and a person resolves it.
 *   2. Only the sync paths are staged, by explicit pathspec, never `-A`
 *      (R-B2). Anything else that changed is named on a `not staged:` line;
 *      anything a person staged by hand outside them refuses the realm.
 *   3. One writer at a time per realm (R-B3): the lock under `.git/` is taken
 *      before the first git call and given back in `finally`. A held lock
 *      stops the realm; one older than 30 minutes is taken over and said so.
 *   4. Identity and credentials come from the job (R-B4): every git call gets
 *      the machine's name and email as author and committer, and prompts are
 *      off, so a missing credential fails in seconds instead of hanging.
 *   5. A `local` realm is committed (history is worth having) but never pushed.
 *   6. A listed realm that is not on disk, or not a git checkout, is skipped
 *      and said so — the ordinary state of a machine that holds fewer realms
 *      than the policy names. Git never runs where `.realm` names another realm.
 *   7. Nothing is staged until every candidate path has passed the guard
 *      (`realm-guard.mjs`): a name one platform rejects or a file over the
 *      ceiling refuses the realm for the night, and says which path.
 */

import fs from 'node:fs';
import path from 'node:path';

import { runGitSync } from './git-log.mjs';
import { acquireRealmLock, peekRealmLock, releaseRealmLock } from './realm-lock.mjs';
import { runRealmSteps } from './realm-steps.mjs';

export { SYNC_FETCH_TIMEOUT_MS, SYNC_GIT_TIMEOUT_MS } from './realm-steps.mjs';

export const REALM_MARKER = '.realm';
export const REALM_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const POLICIES = Object.freeze(['push', 'local']);
export const SYNC_MODES = Object.freeze(['pull', 'push']);

/** Said on every realm the sync ran git in when the job has no identity to give it. */
export const IDENTITY_NOTE = 'identity: git config (set HARNESS_MACHINE and HARNESS_GIT_EMAIL)';

const MINUTE_MS = 60_000;

/** `projects:push,classes:local` → [{name, policy}]. Mirrors ingest/config.py. */
export function parseRealmPolicies(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const at = entry.indexOf(':');
    const name = at === -1 ? '' : entry.slice(0, at).trim();
    const policy = at === -1 ? '' : entry.slice(at + 1).trim();
    if (!REALM_NAME.test(name) || !POLICIES.includes(policy)) {
      throw new Error(`HARNESS_REALMS: '${entry}' is not <realm>:<push|local>`);
    }
    if (seen.has(name)) throw new Error(`HARNESS_REALMS: realm '${name}' is listed twice`);
    seen.add(name);
    out.push({ name, policy });
  }
  return out;
}

/** Where a realm lives under the vault, or '' when it is not here. */
export function realmDir(vaultRoot, name) {
  const root = readMarker(vaultRoot);
  if (root) return root === name ? vaultRoot : '';
  const folder = path.join(vaultRoot, name);
  return readMarker(folder) === name ? folder : '';
}

function readMarker(dir) {
  try {
    return fs.readFileSync(path.join(dir, REALM_MARKER), 'utf8').trim();
  } catch {
    return ''; // No marker, or unreadable: not a realm.
  }
}

/**
 * The environment every sync git call gets (R-B4). Prompts are always off;
 * the author and committer are set only when both the machine name and the
 * email are known, otherwise git config applies.
 */
export function syncGitEnv({ machine = '', email = '' } = {}) {
  const noPrompts = { GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' };
  if (!machine || !email) return Object.freeze(noPrompts);
  return Object.freeze({
    ...noPrompts,
    GIT_AUTHOR_NAME: machine,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: machine,
    GIT_COMMITTER_EMAIL: email,
  });
}

/** 'dir', 'file' or 'none': only a `.git` directory is a checkout the sync may lock and run in. */
function gitKind(dir) {
  try {
    return fs.statSync(path.join(dir, '.git')).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'none'; // No .git: not a checkout.
  }
}

function fileSize(file) {
  return fs.statSync(file).size;
}

function result(name, dryRun, { steps = [], outcome = 'ok', error = '', notes = [] }) {
  return Object.freeze({ name, steps: Object.freeze([...steps]), outcome, error, notes: Object.freeze([...notes]), dryRun });
}

function describeHolder(holder) {
  if (!holder) return 'held by an unreadable lock file';
  return `held by ${holder.owner || 'unknown'}, pid ${holder.pid ?? 'unknown'}, since ${holder.startedAt || 'unknown'}`;
}

const ageMinutes = (holder) => Math.round(holder.ageMs / MINUTE_MS);

/** A dry run looks at the lock and writes nothing: a fresh one stops the realm, a stale one is noted. */
function peekForDryRun(dir, now) {
  const peek = peekRealmLock(dir, { now });
  if (peek.held && !peek.stale) return { stop: { outcome: 'locked', error: describeHolder(peek.holder) } };
  if (peek.held) return { notes: [`lock: stale (pid ${peek.holder.pid}, ${ageMinutes(peek.holder)} min old); a real run takes it over`] };
  return { notes: [] };
}

/** Run the steps under the realm's lock; the lock is given back even when the runner throws. */
function underLock(dir, ctx, pid) {
  const lock = acquireRealmLock(dir, { owner: `sync --${ctx.mode}`, pid, now: ctx.now });
  if (!lock.ok) {
    const stop = lock.reason === 'held' ? { outcome: 'locked', error: describeHolder(lock.holder) } : { outcome: 'error', error: `lock: ${lock.error}` };
    return { steps: [], ...stop, notes: [] };
  }
  const { takenOver } = lock;
  const before = takenOver ? [`lock: taken over from pid ${takenOver.pid} (${takenOver.owner || 'unknown'}), ${ageMinutes(takenOver)} min old`] : [];
  let released = { ok: true };
  let drafted;
  try {
    drafted = runRealmSteps(ctx);
  } finally {
    released = releaseRealmLock(lock);
  }
  const after = released.ok ? [] : [`lock: not given back (${released.error}); remove ${lock.lockPath} by hand if no sync is running`];
  return { ...drafted, notes: [...before, ...drafted.notes, ...after] };
}

function syncOneRealm({ name, policy }, options) {
  const { vaultRoot, mode, dryRun, identityNotes, pid } = options;
  const dir = realmDir(vaultRoot, name);
  if (!dir) return result(name, dryRun, { outcome: 'skip', error: 'not on this machine' });
  const kind = gitKind(dir);
  if (kind === 'none') return result(name, dryRun, { outcome: 'skip', error: 'not a git checkout' });
  if (kind === 'file') return result(name, dryRun, { outcome: 'error', error: '.git is a file (a worktree or submodule); the sync needs a plain checkout' });

  const { machine, now, env, runGit, stat } = options;
  const ctx = Object.freeze({ dir, mode, policy, dryRun, machine, now, env, runGit, stat });
  if (!dryRun) {
    const done = underLock(dir, ctx, pid);
    const notes = done.outcome === 'locked' ? done.notes : [...identityNotes, ...done.notes];
    return result(name, dryRun, { ...done, notes });
  }
  const peek = peekForDryRun(dir, now);
  if (peek.stop) return result(name, dryRun, peek.stop);
  const done = runRealmSteps(ctx);
  return result(name, dryRun, { ...done, notes: [...peek.notes, ...identityNotes, ...done.notes] });
}

/**
 * Sync every listed realm: `mode` 'push' commits, merge-pulls and pushes;
 * 'pull' commits and merge-pulls. A dry run asks git only questions, never
 * touches the network, and writes no lock.
 *
 * @returns {readonly {name: string, steps: readonly string[], outcome: 'ok'|'skip'|'conflict'|'error'|'refused'|'locked', error: string, notes: readonly string[], dryRun: boolean}[]}
 */
export function syncRealms({ vaultRoot, policies, mode, machine = '', email = '', dryRun = false, runGit = runGitSync, stat = fileSize, now = new Date(), pid = process.pid }) {
  if (!SYNC_MODES.includes(mode)) throw new Error(`syncRealms: mode must be one of ${SYNC_MODES.join(', ')}, not '${mode}'`);
  const env = syncGitEnv({ machine, email });
  const identityNotes = machine && email ? [] : [IDENTITY_NOTE];
  const options = { vaultRoot, mode, machine, dryRun, runGit, stat, now, pid, env, identityNotes };
  return Object.freeze(policies.map((entry) => syncOneRealm(entry, options)));
}
