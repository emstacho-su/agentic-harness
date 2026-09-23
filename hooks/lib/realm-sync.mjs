/**
 * Moving realms between machines: `git pull` before the night's work, commit
 * and `git push` after it.
 *
 * A realm is one git repo of notes under the vault, named by its `.realm`
 * marker; `HARNESS_REALMS` says which ones this machine holds and whether each
 * may leave it (`push`) or not (`local`). Only the markdown travels — every
 * machine rebuilds its own chunks and embeddings from it.
 *
 * Rules, in the order they matter:
 *
 *   1. Never force anything. A pull that cannot rebase cleanly is aborted and
 *      reported; a person resolves it. Notes are keyed by session id and
 *      written by one machine, so this should be rare.
 *   2. A `local` realm is committed (history is worth having) but never pushed.
 *   3. A listed realm that is not on disk, or not a git checkout, is skipped
 *      and said so — it is the ordinary state of a machine that holds fewer
 *      realms than the policy names.
 *   4. Git is never run in a directory whose `.realm` does not name the realm.
 *   5. Nothing is staged until every candidate path has passed the guard
 *      (`realm-guard.mjs`): a name one platform rejects or a file over the
 *      ceiling refuses the realm for the night, and says which path.
 */

import fs from 'node:fs';
import path from 'node:path';

import { runGitSync } from './git-log.mjs';
import { scanRealm } from './realm-guard.mjs';

export const REALM_MARKER = '.realm';
export const REALM_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const POLICIES = Object.freeze(['push', 'local']);

/** `git pull` reaches the network; the rest does not. */
export const SYNC_FETCH_TIMEOUT_MS = 120_000;
export const SYNC_GIT_TIMEOUT_MS = 30_000;

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
    return '';
  }
}

