/**
 * A disposable world for the hook to run in.
 *
 * Every test that exercises the whole capture needs four things that normally
 * live on the real machine: git checkouts, a vault, a transcript directory and
 * a home directory. Building them in a temp folder keeps the suite hermetic —
 * it never reads the live vault and never writes outside the temp tree — and
 * lets the golden files stay byte-exact, because the one thing that varies (the
 * temp path) is substituted in on the way in and out again.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The placeholder every fixture and golden uses for the sandbox root. */
export const SANDBOX_TOKEN = '__SANDBOX__';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(HERE, '..', 'fixtures');
export const TRANSCRIPTS_DIR = path.join(FIXTURES_DIR, 'transcripts');
export const GOLDEN_DIR = path.join(FIXTURES_DIR, 'golden');

/** Fake checkouts: `.git` contents are all the hook actually reads. */
const REPOS = [
  {
    dir: 'repos/bb2dash',
    remote: 'https://github.com/emstacho-su/bb2dash.git',
    head: 'feat/phase7-retrieval',
    worktrees: [{ dir: 'repos/bb2dash-wt-sl', name: 'bb2dash-wt-sl', head: 'feat/sync-loop' }],
  },
  {
    dir: 'repos/agentic-harness',
    remote: 'git@github.com:emstacho-su/agentic-harness.git',
    head: 'feat/session-context',
    worktrees: [],
  },
];

/** Folders whose mere existence steers the collection rules. */
const VAULT_FOLDERS = [
  'projects/bb2dash/sessions',
  'projects/agentic-harness/sessions',
  'classes/ist323/sessions',
  'templates',
];

const OTHER_FOLDERS = [
  'onedrive/.fall2026/ist323',
  'home/.claude/plans',
  'home/.claude/projects',
  'projects/fixture',
  'repos/plain-folder/src',
];

/**
 * Create the sandbox. Returns the roots the hook needs plus `cleanup()`.
 */
export function createSandbox() {
  const root = toPosix(fs.mkdtempSync(path.join(os.tmpdir(), 'session-capture-')));

  for (const folder of VAULT_FOLDERS) fs.mkdirSync(path.join(root, 'vault', folder), { recursive: true });
  for (const folder of OTHER_FOLDERS) fs.mkdirSync(path.join(root, folder), { recursive: true });
  for (const repo of REPOS) createRepo(root, repo);

  return {
    root,
    vaultRoot: path.join(root, 'vault'),
    projectsRoot: path.join(root, 'projects'),
    transcriptsDir: path.join(root, 'projects', 'fixture'),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function createRepo(root, { dir, remote, head, worktrees }) {
  const gitDir = path.join(root, dir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(
    path.join(gitDir, 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${head}\n`, 'utf8');

  for (const worktree of worktrees) {
    const worktreeGitDir = path.join(gitDir, 'worktrees', worktree.name);
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeGitDir, 'HEAD'), `ref: refs/heads/${worktree.head}\n`, 'utf8');
    fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n', 'utf8');

    fs.mkdirSync(path.join(root, worktree.dir), { recursive: true });
    fs.writeFileSync(path.join(root, worktree.dir, '.git'), `gitdir: ${toPosix(worktreeGitDir)}\n`, 'utf8');
  }
}

/**
 * Copy a fixture transcript into the sandbox under the session's own id,
 * substituting the sandbox root for the placeholder. A sibling
 * `<name>.subagents/` directory is installed as the session's subagent folder.
 */
export function installTranscript(sandbox, fixtureName, sessionId) {
  const source = path.join(TRANSCRIPTS_DIR, `${fixtureName}.jsonl`);
  const target = path.join(sandbox.transcriptsDir, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, expand(fs.readFileSync(source, 'utf8'), sandbox), 'utf8');

  const subagentSource = path.join(TRANSCRIPTS_DIR, `${fixtureName}.subagents`);
  if (fs.existsSync(subagentSource)) {
    const subagentTarget = path.join(sandbox.transcriptsDir, sessionId, 'subagents');
    fs.mkdirSync(subagentTarget, { recursive: true });
    for (const name of fs.readdirSync(subagentSource)) {
      fs.writeFileSync(
        path.join(subagentTarget, name),
        expand(fs.readFileSync(path.join(subagentSource, name), 'utf8'), sandbox),
        'utf8',
      );
    }
  }
  return toPosix(target);
}

/** Placeholder -> real sandbox path. */
export function expand(text, sandbox) {
  return String(text).split(SANDBOX_TOKEN).join(sandbox.root);
}

/** Real sandbox path -> placeholder, so a rendered note can be diffed exactly. */
export function collapse(text, sandbox) {
  return String(text).split(sandbox.root).join(SANDBOX_TOKEN);
}

/** `git log` that always fails: the fake checkouts have no objects to walk. */
export function noGit() {
  return { ok: false, stdout: '', error: 'ENOENT' };
}

/** Read a note out of the sandbox vault with the sandbox path collapsed again. */
export function readNote(sandbox, relativePath) {
  return collapse(fs.readFileSync(path.join(sandbox.vaultRoot, relativePath), 'utf8'), sandbox);
}

export function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}
