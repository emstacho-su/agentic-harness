#!/usr/bin/env node
/**
 * What this machine's harness resolved to, in one screen.
 *
 *   node hooks/doctor.mjs
 *
 * Read-only. Every path below is what the hook, the sweep and the ingest would
 * use right now, after ~/.harness/machine.env is loaded; a wrong one here is a
 * wrong one at 03:00. Secrets are reported as present or absent, never shown.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_VAULT_SEGMENTS,
  MACHINE_NAME_VAR,
  VAULT_ENV_VAR,
} from './lib/constants.mjs';
import { DEFAULT_PROJECT_DIR, ENV_PROJECT_DIR, resolveUv } from './lib/enqueue-ingest.mjs';
import { runGitSync } from './lib/git-log.mjs';
import {
  MACHINE_ENV_SEGMENTS,
  MACHINE_ENV_VAR,
  gitEmail,
  loadMachineEnv,
  loadRepoEnv,
  machineName,
} from './lib/machine-env.mjs';
import { describeHolder, gitDirKind, peekRealmLock } from './lib/realm-lock.mjs';
import { NO_SUCH_REMOTE_STATUS, redactRemoteUrl } from './lib/realm-steps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Realm folders on disk: every top-level folder (or the root) carrying `.realm`. */
export function realmsOnDisk(vaultRoot) {
  if (!fs.existsSync(vaultRoot)) return [];
  const read = (dir) => {
    try {
      return fs.readFileSync(path.join(dir, '.realm'), 'utf8').trim();
    } catch {
      return '';
    }
  };
  const root = read(vaultRoot);
  if (root) return [{ folder: '.', name: root }];
  return fs
    .readdirSync(vaultRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ folder: entry.name, name: read(path.join(vaultRoot, entry.name)) }))
    .filter((entry) => entry.name);
}

/**
 * A doctor run is interactive, so each git call gets far less than the sync's
 * 30 s: neither call touches the network, and a realm that cannot answer a
 * local lookup in 5 s is itself the finding.
 */
const DOCTOR_GIT_TIMEOUT_MS = 5_000;

/** `git rev-parse --verify --quiet` exits 1, silently, when the name does not resolve. */
const UNRESOLVED_REV_STATUS = 1;

/** Printed in place of the history when git gave no exit code at all (a timeout, or no git to run). */
const COUNT_SKIPPED = ', commit count skipped (git did not answer)';

/** Whether git ran and exited, as opposed to being killed or never starting (status null). */
const gitAnswered = (result) => result.ok || Number.isInteger(result.status);

/** `, origin <url>`, `, no origin remote` or `, remote unknown (<error>)`, from the lookup's result. */
function originPart(result) {
  if (result.ok) return `, origin ${redactRemoteUrl(result.stdout.trim())}`;
  if (result.status === NO_SUCH_REMOTE_STATUS) return ', no origin remote';
  return `, remote unknown (${result.error || 'git failed'})`;
}

/** `, lock held by <holder>` (with `(stale)` when it is), or '' when the realm is free. */
function lockPart(folder) {
  const lock = peekRealmLock(folder);
  if (!lock.held) return '';
  return `, lock held by ${describeHolder(lock.holder)}${lock.stale ? ' (stale)' : ''}`;
}

/**
 * `, <n> commits`, `, no commits yet` on an unborn branch, or `, commit count
 * unknown (<error>)`. The unborn probe runs only when the count's git exited:
 * after a timeout a second 5 s wait says nothing new.
 */
function commitsPart(folder, runGit) {
  const options = { cwd: folder, timeoutMs: DOCTOR_GIT_TIMEOUT_MS };
  const count = runGit(['rev-list', '--count', 'HEAD'], options);
  if (count.ok) return `, ${count.stdout.trim()} commits`;
  const unknown = `, commit count unknown (${count.error || 'git failed'})`;
  if (!gitAnswered(count)) return unknown;
  const head = runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], options);
  if (!head.ok && head.status === UNRESOLVED_REV_STATUS) return ', no commits yet';
  return unknown;
}

/**
 * One realm's row value: what its `.git` is and, for a checkout, remote, lock
 * and history. When the origin lookup got no answer from git, the history is
 * not asked for: it would wait out the same timeout.
 */
