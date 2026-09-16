/**
 * The one subprocess, and what happens when it fails.
 *
 * `collectCommits` is the only place the hook can block on something outside
 * its own process, so the interesting cases are all failure cases: git absent,
 * git slow, git returning nothing. Every one of them must produce an empty list
 * and no throw.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { collectCommits, parseCommitLog, runGitSync } from '../lib/git-log.mjs';

const UNIT = '\u001f';
const RECORD = '\u001e';

function record(sha, subject, body = '') {
  return `${sha}${UNIT}${subject}${UNIT}${body}${RECORD}`;
}

test('a commit log parses into shas, subjects and PR numbers', () => {
  const stdout = [
    record('a1b2c3d4e5f6a7b8c9d0', 'feat(ingest): add the --only flag (#12)'),
    record('b2c3d4e5f6a7b8c9d0e1', 'docs: session archival brief', 'Refs #13\nCo-Authored-By: Claude'),
    record('c3d4e5f6a7b8c9d0e1f2', 'Merge pull request #14 from emstacho-su/feat/x'),
  ].join('');

  const result = parseCommitLog(stdout);
  assert.deepEqual(result.shas, ['a1b2c3d4e5f6', 'b2c3d4e5f6a7', 'c3d4e5f6a7b8']);
  assert.deepEqual(result.prs, [12, 14], '"Refs #13" is a reference, not a merged PR');
  assert.equal(result.subjects.length, 3);
});

test('garbage in the stream is skipped, not parsed', () => {
  const result = parseCommitLog(`not-a-sha${UNIT}subject${RECORD}${record('abcdef1', 'real')}`);
  assert.deepEqual(result.shas, ['abcdef1']);
});

test('an empty log is an empty result, not an error', () => {
  const result = parseCommitLog('');
  assert.deepEqual(result.shas, []);
  assert.deepEqual(result.prs, []);
  assert.equal(result.error, '');
});

test('the commit list is capped', () => {
  const stdout = Array.from({ length: 100 }, (_, index) =>
    record(`${String(index).padStart(12, '0')}`, `commit ${index}`),
  ).join('');
  assert.equal(parseCommitLog(stdout, 5).shas.length, 5);
});

test('a failing git yields no commits and says why', () => {
  const result = collectCommits({
    repoRoot: 'C:/nowhere',
    since: '2026-09-01T00:00:00.000Z',
    runGit: () => ({ ok: false, stdout: '', error: 'ENOENT' }),
  });
  assert.deepEqual(result.shas, []);
  assert.equal(result.error, 'ENOENT');
});

test('a missing repo or window is refused before git is spawned', () => {
  let spawned = 0;
  const runGit = () => {
    spawned += 1;
    return { ok: true, stdout: '' };
  };
  collectCommits({ repoRoot: '', since: '2026-09-01T00:00:00.000Z', runGit });
  collectCommits({ repoRoot: 'C:/repo', since: '', runGit });
  assert.equal(spawned, 0);
});

test('the window becomes --since and --until, and merges are excluded', () => {
  let captured = null;
  collectCommits({
    repoRoot: 'C:/repo',
    since: '2026-09-11T14:02:10.000Z',
    until: '2026-09-11T15:02:00.000Z',
    runGit: (args) => {
      captured = args;
      return { ok: true, stdout: '' };
    },
  });
  assert.ok(captured.includes('--since=2026-09-11T14:02:10.000Z'));
  assert.ok(captured.includes('--until=2026-09-11T15:02:00.000Z'));
  assert.ok(captured.includes('--no-merges'));
  assert.ok(captured.includes('--all'), 'a session that moved between worktrees committed on more than one branch');
});

test('the real runner never throws, whatever git does', () => {
  const missing = runGitSync(['definitely-not-a-git-subcommand'], { cwd: process.cwd(), timeoutMs: 2000 });
  assert.equal(missing.ok, false);
  assert.equal(missing.stdout, '');
});
