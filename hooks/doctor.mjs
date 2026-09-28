#!/usr/bin/env node
/**
 * What this machine's harness resolved to, in one screen.
 *
 *   node hooks/doctor.mjs [--strict]
 *
 * Read-only. Every path below is what the hook, the sweep and the ingest would
 * use right now, after ~/.harness/machine.env is loaded; a wrong one here is a
 * wrong one at 03:00. Secrets are reported as present or absent, never shown.
 *
 * Each row is `[label, value, problem]`: `problem` is true when the row names
 * something that stops the harness working (a missing vault, no uv, an
 * unregistered hook). A plain run prints the rows and exits 0 whatever they
 * say. `--strict` prints the same report, then the problem rows by label, and
 * exits 1 if there is any (the bootstrap's last step); 2 is a bad argument.
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
import { CONFIG_REPO_SLUG, SCAN_EXCEPTIONS_FILE } from './lib/claude-config.mjs';
import { DEFAULT_PROJECT_DIR, ENV_PROJECT_DIR, resolveUv } from './lib/enqueue-ingest.mjs';
import { isEntryPoint } from './lib/entry-point.mjs';
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
import { registrationStatus } from './lib/settings.mjs';
import { LOG_ENV_VAR as SESSION_START_LOG_VAR } from './lib/start-brief.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** One report row. `problem` is what `--strict` counts; the printed text never depends on it. */
const row = (label, value, problem = false) => Object.freeze([label, value, problem]);

/** The rows that name a problem. */
export function problemRows(rows) {
  return rows.filter(([, , problem]) => problem === true);
}

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
    row('git email', gitEmail(merged) || '(unset: git config identity applies to realm commits)'),
    row('realms missing', missing.length ? missing.join(', ') : 'none', missing.length > 0),
    ...realms.map((r) => row(`realm ${r.name}`, describeRealm(path.join(vaultRoot, r.folder), runGit))),
  ];
}

/** settings.json parsed, or `{error}` naming why not. Never its text: it can hold tokens. */
function readSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT' ? { settings: {} } : { error: `settings.json unreadable: ${err?.code || 'error'}` };
  }
  if (!raw.trim()) return { settings: {} };
  try {
    return { settings: JSON.parse(raw) };
  } catch {
    return { error: 'settings.json is not valid JSON' };
  }
}

/** Whether SessionStart runs the installed `session-start.mjs` (R-H4). */
function sessionStartRow(home) {
  const claudeDir = path.join(home, '.claude');
  const read = readSettings(path.join(claudeDir, 'settings.json'));
  if (read.error) return row('SessionStart hook', `(${read.error})`, true);
  const status = registrationStatus(read.settings, 'SessionStart', path.join(claudeDir, 'hooks'));
  if (status.state === 'missing') {
    return row('SessionStart hook', '(not registered: node hooks/install.mjs registers it)', true);
  }
  if (status.state === 'wrong-script') {
    return row('SessionStart hook', `(wrong script: ${status.script}; expected ${status.expected})`, true);
  }
  if (!fs.existsSync(status.script)) {
    return row('SessionStart hook', `registered: ${status.script} (MISSING: node hooks/install.mjs)`, true);
  }
  return row('SessionStart hook', `registered: ${status.script}`);
}

/** Enough of the log's end to hold its last line. */
const LOG_TAIL_BYTES = 4096;
/** Ages print in hours up to two days (`36h`), then in days. */
const HOURS_BEFORE_DAYS = 48;

/** `40s`, `5m`, `36h`, `3d`. */
function formatAge(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < HOURS_BEFORE_DAYS) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The log's last non-empty line, or null when there is no log. */
function lastLogLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n').map((line) => line.trim()).filter(Boolean);
    return lines.at(-1) ?? null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * How long ago the start hook last wrote its log (every run writes at least
 * one line). Informational: a machine that has not started a session since
 * install has no log, and that is not a fault. Only the timestamp is read out.
 */
