/**
 * `~/.claude` as a portable config repo (R-H5).
 *
 * The folder is half of what "the harness" is — CLAUDE.md, rules, skills — and
 * it also holds live credentials, session history and per-project memory. So
 * nothing here ever asks "what should be left out?". It walks an ALLOWLIST and
 * nothing else, and inside that it still refuses anything the DENYLIST names,
 * matched on every path segment, because a skill folder can carry a `.env` or a
 * `node_modules/` of its own. Symlinks are never followed: a link inside
 * `skills/` can point anywhere, including back at the credentials.
 *
 * Pure planning only. Nothing here writes a file; the CLIs built on top
 * (`install.mjs --config`, `export-config.mjs`) do the copying, and refuse to
 * commit when `scanForSecrets` finds anything that the reviewed
 * `.scan-exceptions.json` does not cover.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { findSecretMatches } from './redact.mjs';
import { commandScript } from './settings.mjs';
import { toPosix } from './text.mjs';

/** The private GitHub repo the config lives in. Creating it is live step L2. */
export const CONFIG_REPO_SLUG = 'emstacho-su/claude-config';

/** The generated, secret-free half of settings.json that travels instead of it. */
export const SETTINGS_TEMPLATE_FILE = 'settings.template.json';

/** Stands in for the home directory in the template; forward slashes follow it. */
export const HOME_PLACEHOLDER = '{{HOME}}';

/** Config is prose and small scripts. Anything bigger is reported, not copied. */
export const MAX_CONFIG_FILE_BYTES = 1024 * 1024;

/** What travels. `generated` is written by the exporter, never copied from disk. */
export const ALLOWLIST = deepFreeze([
  { path: 'CLAUDE.md', kind: 'file' },
  { path: 'rules', kind: 'dir' },
  { path: 'skills', kind: 'dir' },
  { path: 'skill-vault', kind: 'dir' },
  { path: SETTINGS_TEMPLATE_FILE, kind: 'generated' },
]);

/**
 * Refused even inside an allowlisted folder. A trailing `/` matches directories
 * only; `*` matches within one segment; matching is case-insensitive, as the
 * Windows filesystem is.
 */
export const DENYLIST = deepFreeze([
  { pattern: '.credentials.json', reason: 'Claude Code OAuth credentials for this machine' },
  { pattern: 'history.jsonl', reason: 'every prompt typed on this machine, verbatim' },
  { pattern: 'projects/', reason: 'per-project transcripts and auto-memory' },
  { pattern: 'sessions/', reason: 'live session state' },
  { pattern: 'file-history/', reason: 'snapshots of files Claude edited, any of which may hold a secret' },
  { pattern: 'paste-cache/', reason: 'pasted text, the most common way a key reaches Claude' },
  { pattern: 'shell-snapshots/', reason: 'shell environment captures, which include exported secrets' },
  { pattern: 'telemetry/', reason: 'machine-local usage data' },
  { pattern: '*.log', reason: 'logs echo commands, paths and sometimes tokens' },
  { pattern: 'daemon*', reason: 'daemon state and its auth status files' },
  { pattern: 'settings.json', reason: 'holds env, apiKeyHelper and MCP config; only the template travels' },
  { pattern: 'settings.local.json', reason: 'per-machine overrides by definition; only the template travels' },
  { pattern: '.env*', reason: 'environment files exist to hold secrets' },
  { pattern: 'node_modules/', reason: 'installed dependencies: large, rebuildable and not config' },
  { pattern: '.git/', reason: 'a nested repository carries its own remotes and possibly credentials' },
  { pattern: '*.pem', reason: 'key or certificate material' },
  { pattern: '*.key', reason: 'private key material' },
  { pattern: '*.p12', reason: 'key-store bundle, usually with a private key' },
  { pattern: '*.pfx', reason: 'key-store bundle, usually with a private key' },
  { pattern: 'id_*', reason: 'SSH key pair names (id_rsa, id_ed25519 and their .pub)' },
]);

