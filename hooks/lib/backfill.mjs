/**
 * Git back-fill for notes written before the hook recorded any git context.
 *
 * The one-time migration is the only caller. It may take its time and it may
 * use the network, both of which the hook may not — so this is where `gh` lives.
 *
 * The rule throughout: **derive or leave empty.** A branch guessed from a
 * plausible-looking name is worse than no branch, because the empty field is
 * honest and the wrong one is not (Stack, 2026-09-14).
 */

import { execFileSync } from 'node:child_process';

import { collectCommits, runGitSync } from './git-log.mjs';
import { MAX_PRS } from './constants.mjs';
import { trustedSpawnOptions } from './spawn.mjs';
import { isoToMillis, uniqueCapped } from './text.mjs';

/** A migration can wait; the hook cannot. */
export const BACKFILL_GIT_TIMEOUT_MS = 15_000;
export const BACKFILL_GH_TIMEOUT_MS = 30_000;

/** Branches that describe the project rather than the session's work. */
const TRUNK_BRANCHES = new Set(['main', 'master', 'HEAD']);

/**
 * Default `gh` runner. Never throws; a failure means "no PR data".
 *
 * Spawned through `trustedSpawnOptions` for the same reason `git` is: with no
 * `cwd` of its own it would otherwise resolve `gh` against whatever directory
 * the operator happened to run the migration from.
 */
export function runGhSync(args, { timeoutMs = BACKFILL_GH_TIMEOUT_MS } = {}) {
  try {
    const stdout = execFileSync('gh', args, trustedSpawnOptions(timeoutMs, 8 * 1024 * 1024));
    return { ok: true, stdout: String(stdout ?? '') };
  } catch (err) {
    return { ok: false, stdout: '', error: err?.code || err?.message || 'gh failed' };
  }
}

/**
 * Pull requests whose creation or merge falls inside the session window.
 *
 * A PR's head branch and title are the only surviving record of which branch a
 * historical session worked on and which phase it belonged to, so both come
 * back with the numbers.
 *
 * @returns {{prs: number[], branches: string[], titles: string[], error: string}}
 */
export function pullRequestsInWindow({
  repoFullName,
  startedAt,
  endedAt,
  runGh = runGhSync,
  limit = 200,
}) {
  if (!repoFullName || !startedAt || !endedAt) {
    return { prs: [], branches: [], titles: [], error: 'no repo or no window' };
  }

  const result = runGh([
    'pr',
    'list',
    '--repo',
    repoFullName,
    '--state',
    'all',
    '--limit',
    String(limit),
    '--json',
    'number,title,headRefName,createdAt,mergedAt,closedAt',
  ]);
  if (!result.ok) return { prs: [], branches: [], titles: [], error: result.error || 'gh pr list failed' };

  let rows;
  try {
    rows = JSON.parse(result.stdout);
  } catch {
    return { prs: [], branches: [], titles: [], error: 'gh returned unparseable JSON' };
  }
  if (!Array.isArray(rows)) return { prs: [], branches: [], titles: [], error: 'gh returned no array' };

  const from = isoToMillis(startedAt);
  const to = isoToMillis(endedAt);
  const matched = [];

  for (const row of rows) {
    const stamps = [row?.createdAt, row?.mergedAt, row?.closedAt].map(isoToMillis).filter(Number.isFinite);
    const inWindow = stamps.filter((stamp) => stamp >= from && stamp <= to);
    if (inWindow.length === 0) continue;
    // Ordered by when the PR was opened, not when it merged: opening it is the
    // moment the session was on that branch, and a merge can land days later.
    const opened = isoToMillis(row?.createdAt);
    matched.push({ row, at: Number.isFinite(opened) ? opened : Math.max(...inWindow) });
  }

  // Most recent first. A session spanning several phases takes its branch and
  // its phase from the last pull request it opened — a stated rule, rather than
  // whatever order `gh` happened to print.
  matched.sort((a, b) => b.at - a.at);

  return {
    prs: uniqueCapped(
      matched.map(({ row }) => Number.parseInt(row.number, 10)).filter(Number.isInteger),
      MAX_PRS,
    ).sort((a, b) => a - b),
    branches: uniqueCapped(
      matched.map(({ row }) => (typeof row.headRefName === 'string' ? row.headRefName : '')),
      10,
    ),
    titles: uniqueCapped(
      matched.map(({ row }) => (typeof row.title === 'string' ? row.title : '')),
      10,
    ),
    error: '',
  };
}

/**
 * The branch a commit was made on, when git can still say so unambiguously.
 *
 * `git branch --contains` lists every branch that has the commit in its
 * history, which after a merge is most of them. So: drop the trunk, and accept
 * the answer only when exactly one branch is left. Anything else is a guess.
 */
export function branchContaining({ repoRoot, sha, runGit = runGitSync, timeoutMs = BACKFILL_GIT_TIMEOUT_MS }) {
  if (!repoRoot || !sha) return '';
  const result = runGit(['branch', '--contains', sha, '--format=%(refname:short)'], { cwd: repoRoot, timeoutMs });
  if (!result.ok) return '';

  const all = result.stdout
    .split('\n')
    .map((line) => line.trim().replace(/^\*\s*/, ''))
    .filter(Boolean);

  const candidates = all.filter((line) => !TRUNK_BRANCHES.has(line));
  if (candidates.length === 1) return candidates[0];
  // Only the trunk contains it: the work was committed straight to main, and
  // saying so is a derivation, not a guess.
  if (candidates.length === 0 && all.length === 1) return all[0];
  return '';
}

/**
 * Everything git and GitHub can say about one historical session.
 *
 * @returns {{commits: string[], prs: number[], branch: string, prTitles: string[],
 *            notes: string[]}} `notes` explains, per field, why anything is empty.
 */
export function backfillSession({
  repoRoot,
  repoFullName,
  startedAt,
  endedAt,
  runGit = runGitSync,
  runGh = runGhSync,
}) {
  const notes = [];

  const log = collectCommits({
    repoRoot,
    since: startedAt,
    until: endedAt,
    runGit,
    timeoutMs: BACKFILL_GIT_TIMEOUT_MS,
  });
  if (log.error) notes.push(`commits: ${log.error}`);
  else if (log.shas.length === 0) notes.push('commits: none in the session window');

  const github = pullRequestsInWindow({ repoFullName, startedAt, endedAt, runGh });
  if (github.error) notes.push(`prs: ${github.error}`);

  const prs = uniqueCapped([...log.prs, ...github.prs], MAX_PRS);
  if (prs.length === 0 && !github.error) notes.push('prs: no pull request opened or merged in the window');

  const branch = github.branches[0] || branchContaining({ repoRoot, sha: log.shas[0], runGit });
  if (!branch) notes.push('branch: not derivable from the window; left empty rather than guessed');

  return { commits: log.shas, prs, branch, prTitles: github.titles, notes };
}