function sessionStartLogRow(merged, home, now) {
  const file = merged[SESSION_START_LOG_VAR] || path.join(home, '.claude', 'hooks', 'session-start.log');
  let line;
  try {
    line = lastLogLine(file);
  } catch (err) {
    return row('session-start log', `${file} (unreadable: ${err?.code || 'error'})`);
  }
  if (line === null) return row('session-start log', `${file} (none yet: no session has started since install)`);
  const at = Date.parse(line.split(' ', 1)[0]);
  if (Number.isNaN(at)) return row('session-start log', `${file}, last line undated`);
  return row('session-start log', `${file}, last line ${formatAge(now() - at)} ago`);
}

/** The clone bootstrap step 7 makes and `install.mjs --config` reads (R-H5). */
const CONFIG_REPO_DIRNAME = 'claude-config';
/** https, ssh:// or scp-style GitHub remotes of the one repo the config may live in (userinfo already stripped). */
const CONFIG_REMOTE = /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]emstacho-su\/claude-config(?:\.git)?\/?$/i;

/** `last commit 3d ago`, `no commits yet` or `last commit unknown (<error>)`. Only the timestamp is read. */
function lastCommitPart(dir, runGit, now) {
  const options = { cwd: dir, timeoutMs: DOCTOR_GIT_TIMEOUT_MS };
  const log = runGit(['log', '-1', '--format=%ct'], options);
  const seconds = log.ok ? Number(log.stdout.trim()) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return `last commit ${formatAge(now() - seconds * 1000)} ago`;
  const unknown = `last commit unknown (${log.error || 'no date'})`;
  if (log.ok || !gitAnswered(log)) return unknown;
  const head = runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], options);
  return !head.ok && head.status === UNRESOLVED_REV_STATUS ? 'no commits yet' : unknown;
}

/**
 * The claude-config clone. Not having one is not a fault (bootstrap step 7
 * makes it); a clone whose origin is anything but the private repo is, since
 * an export would commit the config toward it. Never reads a tracked file.
 */
function claudeConfigRow(home, runGit, now) {
  const dir = path.join(home, CONFIG_REPO_DIRNAME);
  if (!fs.existsSync(dir)) return row('claude-config', `${dir} (not cloned on this machine)`);
  if (gitDirKind(dir) === 'none') return row('claude-config', `${dir} (exists but is not a git clone)`, true);
  const origin = runGit(['remote', 'get-url', 'origin'], { cwd: dir, timeoutMs: DOCTOR_GIT_TIMEOUT_MS });
  if (!origin.ok) {
    const why = origin.status === NO_SUCH_REMOTE_STATUS ? 'no origin remote' : `remote unknown (${origin.error || 'git failed'})`;
    return row('claude-config', `${dir}, ${why} (expected ${CONFIG_REPO_SLUG})`, true);
  }
  const url = redactRemoteUrl(origin.stdout.trim());
  if (!CONFIG_REMOTE.test(url)) return row('claude-config', `${dir}, origin ${url} (expected ${CONFIG_REPO_SLUG})`, true);
  const exceptions = fs.existsSync(path.join(dir, SCAN_EXCEPTIONS_FILE))
    ? `${SCAN_EXCEPTIONS_FILE} present`
    : `no ${SCAN_EXCEPTIONS_FILE}`;
  return row('claude-config', `${dir}, origin ${url}, ${lastCommitPart(dir, runGit, now)}, ${exceptions}`);
}

/**
 * The report as rows; `main` prints them. Exported for the tests, which
 * script `runGit` so only one of them spawns git.
 */