const COMPILED_DENYLIST = Object.freeze(
  DENYLIST.map(({ pattern }) => {
    const directoryOnly = pattern.endsWith('/');
    const glob = directoryOnly ? pattern.slice(0, -1) : pattern;
    const re = new RegExp(`^${glob.split('*').map(escapeRegExp).join('[^/]*')}$`, 'i');
    return Object.freeze({ pattern, directoryOnly, re });
  }),
);

/**
 * The denylist pattern that refuses `relPath`, or null.
 *
 * @param {string} relPath  forward-slash path relative to the config root
 * @param {{isDirectory?: boolean}} [options]  is the last segment a directory?
 */
export function denylistRule(relPath, { isDirectory = false } = {}) {
  const segments = toPosix(relPath).split('/').filter(Boolean);
  const directories = isDirectory ? segments : segments.slice(0, -1);
  const hit = COMPILED_DENYLIST.find((rule) =>
    (rule.directoryOnly ? directories : segments).some((segment) => rule.re.test(segment)),
  );
  return hit ? hit.pattern : null;
}

/**
 * What exporting `claudeDir` would copy, and what it would not, and why.
 *
 * @returns {{files: {path, size, sha256, source}[], refused: {path, rule}[],
 *   skipped: {path, reason}[], missing: string[]}}  frozen, each list sorted by path
 */
export function planExport(claudeDir) {
  requireDirectory(claudeDir, 'claudeDir');
  return deepFreeze(walkAllowlisted(claudeDir));
}

/**
 * Secret findings over files from a plan (read from `source`) or in memory
 * (`content`, e.g. the rendered template). Any finding means refuse.
 *
 * Binary files are scanned, not skipped: a token inside a blob is still a
 * token, and every rule matches ASCII only, so latin1 decoding sees exactly
 * the bytes a real key would be made of. A file that cannot be read is a
 * finding: an unscanned file is not a clean one.
 *
 * @param {{path: string, source?: string, content?: string|Buffer}[]} files
 * @returns {{clean: boolean, findings: {path, rule, line}[]}}  frozen; never the secret
 */
export function scanForSecrets(files) {
  if (!Array.isArray(files)) throw new TypeError('scanForSecrets expects a list of files');
  const findings = files.flatMap(scanOne);
  const unique = [...new Map(findings.map((f) => [`${f.path}\0${f.line}\0${f.rule}`, f])).values()];
  const sorted = unique.sort((a, b) => compareText(a.path, b.path) || a.line - b.line || compareText(a.rule, b.rule));
  return deepFreeze({ clean: sorted.length === 0, findings: sorted });
}

function scanOne(file) {
  const relPath = String(file?.path ?? '');
  let text;
  try {
    text = file.content !== undefined ? decode(file.content) : decode(fs.readFileSync(file.source));
  } catch {
    return [{ path: relPath, rule: 'unreadable', line: 0 }];
  }
  return findSecretMatches(text).map(({ rule, index }) => ({ path: relPath, rule, line: lineAt(text, index) }));
}

/** Git's heuristic: a NUL in the first 8000 bytes means binary. */
const BINARY_SNIFF_BYTES = 8000;

function decode(content) {
  if (typeof content === 'string') return content;
  if (!Buffer.isBuffer(content)) throw new TypeError('content must be a string or Buffer');
  const binary = content.subarray(0, BINARY_SNIFF_BYTES).includes(0);
  return content.toString(binary ? 'latin1' : 'utf8');
}

function lineAt(text, index) {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line += 1;
  return line;
}

// ---------------------------------------------------------------------------
// .scan-exceptions.json: findings Stack has read and accepted
// ---------------------------------------------------------------------------

/** The reviewed exceptions list, at the root of the config repo. The tools read it; only a person writes it. */
export const SCAN_EXCEPTIONS_FILE = '.scan-exceptions.json';

/** Top-level repo files that may sit beside the allowlist. They are never installed. */
export const REPO_META_FILES = Object.freeze(['.gitattributes', '.gitignore', 'README.md', SCAN_EXCEPTIONS_FILE]);