function describeRealm(folder, runGit) {
  const kind = gitDirKind(folder);
  if (kind === 'none') return 'not a checkout (no .git)';
  if (kind === 'file') return '.git is a file (worktree or submodule): not synced';
  const origin = runGit(['remote', 'get-url', 'origin'], { cwd: folder, timeoutMs: DOCTOR_GIT_TIMEOUT_MS });
  const history = gitAnswered(origin) ? commitsPart(folder, runGit) : COUNT_SKIPPED;
  return `git checkout${originPart(origin)}${lockPart(folder)}${history}`;
}

/** Realm names from HARNESS_REALMS (`name:mode,…`), in order. */
function listedRealms(merged) {
  return String(merged.HARNESS_REALMS ?? '')
    .split(',')
    .map((entry) => entry.trim().split(':')[0])
    .filter(Boolean);
}

/** `git email`, `realms missing` and one `realm <name>` row per realm on disk. */
function realmRows(merged, vaultRoot, realms, listed, runGit) {
  const onDisk = realms.map((r) => r.name);
  const missing = listed.filter((name) => !onDisk.includes(name));
  return [
    ['git email', gitEmail(merged) || '(unset: git config identity applies to realm commits)'],
    ['realms missing', missing.length ? missing.join(', ') : 'none'],
    ...realms.map((r) => [`realm ${r.name}`, describeRealm(path.join(vaultRoot, r.folder), runGit)]),
  ];
}

/**
 * The report as rows; `main` prints them. Exported for the tests, which
 * script `runGit` so only one of them spawns git.
 */
export function diagnose(env = process.env, home = os.homedir(), { runGit = runGitSync } = {}) {
  const machineFile = env[MACHINE_ENV_VAR] || path.join(home, ...MACHINE_ENV_SEGMENTS);
  const merged = loadMachineEnv(loadRepoEnv(env, path.resolve(HERE, '..')), home);
  const vaultRoot = merged[VAULT_ENV_VAR] || path.join(home, ...DEFAULT_VAULT_SEGMENTS);
  const projectDir = merged[ENV_PROJECT_DIR] || DEFAULT_PROJECT_DIR;
  const realms = realmsOnDisk(vaultRoot);
  const listed = listedRealms(merged);
  const unlisted = realms.map((r) => r.name).filter((name) => listed.length && !listed.includes(name));
  const uv = resolveUv(merged);
  const distIndex = path.resolve(HERE, '..', 'mcp-server', 'dist', 'index.js');

  const rows = [
    ['machine file', fs.existsSync(machineFile) ? machineFile : `${machineFile} (absent: defaults apply)`],
    ['machine', machineName(merged) || '(unset: notes carry machine: \'\')'],
    ['vault', `${vaultRoot} ${fs.existsSync(vaultRoot) ? '' : '(MISSING)'}`.trim()],
    ['realms on disk', realms.length ? realms.map((r) => `${r.folder}=${r.name}`).join(', ') : '(none: legacy layout)'],
    ['realms listed', listed.length ? listed.join(', ') : '(HARNESS_REALMS unset: any realm on disk is accepted)'],
    ['realms unlisted', unlisted.length ? `${unlisted.join(', ')} — ingest will refuse` : 'none'],
    ...realmRows(merged, vaultRoot, realms, listed, runGit),
    ['ingest project', `${projectDir} ${fs.existsSync(path.join(projectDir, 'pyproject.toml')) ? '' : '(MISSING pyproject.toml)'}`.trim()],
    ['uv', uv || '(not found: ~/.local/bin or PATH)'],
    ['node', process.execPath],
    ['mcp-server build', fs.existsSync(distIndex) ? distIndex : `${distIndex} (not built: npm run build)`],
    ['DATABASE_URL', merged.DATABASE_URL ? 'set' : 'ABSENT'],
    ['DATABASE_CA_CERT', merged.DATABASE_CA_CERT ? `${merged.DATABASE_CA_CERT} ${fs.existsSync(merged.DATABASE_CA_CERT) ? '' : '(MISSING)'}`.trim() : '(unset)'],
    ['DATABASE_SSL', merged.DATABASE_SSL || '(default: verify-full)'],
    ['transcripts', path.join(home, '.claude', 'projects')],
  ];
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

/** The rows as `main` prints them: labels padded into one column, one row a line. */
export function formatRows(rows) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log(formatRows(diagnose()));
}