export function diagnose(env = process.env, home = os.homedir(), { runGit = runGitSync, now = Date.now } = {}) {
  const machineFile = env[MACHINE_ENV_VAR] || path.join(home, ...MACHINE_ENV_SEGMENTS);
  const merged = loadMachineEnv(loadRepoEnv(env, path.resolve(HERE, '..')), home);
  const vaultRoot = merged[VAULT_ENV_VAR] || path.join(home, ...DEFAULT_VAULT_SEGMENTS);
  const projectDir = merged[ENV_PROJECT_DIR] || DEFAULT_PROJECT_DIR;
  const realms = realmsOnDisk(vaultRoot);
  const listed = listedRealms(merged);
  const unlisted = realms.map((r) => r.name).filter((name) => listed.length && !listed.includes(name));
  const uv = resolveUv(merged);
  const distIndex = path.resolve(HERE, '..', 'mcp-server', 'dist', 'index.js');
  const machineFileFound = fs.existsSync(machineFile);
  const vaultFound = fs.existsSync(vaultRoot);
  const projectFound = fs.existsSync(path.join(projectDir, 'pyproject.toml'));
  const built = fs.existsSync(distIndex);
  const caCert = merged.DATABASE_CA_CERT;
  const caCertMissing = Boolean(caCert) && !fs.existsSync(caCert);

  const rows = [
    row('machine file', machineFileFound ? machineFile : `${machineFile} (absent: defaults apply)`, !machineFileFound),
    row('machine', machineName(merged) || '(unset: notes carry machine: \'\')'),
    row('vault', `${vaultRoot} ${vaultFound ? '' : '(MISSING)'}`.trim(), !vaultFound),
    row('realms on disk', realms.length ? realms.map((r) => `${r.folder}=${r.name}`).join(', ') : '(none: legacy layout)'),
    row('realms listed', listed.length ? listed.join(', ') : '(HARNESS_REALMS unset: any realm on disk is accepted)'),
    row('realms unlisted', unlisted.length ? `${unlisted.join(', ')} — ingest will refuse` : 'none', unlisted.length > 0),
    ...realmRows(merged, vaultRoot, realms, listed, runGit),
    row('ingest project', `${projectDir} ${projectFound ? '' : '(MISSING pyproject.toml)'}`.trim(), !projectFound),
    row('uv', uv || '(not found: ~/.local/bin or PATH)', !uv),
    row('node', process.execPath),
    row('mcp-server build', built ? distIndex : `${distIndex} (not built: npm run build)`, !built),
    row('DATABASE_URL', merged.DATABASE_URL ? 'set' : 'ABSENT', !merged.DATABASE_URL),
    row('DATABASE_CA_CERT', caCert ? `${caCert} ${caCertMissing ? '(MISSING)' : ''}`.trim() : '(unset)', caCertMissing),
    row('DATABASE_SSL', merged.DATABASE_SSL || '(default: verify-full)'),
    claudeConfigRow(home, runGit, now),
    sessionStartRow(home),
    sessionStartLogRow(merged, home, now),
    row('transcripts', path.join(home, '.claude', 'projects')),
  ];
  return Object.freeze(rows);
}

/** The rows as `main` prints them: labels padded into one column, one row a line. */
export function formatRows(rows) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
}

export const EXIT_OK = 0;
export const EXIT_PROBLEMS = 1;
export const EXIT_USAGE = 2;
const STRICT_FLAG = '--strict';

/**
 * One doctor run: print the report and return the exit code. `rows` builds
 * the report (called only once the arguments are good); `write` prints a block.
 */
export function runDoctor(argv, { rows = () => diagnose(), write = (text) => console.log(text) } = {}) {
  const unknown = argv.filter((arg) => arg !== STRICT_FLAG);
  if (unknown.length) {
    write(`doctor: unknown argument: ${unknown[0]}\nusage: node hooks/doctor.mjs [${STRICT_FLAG}]`);
    return EXIT_USAGE;
  }
  const report = rows();
  write(formatRows(report));
  if (!argv.includes(STRICT_FLAG)) return EXIT_OK;

  const problems = problemRows(report);
  if (problems.length === 0) {
    write('doctor --strict: no problems');
    return EXIT_OK;
  }
  write(`doctor --strict: ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
  for (const [label] of problems) write(`  problem: ${label}`);
  return EXIT_PROBLEMS;
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = runDoctor(process.argv.slice(2));
}