const EXCEPTION_KEYS = Object.freeze(['path', 'rule', 'line', 'sha256']);
/** A free-text note on why the finding was accepted; read by people, ignored by the match. */
const EXCEPTION_OPTIONAL_KEYS = Object.freeze(['reason']);
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The exceptions list, validated. An empty file is an empty list; anything
 * else that is not exactly a list of `{path, rule, line, sha256[, reason]}`
 * throws, because a typo that silently excepted nothing would look like a
 * scanner bug, and one that silently excepted everything would be worse.
 */
export function parseScanExceptions(text) {
  if (typeof text !== 'string' || text.trim() === '') return Object.freeze([]);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${SCAN_EXCEPTIONS_FILE} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${SCAN_EXCEPTIONS_FILE} must be a JSON list of {path, rule, line, sha256}`);
  return Object.freeze(parsed.map(checkException));
}

function checkException(entry, index) {
  const where = `${SCAN_EXCEPTIONS_FILE} entry ${index}`;
  if (!isPlainObject(entry)) throw new Error(`${where} must be an object`);
  const unknown = Object.keys(entry).find((key) => !EXCEPTION_KEYS.includes(key) && !EXCEPTION_OPTIONAL_KEYS.includes(key));
  if (unknown) throw new Error(`${where} has an unknown key "${unknown}"`);
  if (typeof entry.path !== 'string' || entry.path === '') throw new Error(`${where}: path must be a non-empty string`);
  if (typeof entry.rule !== 'string' || entry.rule === '') throw new Error(`${where}: rule must be a non-empty string`);
  if (!Number.isInteger(entry.line) || entry.line < 1) throw new Error(`${where}: line must be a whole number from 1`);
  if (typeof entry.sha256 !== 'string' || !SHA256_HEX.test(entry.sha256)) {
    throw new Error(`${where}: sha256 must be 64 lowercase hex characters`);
  }
  return exceptionEntry(entry, entry.sha256);
}

/** What `--list-findings` prints for a finding: exactly the four fields a match needs, never the value. */
export function exceptionEntry(finding, sha256) {
  return Object.freeze({ path: finding.path, rule: finding.rule, line: finding.line, sha256 });
}

/**
 * Split findings into those an exception covers and those it does not.
 *
 * A finding is excepted only when path, rule, line AND the scanned content's
 * SHA-256 all match an entry, so any edit to the file, even one elsewhere in
 * it, brings the finding back for another read.
 *
 * @param {(path: string) => string|undefined} hashOf  the hash of the content that was scanned
 */
export function partitionFindings(findings, exceptions, hashOf) {
  if (!Array.isArray(findings) || !Array.isArray(exceptions) || typeof hashOf !== 'function') {
    throw new TypeError('partitionFindings(findings[], exceptions[], hashOf)');
  }
  const key = (p, rule, line, hash) => `${p}\0${rule}\0${line}\0${hash}`;
  const accepted = new Set(exceptions.map((e) => key(e.path, e.rule, e.line, e.sha256)));
  const isExcepted = (f) => accepted.has(key(f.path, f.rule, f.line, hashOf(f.path)));
  return Object.freeze({
    unexcepted: Object.freeze(findings.filter((f) => !isExcepted(f))),
    excepted: Object.freeze(findings.filter(isExcepted)),
  });
}

// ---------------------------------------------------------------------------
// Which paths the repo may hold at all
// ---------------------------------------------------------------------------

const ALLOWED_TOP_FILES = Object.freeze(ALLOWLIST.filter((e) => e.kind !== 'dir').map((e) => e.path));
const ALLOWED_TOP_DIRS = Object.freeze(ALLOWLIST.filter((e) => e.kind === 'dir').map((e) => e.path));

/**
 * Why a file may not be committed to the config repo, or null when it may.
 *
 * The allowlist and the repo's own meta files, matched exactly (git paths are
 * case-sensitive), then the denylist on every segment. The pre-commit hook
 * runs this over the staged tree, so a hand-made commit is held to the same
 * list as an export.
 *
 * @returns {null|'not-allowlisted'|`denylist:${string}`}
 */
export function repoPathRule(relPath) {
  const segments = toPosix(String(relPath ?? '')).split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return 'not-allowlisted';
  const [top] = segments;
  const allowed =
    segments.length === 1
      ? ALLOWED_TOP_FILES.includes(top) || REPO_META_FILES.includes(top)
      : ALLOWED_TOP_DIRS.includes(top);
  if (!allowed) return 'not-allowlisted';
  const rule = denylistRule(segments.join('/'));
  return rule ? `denylist:${rule}` : null;
}

// ---------------------------------------------------------------------------
// settings.template.json
// ---------------------------------------------------------------------------

/** The only settings keys that travel. env, model, apiKeyHelper, mcpServers never do. */
const TEMPLATE_KEYS = Object.freeze(['hooks', 'permissions']);

/**
 * The portable half of settings.json: `hooks` and `permissions` only, with
 * every absolute path under `home` rewritten to `{{HOME}}/…` in forward slashes.
 *
 * A path is rewritten only up to the first quote, space or `)`: a permission
 * like `Read(C:\Users\me\OneDrive - Uni\**)` keeps the placeholder but not the
 * slash conversion past the space. Returns a new object; `settings` is untouched.
 */
export function buildSettingsTemplate(settings, { home } = {}) {
  requirePlainObject(settings, 'settings');
  const pattern = homePattern(requireHome(home));
  const replace = (value) =>
    value.replace(pattern, (_match, tail) => `${HOME_PLACEHOLDER}${tail.replace(/[\\/]+/g, '/')}`);
  return pickTemplateKeys(settings, replace);
}

/** A template made concrete for the machine whose home is `home`. */
export function renderSettingsTemplate(template, { home } = {}) {
  requirePlainObject(template, 'template');
  const target = toPosix(requireHome(home)).replace(/\/+$/, '');
  return pickTemplateKeys(template, (value) => value.split(HOME_PLACEHOLDER).join(target));
}

function pickTemplateKeys(source, mapString) {
  const picked = TEMPLATE_KEYS.filter((key) => source[key] !== undefined).map((key) => {
    requirePlainObject(source[key], key);
    return [key, mapStrings(source[key], mapString)];
  });
  return Object.fromEntries(picked);
}

/**
 * Every spelling of `home` at a path boundary: `C:\Users\me`, `c:/users/ME`,
 * MSYS `/c/Users/me`. Group 1 is the rest of the path.
 */
function homePattern(home) {
  const posix = toPosix(home).replace(/\/+$/, '');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(posix);
  const segments = (drive ? drive[2] : posix).split('/').filter(Boolean);
  if (segments.length === 0) throw new TypeError(`home must not be a filesystem root: ${home}`);

  const sep = '[\\\\/]+';
  const pathChar = '[^\\\\/"\'`\\s)]';
  const prefix = drive ? `(?:${drive[1]}:${sep}|/${drive[1]}/)` : '/';
  const body = segments.map(escapeRegExp).join(sep);
  const source = `(?<![\\w.\\\\/-])${prefix}${body}(?!${pathChar})((?:${sep}${pathChar}*)*)`;
  return new RegExp(source, drive ? 'gi' : 'g');
}

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)]));
  }
  return value;
}

