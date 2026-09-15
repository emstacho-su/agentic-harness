/**
 * The one place the hook shells out.
 *
 * Which commits a session produced cannot be read out of `.git` cheaply — it
 * needs a date-ranged walk — so this runs exactly one `git log`, with a hard
 * timeout, and treats every failure as "no commits derived". A session note
 * with an empty `commits: []` is a small loss; a session exit that hangs behind
 * a stalled `git` on a OneDrive-backed path is a capture hook nobody keeps.
 *
 * The runner is injectable so the tests never spawn a process, and so the
 * migration can reuse the parsing with a longer timeout.
 */

import { execFileSync } from 'node:child_process';

import { GIT_TIMEOUT_MS, MAX_COMMITS, MAX_PRS } from './constants.mjs';
import { uniqueCapped } from './text.mjs';

const RECORD = '';
const UNIT = '';

/** `(#12)` in a squash-merge subject, or GitHub's own merge-commit wording. */
const PR_IN_MESSAGE = /(?:\(#(\d{1,6})\)|\bMerge pull request #(\d{1,6})\b)/g;

/** Default runner: `git`, bounded, stderr discarded, never throws. */
export function runGitSync(args, { cwd, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  try {
    const stdout = execFileSync('git', ['--no-pager', ...args], {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return { ok: true, stdout: String(stdout ?? '') };
  } catch (err) {
    return { ok: false, stdout: '', error: err?.code || err?.message || 'git failed' };
  }
}

/**
 * Commits authored in `[since, until]`, across every ref.
 *
 * `--all` rather than `HEAD`: a session that moved between worktrees committed
 * on more than one branch, and filing those commits under the branch the hook
 * happened to end on would be a lie either way. The window is the honest key.
 */
export function collectCommits({
  repoRoot,
  since,
  until,
  runGit = runGitSync,
  timeoutMs = GIT_TIMEOUT_MS,
  maxCommits = MAX_COMMITS,
}) {
  if (!repoRoot || !since) return { shas: [], subjects: [], prs: [], error: 'no repo or no window' };

  const args = [
    'log',
    '--all',
    '--no-merges',
    `--since=${since}`,
    `--pretty=format:%H${UNIT}%s${UNIT}%b${RECORD}`,
    `-n`,
    String(Math.max(1, maxCommits * 4)),
  ];
  if (until) args.splice(4, 0, `--until=${until}`);

  const result = runGit(args, { cwd: repoRoot, timeoutMs });
  if (!result.ok) return { shas: [], subjects: [], prs: [], error: result.error || 'git log failed' };

  return parseCommitLog(result.stdout, maxCommits);
}

/** Split the `%H\x1f%s\x1f%b\x1e` stream into shas, subjects and PR numbers. */
export function parseCommitLog(stdout, maxCommits = MAX_COMMITS) {
  const shas = [];
  const subjects = [];
  const prs = [];

  for (const record of String(stdout ?? '').split(RECORD)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [sha, subject = '', body = ''] = trimmed.split(UNIT);
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue;
    shas.push(sha.slice(0, 12));
    subjects.push(subject);
    for (const match of `${subject}\n${body}`.matchAll(PR_IN_MESSAGE)) {
      const number = Number.parseInt(match[1] ?? match[2], 10);
      if (Number.isInteger(number) && number > 0) prs.push(number);
    }
  }

  return {
    shas: uniqueCapped(shas, maxCommits),
    subjects,
    prs: uniqueCapped(prs, MAX_PRS),
    error: '',
  };
}