function isCheckout(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

function rebaseInProgress(dir) {
  return fs.existsSync(path.join(dir, '.git', 'rebase-merge')) || fs.existsSync(path.join(dir, '.git', 'rebase-apply'));
}

/**
 * Bring every listed realm up to date from its remote.
 *
 * @returns {{name: string, action: string, error: string}[]}
 */
export function pullRealms({ vaultRoot, policies, dryRun = false, runGit = runGitSync }) {
  return policies.map(({ name }) => {
    const dir = realmDir(vaultRoot, name);
    if (!dir) return { name, action: 'skip', error: 'not on this machine' };
    if (!isCheckout(dir)) return { name, action: 'skip', error: 'not a git checkout' };
    if (rebaseInProgress(dir)) return { name, action: 'conflict', error: 'a rebase is in progress; resolve it by hand' };
    if (!runGit(['remote', 'get-url', 'origin'], { cwd: dir, timeoutMs: SYNC_GIT_TIMEOUT_MS }).ok) {
      return { name, action: 'skip', error: 'no origin remote' };
    }
    if (dryRun) return { name, action: 'would-pull', error: '' };

    const pulled = runGit(['pull', '--rebase', '--autostash', '--quiet'], { cwd: dir, timeoutMs: SYNC_FETCH_TIMEOUT_MS });
    if (pulled.ok) return { name, action: 'pulled', error: '' };
    // Leave nothing half-done: a person opens a clean tree, with the divergence intact on the remote.
    runGit(['rebase', '--abort'], { cwd: dir, timeoutMs: SYNC_GIT_TIMEOUT_MS });
    return { name, action: 'conflict', error: `pull --rebase failed (${pulled.error}); aborted, nothing changed` };
  });
}

/** How many refused paths are named in the one-line error before `…`. */
const REFUSALS_SHOWN = 3;

/**
 * Commit every realm's changes; push the ones whose policy allows it.
 *
 * Before anything is staged, every path that *would* be staged (tracked and
 * untracked-not-ignored) goes through the guard: a name one platform rejects
 * or a file over the ceiling refuses the whole realm, with nothing staged, so
 * a person fixes the name rather than every later pull failing (R-A3, R-A4).
 * What the guard merely reports rides along in `notes`.
 *
 * @returns {{name: string, action: string, error: string, notes?: string}[]}
 */
export function pushRealms({ vaultRoot, policies, machine = '', dryRun = false, runGit = runGitSync, stat = fileSize, now = new Date() }) {
  const message = `harness: sync${machine ? ` from ${machine}` : ''} ${now.toISOString()}`;
  return policies.map(({ name, policy }) => {
    const dir = realmDir(vaultRoot, name);
    if (!dir) return { name, action: 'skip', error: 'not on this machine' };
    if (!isCheckout(dir)) return { name, action: 'skip', error: 'not a git checkout' };
    if (rebaseInProgress(dir)) return { name, action: 'conflict', error: 'a rebase is in progress; resolve it by hand' };

    const status = runGit(['status', '--porcelain'], { cwd: dir, timeoutMs: SYNC_GIT_TIMEOUT_MS });
    if (!status.ok) return { name, action: 'error', error: `git status failed (${status.error})` };
    const dirty = status.stdout.trim() !== '';

    let notes = '';
    if (dirty) {
      const guard = guardRealm(dir, runGit, stat);
      if (guard.action) return { name, action: dryRun && guard.action === 'refused' ? 'would-refuse' : guard.action, error: guard.error };
      notes = guard.notes;
    }
    if (dryRun) {
      return { name, action: dirty ? (policy === 'push' ? 'would-commit-and-push' : 'would-commit') : 'clean', error: '', notes };
    }
    if (dirty) {
      const added = runGit(['add', '-A'], { cwd: dir, timeoutMs: SYNC_GIT_TIMEOUT_MS });
      if (!added.ok) return { name, action: 'error', error: `git add failed (${added.error})` };
      const committed = runGit(['commit', '--quiet', '-m', message], { cwd: dir, timeoutMs: SYNC_GIT_TIMEOUT_MS });
      if (!committed.ok) return { name, action: 'error', error: `git commit failed (${committed.error}); is user.name/user.email set?` };
    }
    if (policy !== 'push') return { name, action: dirty ? 'committed' : 'clean', error: '', notes };

    const pushed = runGit(['push', '--quiet'], { cwd: dir, timeoutMs: SYNC_FETCH_TIMEOUT_MS });
    if (!pushed.ok) return { name, action: 'error', error: `git push failed (${pushed.error}); pull first, or check the remote` };
    return { name, action: dirty ? 'committed-and-pushed' : 'pushed', error: '', notes };
  });
}

/**
 * Run the guard over what `git add` would take. `-z`: NUL-separated, so a
 * name with a space, a quote or a non-ASCII letter comes back as it is on
 * disk rather than C-quoted.
 *
 * @returns {{action: 'refused'|'error'|'', error: string, notes: string}}
 */
function guardRealm(dir, runGit, stat) {
  const listed = runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: dir, timeoutMs: SYNC_GIT_TIMEOUT_MS });
  if (!listed.ok) return { action: 'error', error: `git ls-files failed (${listed.error})`, notes: '' };
  const relPaths = listed.stdout.split('\0').filter(Boolean);
  const { refused, reported } = scanRealm(relPaths, (relPath) => stat(path.join(dir, relPath)));
  const notes = reported.map((r) => `${r.path}: ${r.reason}`).join('; ');
  if (refused.length === 0) return { action: '', error: '', notes };
  const shown = refused.slice(0, REFUSALS_SHOWN).map((r) => `${r.path}: ${r.reason}`).join('; ');
  const more = refused.length > REFUSALS_SHOWN ? `; …${refused.length - REFUSALS_SHOWN} more` : '';
  return { action: 'refused', error: `${refused.length} path(s) refused: ${shown}${more}`, notes };
}

function fileSize(file) {
  return fs.statSync(file).size;
}