// ---------------------------------------------------------------------------
// Merging a rendered template into a machine's settings.json
// ---------------------------------------------------------------------------

/**
 * `settings` with the template's hooks and permissions added, as a new object.
 *
 * Add-only, like the hook installer's merge: a hook entry is added when no
 * entry for that event already runs the same script (recognised by
 * `commandScript`, so slashes, case and the node in front do not matter); a
 * permissions list gains the rules it lacks; a permissions setting the machine
 * does not have is added, one it has is kept. Nothing is removed and every
 * other key is left as it was, so a second merge changes nothing.
 *
 * A template hook whose executable is a node path that does not exist here
 * (`exists`) is rewritten to run `nodePath`: the template carries the node of
 * the machine that exported it.
 *
 * @returns {{settings, hooksAdded: {event, script}[], nodeRewritten: {event, from, to}[],
 *   permissionsAdded: {key, value}[], permissionsKept: {key}[], changed: boolean}}
 */
export function mergeSettingsTemplate(settings, template, { nodePath, exists = fs.existsSync } = {}) {
  requirePlainObject(template, 'template');
  if (typeof nodePath !== 'string' || nodePath === '') throw new TypeError('mergeSettingsTemplate needs a nodePath');
  const source = isPlainObject(settings) ? settings : {};
  const hooks = mergeHooks(source.hooks, template.hooks, { nodePath, exists });
  const permissions = mergePermissions(source.permissions, template.permissions);
  const changed = hooks.changed || permissions.changed;
  const next = {
    ...source,
    ...(hooks.changed ? { hooks: hooks.value } : {}),
    ...(permissions.changed ? { permissions: permissions.value } : {}),
  };
  return {
    settings: changed ? next : source,
    hooksAdded: hooks.added,
    nodeRewritten: hooks.rewritten,
    permissionsAdded: permissions.added,
    permissionsKept: permissions.kept,
    changed,
  };
}

function mergeHooks(current, template, { nodePath, exists }) {
  const none = { changed: false, value: current, added: [], rewritten: [] };
  if (template === undefined) return none;
  requirePlainObject(template, 'template hooks');
  if (current !== undefined) requirePlainObject(current, 'settings.json hooks');
  const value = { ...(current ?? {}) };
  const added = [];
  const rewritten = [];
  for (const [event, groups] of Object.entries(template)) {
    if (!Array.isArray(groups)) throw new TypeError(`template hooks.${event} must be a list`);
    const seen = new Set(hookEntries(value[event]).map(entryKey));
    const newGroups = groups.flatMap((group) => {
      const missing = hookEntries([group]).filter((entry) => !seen.has(entryKey(entry)));
      missing.forEach((entry) => seen.add(entryKey(entry)));
      if (missing.length === 0) return [];
      const entries = missing.map((entry) => withMachineNode(entry, { nodePath, exists }));
      entries.forEach(({ from }) => from && rewritten.push({ event, from, to: toPosix(nodePath) }));
      missing.forEach((entry) => added.push({ event, script: commandScript(entry.command) }));
      return [{ ...group, hooks: entries.map(({ entry }) => entry) }];
    });
    if (newGroups.length) value[event] = [...(Array.isArray(value[event]) ? value[event] : []), ...newGroups];
  }
  return added.length ? { changed: true, value, added, rewritten } : none;
}

function hookEntries(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) => (group && Array.isArray(group.hooks) ? group.hooks : [])).filter(isPlainObject);
}

/** A command entry is its script (or its whole command when it runs none); anything else, its JSON. */
function entryKey(entry) {
  if (entry.type === 'command' && typeof entry.command === 'string') {
    return `command\0${comparablePath(commandScript(entry.command) || entry.command)}`;
  }
  return `other\0${JSON.stringify(entry)}`;
}

/** The executable of a command line: a leading double-quoted run, or the first bare word. */
const LEADING_WORD = /^\s*(?:"([^"]*)"|(\S+))/;
const NODE_EXECUTABLE = /^node(?:\.exe)?$/i;

/** `{entry, from}`: the entry, with a missing node path swapped for `nodePath`; `from` is what was swapped. */
function withMachineNode(entry, { nodePath, exists }) {
  if (entry.type !== 'command' || typeof entry.command !== 'string') return { entry };
  const match = LEADING_WORD.exec(entry.command);
  const executable = match ? (match[1] ?? match[2]) : '';
  const isNodePath = /[\\/]/.test(executable) && NODE_EXECUTABLE.test(path.basename(toPosix(executable)));
  if (!isNodePath || exists(executable)) return { entry };
  const command = `"${toPosix(nodePath)}"${entry.command.slice(match[0].length)}`;
  return { entry: { ...entry, command }, from: executable };
}

function mergePermissions(current, template) {
  const none = { changed: false, value: current, added: [], kept: [] };
  if (template === undefined) return none;
  requirePlainObject(template, 'template permissions');
  if (current !== undefined) requirePlainObject(current, 'settings.json permissions');
  const value = { ...(current ?? {}) };
  const added = [];
  const kept = [];
  for (const [key, wanted] of Object.entries(template)) {
    const have = value[key];
    if (have === undefined) {
      value[key] = Array.isArray(wanted) ? [...wanted] : wanted;
      added.push(...(Array.isArray(wanted) ? wanted.map((item) => ({ key, value: item })) : [{ key, value: wanted }]));
    } else if (Array.isArray(wanted) && Array.isArray(have)) {
      const present = new Set(have.map(comparableRule));
      const missing = wanted.filter((item) => !present.has(comparableRule(item)));
      if (missing.length) value[key] = [...have, ...missing];
      added.push(...missing.map((item) => ({ key, value: item })));
    } else if (JSON.stringify(have) !== JSON.stringify(wanted)) {
      kept.push({ key });
    }
  }
  return { changed: added.length > 0, value: added.length ? value : current, added, kept };
}

/** Two spellings of one path-bearing rule are one rule: `Read(C:\x\**)` and `Read(C:/x/**)`. */
function comparableRule(item) {
  return typeof item === 'string' ? toPosix(item) : JSON.stringify(item);
}

function comparablePath(value) {
  return toPosix(value).toLowerCase();
}

// ---------------------------------------------------------------------------
// planInstall
// ---------------------------------------------------------------------------

/**
 * What installing from a clone of the config repo would write into `claudeDir`.
 *
 * The repo is walked through the same allowlist and denylist as an export, so
 * a tampered repo cannot slip a `settings.json` or `.credentials.json` in under
 * `skills/`. A write whose target path runs through a link, or lands on a
 * directory, is `blocked` rather than followed. Top-level repo files outside the
 * allowlist (README, .gitignore) are listed in `ignored` and never installed.
 *
 * @param {{home?: string}} [options]  defaults to the parent of `claudeDir`
 * @returns frozen {files: {path, size, sha256, source, target, status, reason?}[],
 *   refused, skipped, missing, ignored, settingsTemplate: object|null}
 */
export function planInstall(configRepoDir, claudeDir, { home } = {}) {
  requireDirectory(configRepoDir, 'configRepoDir');
  if (typeof claudeDir !== 'string' || claudeDir === '') throw new TypeError('claudeDir must be a path');

  const walked = walkAllowlisted(configRepoDir);
  const files = walked.files.map((file) => ({ ...file, ...installStatus(claudeDir, file) }));
  const settingsTemplate = readTemplate(configRepoDir, home ?? path.dirname(claudeDir));
  return deepFreeze({ ...walked, files, ignored: ignoredTopLevel(configRepoDir), settingsTemplate });
}

function installStatus(claudeDir, file) {
  const segments = file.path.split('/');
  const target = path.join(claudeDir, ...segments);
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const stat = lstatOrNull(path.join(claudeDir, ...segments.slice(0, depth)));
    if (!stat) return { target, status: 'new' };
    if (stat.isSymbolicLink()) return { target, status: 'blocked', reason: 'target-symlink' };
    const isLast = depth === segments.length;
    if (!isLast && !stat.isDirectory()) return { target, status: 'blocked', reason: 'target-parent-not-directory' };
    if (isLast && !stat.isFile()) return { target, status: 'blocked', reason: 'target-not-a-file' };
  }
  return { target, status: sha256(fs.readFileSync(target)) === file.sha256 ? 'unchanged' : 'changed' };
}

function readTemplate(configRepoDir, home) {
  const file = path.join(configRepoDir, SETTINGS_TEMPLATE_FILE);
  const stat = lstatOrNull(file);
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`${SETTINGS_TEMPLATE_FILE} in ${configRepoDir} is not a regular file`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${SETTINGS_TEMPLATE_FILE} in ${configRepoDir} is not valid JSON: ${error.message}`);
  }
  return renderSettingsTemplate(parsed, { home });
}

/**
 * What exporting `sourcePlan` (a `planExport` result) into the clone at
 * `cloneDir` writes and deletes.
 *
 * Writes carry the same new/changed/unchanged/blocked status as an install. A
 * deletion is anything the clone holds under an allowlisted entry that the
 * source no longer exports: files, links and denylisted paths alike, so a stale
 * hazard in the clone is removed rather than kept. Nothing outside the
 * allowlisted entries (the `.git` folder, README, the exceptions list) is ever
 * a deletion. A clone path that differs from a source path only in case is
 * kept: on Windows they are the same file.
 *
 * @returns frozen {writes: {path, size, sha256, source, target, status, reason?}[],
 *   deletions: {path, target}[]}
 */
export function planMirror(sourcePlan, cloneDir) {
  if (!sourcePlan || !Array.isArray(sourcePlan.files)) throw new TypeError('planMirror needs a planExport result');
  requireDirectory(cloneDir, 'cloneDir');
  const writes = sourcePlan.files.map((file) => ({ ...file, ...installStatus(cloneDir, file) }));
  const exported = new Set(sourcePlan.files.map((file) => file.path.toLowerCase()));
  const walked = walkAllowlisted(cloneDir);
  const deletions = [...walked.files, ...walked.refused, ...walked.skipped]
    .filter((entry) => !exported.has(entry.path.toLowerCase()))
    .map((entry) => ({ path: entry.path, target: path.join(cloneDir, ...entry.path.split('/')) }))
    .sort((a, b) => compareText(a.path, b.path));
  return deepFreeze({ writes, deletions });
}

function ignoredTopLevel(configRepoDir) {
  const allowed = new Set(ALLOWLIST.map((entry) => entry.path.toLowerCase()));
  return fs
    .readdirSync(configRepoDir)
    .filter((name) => !allowed.has(name.toLowerCase()) && name !== '.git')
    .sort(compareText);
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

function walkAllowlisted(root) {
  const outcomes = [];
  const missing = [];
  for (const entry of ALLOWLIST.filter((item) => item.kind !== 'generated')) {
    const full = path.join(root, entry.path);
    const stat = lstatOrNull(full);
    if (!stat) missing.push(entry.path);
    else outcomes.push(...visit(entry.path, full, stat, entry.kind));
  }
  const byPath = (a, b) => compareText(a.path, b.path);
  const pick = (kind) => outcomes.filter((o) => o.kind === kind).map(({ kind: _k, ...rest }) => rest).sort(byPath);
  return { files: pick('file'), refused: pick('refused'), skipped: pick('skipped'), missing };
}

/** One path's outcome, or its subtree's. Never follows a link. */
function visit(relPath, full, stat, expectedKind) {
  const rule = denylistRule(relPath, { isDirectory: stat.isDirectory() });
  if (rule) return [{ kind: 'refused', path: relPath, rule }];
  if (stat.isSymbolicLink()) return [{ kind: 'skipped', path: relPath, reason: 'symlink' }];
  if (stat.isDirectory() && expectedKind !== 'file') return visitDirectory(relPath, full);
  if (stat.isFile() && expectedKind !== 'dir') return [readFileOutcome(relPath, full, stat)];
  return [{ kind: 'skipped', path: relPath, reason: 'not-a-regular-file' }];
}

function visitDirectory(relPath, full) {
  let names;
  try {
    names = fs.readdirSync(full);
  } catch {
    return [{ kind: 'skipped', path: relPath, reason: 'unreadable' }];
  }
  return names.flatMap((name) => {
    const childFull = path.join(full, name);
    const childRel = `${relPath}/${name}`;
    const stat = lstatOrNull(childFull);
    return stat ? visit(childRel, childFull, stat, 'any') : [{ kind: 'skipped', path: childRel, reason: 'unreadable' }];
  });
}

function readFileOutcome(relPath, full, stat) {
  if (stat.size > MAX_CONFIG_FILE_BYTES) return { kind: 'skipped', path: relPath, reason: 'size-cap' };
  try {
    const bytes = fs.readFileSync(full);
    return { kind: 'file', path: relPath, size: bytes.length, sha256: sha256(bytes), source: full };
  } catch {
    return { kind: 'skipped', path: relPath, reason: 'unreadable' };
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function lstatOrNull(full) {
  try {
    return fs.lstatSync(full);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function requireDirectory(dir, name) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError(`${name} must be a path`);
  const stat = lstatOrNull(dir) && fs.statSync(dir);
  if (!stat || !stat.isDirectory()) throw new Error(`${name} ${dir} is not a directory`);
}

function requireHome(home) {
  if (typeof home !== 'string' || home.trim() === '') throw new TypeError('home must be a non-empty path');
  return home;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requirePlainObject(value, name) {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be an object`);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Ordinal, not locale: the same order on every machine. */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
