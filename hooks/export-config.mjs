#!/usr/bin/env node
/**
 * Build the private `claude-config` repo from this machine's `~/.claude` (R-H5).
 *
 *   node hooks/export-config.mjs --dry-run|--apply|--list-findings
 *                                [--config-repo <dir>] [--source <claudeDir>]
 *
 * Defaults: `~/.claude` into the clone at `~/claude-config`. The clone must
 * already exist: creating the GitHub repo is live step L2, never this tool's.
 *
 * The order is the point. It scans FIRST — every allowlisted file and the
 * settings template it would write — with the capture hook's secret rules, and
 * any finding that the clone's reviewed `.scan-exceptions.json` does not cover
 * refuses the run before a single byte is copied. `--list-findings` prints each
 * finding with the exceptions entry that would accept it (path, rule, line and
 * the file's SHA-256, never the value), for a person to read and paste by hand;
 * this tool never writes that file.
 *
 * `--apply` then mirrors the allowlist into the clone (new and changed files
 * copied and verified, files the source no longer exports deleted from the
 * clone only), writes `settings.template.json` and `.gitattributes`, installs
 * the clone's pre-commit hook, and commits. It never pushes: that is L2.
 *
 * The pre-commit hook runs this script with `--pre-commit`, which scans the
 * staged tree (not the working tree) against the same rules, the same
 * exceptions and the same allowlist, so a commit made by hand is gated too.
 *
 * Exit codes: 0 done, 1 refused or failed, 2 bad arguments.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWLIST,
  CONFIG_REPO_SLUG,
  REPO_META_FILES,
  SCAN_EXCEPTIONS_FILE,
  SETTINGS_TEMPLATE_FILE,
  buildSettingsTemplate,
  exceptionEntry,
  parseScanExceptions,
  partitionFindings,
  planExport,
  planMirror,
  repoPathRule,
  scanForSecrets,
} from './lib/claude-config.mjs';
import { runGitSync } from './lib/git-log.mjs';
import { redactRemoteUrl } from './lib/realm-steps.mjs';
import { repoArgs, trustedSpawnOptions } from './lib/spawn.mjs';
import { toPosix } from './lib/text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The checkout this script runs from; the pre-commit hook calls back into it. */
const HARNESS_REPO = path.resolve(HERE, '..');

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;

const CONFIG_REMOTE_URL = `https://github.com/${CONFIG_REPO_SLUG}.git`;

/** Identifies the hook this tool installed; a pre-commit hook without it is someone else's. */
export const PRE_COMMIT_MARKER = '# claude-config secret gate (R-H5), installed by agentic-harness hooks/export-config.mjs';

/**
 * Byte-exact storage. The exceptions match on the SHA-256 of the content, so
 * git must not turn CRLF into LF on the way in or LF into CRLF on the way out:
 * the hash Stack accepted here has to be the hash on the next machine.
 */
const GITATTRIBUTES_TEXT = '# Byte-exact: .scan-exceptions.json matches on the SHA-256 of each file.\n* -text\n';

/** Local git only (no network), but a big skills tree takes a while to add. */
const GIT_LOCAL_TIMEOUT_MS = 60_000;
/** The commit runs the pre-commit hook, which scans every staged file. */
const GIT_COMMIT_TIMEOUT_MS = 300_000;
/** What `git cat-file --batch` may return for the whole staged tree. */
const MAX_STAGED_BYTES = 512 * 1024 * 1024;

const MODES = Object.freeze(['dry-run', 'apply', 'list-findings', 'pre-commit']);
const VALUE_FLAGS = Object.freeze({ '--config-repo': 'configRepo', '--source': 'source' });

class Refusal extends Error {}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** `{mode, configRepo, source}`; throws on anything else. `--pre-commit` is the hook's mode. */
export function parseArgs(argv, home = os.homedir()) {
  const modes = [];
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (VALUE_FLAGS[arg]) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} needs a value`);
      values[VALUE_FLAGS[arg]] = value;
      index += 1;
    } else if (arg.startsWith('--') && MODES.includes(arg.slice(2))) {
      modes.push(arg.slice(2));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (modes.length === 0) throw new Error('needs one of --dry-run, --apply, --list-findings');
  if (modes.length > 1) throw new Error('only one of --dry-run, --apply, --list-findings at a time');
  return {
    mode: modes[0],
    configRepo: path.resolve(values.configRepo ?? path.join(home, 'claude-config')),
    source: path.resolve(values.source ?? path.join(home, '.claude')),
  };
}

// ---------------------------------------------------------------------------
// The clone
// ---------------------------------------------------------------------------

/**
 * One spelling per place: the deepest existing ancestor resolved through
 * links and 8.3 names (git prints long paths), the rest appended as written,
 * forward slashes, lower case (Windows paths are case-insensitive).
 */
function comparablePath(value) {
  let existing = path.resolve(value);
  const rest = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  let real = existing;
  try {
    real = fs.realpathSync.native(existing);
  } catch {
    /* unreadable: compare as written */
  }
  return toPosix(path.join(real, ...rest)).replace(/\/+$/, '').toLowerCase();
}

/** Refuse unless `dir` is the top of a git checkout. Creating one is L2, so only say how. */
function requireClone(dir) {
  const top = fs.existsSync(dir)
    ? runGitSync(['rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: GIT_LOCAL_TIMEOUT_MS })
    : { ok: false };
  if (top.ok && comparablePath(top.stdout.trim()) === comparablePath(dir)) return;
  throw new Refusal(
    [
      `${dir} is not a git clone.`,
      'Creating the repo is a live step (L2), not this tool\'s. Once Stack has approved it:',
      `  gh repo create ${CONFIG_REPO_SLUG} --private`,
      `  git clone ${CONFIG_REMOTE_URL} ${toPosix(dir)}`,
    ].join('\n'),
  );
}

function refuseOverlap(source, clone) {
  const [a, b] = [comparablePath(source), comparablePath(clone)];
  if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
    throw new Refusal(`the source ${source} and the clone ${clone} overlap; they must be separate folders`);
  }
}

function originOf(clone) {
  const result = runGitSync(['remote', 'get-url', 'origin'], { cwd: clone, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  return result.ok ? `origin ${redactRemoteUrl(result.stdout.trim())}` : 'no origin remote';
}

/** Top-level entries of the clone that are neither the allowlist, the meta files nor `.git`. */
function foreignTopLevel(clone) {
  const known = new Set([...ALLOWLIST.map((entry) => entry.path), ...REPO_META_FILES, '.git']);
  return fs.readdirSync(clone).filter((name) => !known.has(name)).sort();
}

// ---------------------------------------------------------------------------
// Template, exceptions and the scan
// ---------------------------------------------------------------------------

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** settings.template.json's text, built from `<source>/settings.json` (never printed). */
function buildTemplateText(source) {
  const file = path.join(source, 'settings.json');
  let settings = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try {
      settings = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      throw new Refusal(`${file} is not valid JSON; the template cannot be built`);
    }
  }
  const template = buildSettingsTemplate(settings, { home: path.dirname(source) });
  return `${JSON.stringify(template, null, 2)}\n`;
}

function readExceptions(clone) {
  const file = path.join(clone, SCAN_EXCEPTIONS_FILE);
  try {
    return fs.existsSync(file) ? parseScanExceptions(fs.readFileSync(file, 'utf8')) : [];
  } catch (error) {
    throw new Refusal(`${error.message}; fix ${file} by hand`);
  }
}

/** Scan what would be exported: the planned files and the template, before anything is copied. */
function scanExport(plan, templateText, exceptions) {
  const hashes = new Map(plan.files.map((file) => [file.path, file.sha256]));
  hashes.set(SETTINGS_TEMPLATE_FILE, sha256(templateText));
  const { findings } = scanForSecrets([...plan.files, { path: SETTINGS_TEMPLATE_FILE, content: templateText }]);
  const hashOf = (p) => hashes.get(p);
  return { findings, hashOf, ...partitionFindings(findings, exceptions, hashOf) };
}

function printFindingsRefusal(scan) {
  console.error(`refusing: ${scan.unexcepted.length} secret finding(s) not in ${SCAN_EXCEPTIONS_FILE}; nothing copied`);
  for (const f of scan.unexcepted) console.error(`  finding  ${f.path}:${f.line} ${f.rule}`);
  console.error('Read each one. `--list-findings` prints the entry that would accept it, for you to paste by hand.');
}

// ---------------------------------------------------------------------------
// The pre-commit hook
// ---------------------------------------------------------------------------

/** Characters that would break out of a double-quoted sh word. */
const UNSAFE_IN_HOOK = /["$`\\]/;

/**
 * The hook's text. It runs `node <harness>/hooks/export-config.mjs --pre-commit`
 * with the node and the checkout that installed it, each overridable at commit
 * time by HARNESS_NODE and HARNESS_REPO. If the script is not there, it refuses
 * the commit: a gate that cannot run must not pass.
 */
export function preCommitHookScript({ node, harnessRepo }) {
  const [nodePath, repoPath] = [toPosix(node), toPosix(harnessRepo)];
  for (const value of [nodePath, repoPath]) {
    if (!value || UNSAFE_IN_HOOK.test(value)) throw new Error(`${value} cannot be written into the hook safely`);
  }
  return [
    '#!/bin/sh',
    PRE_COMMIT_MARKER,
    '# Scans the staged tree with the capture hook\'s secret rules and the R-H5 allowlist;',
    '# refuses the commit on a finding .scan-exceptions.json does not cover.',
    `node="\${HARNESS_NODE:-${nodePath}}"`,
    `repo="\${HARNESS_REPO:-${repoPath}}"`,
    'script="$repo/hooks/export-config.mjs"',
    'if [ ! -f "$script" ]; then',
    '  echo "claude-config pre-commit: $script not found; set HARNESS_REPO to the agentic-harness checkout" >&2',
    '  exit 1',
    'fi',
    'exec "$node" "$script" --pre-commit --config-repo "$(git rev-parse --show-toplevel)"',
    '',
  ].join('\n');
}

/** Where git will look for the clone's pre-commit hook; refused if that is outside its `.git`. */
function hookPath(clone) {
  const result = runGitSync(['rev-parse', '--git-path', 'hooks/pre-commit'], { cwd: clone, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  if (!result.ok) throw new Refusal(`cannot ask git where ${clone}'s hooks live (${result.error})`);
  const file = path.resolve(clone, result.stdout.trim());
  if (!comparablePath(file).startsWith(`${comparablePath(path.join(clone, '.git'))}/`)) {
    throw new Refusal(`core.hooksPath sends ${clone}'s hooks to ${file}, outside its .git; installing there would gate other repos`);
  }
  return file;
}

/** `{file, text, state}`: state is new, updated or unchanged; a hook that is not ours refuses. */
function planHook(clone) {
  const file = hookPath(clone);
  const text = preCommitHookScript({ node: process.execPath, harnessRepo: HARNESS_REPO });
  if (!fs.existsSync(file)) return { file, text, state: 'new' };
  const current = fs.readFileSync(file, 'utf8');
  if (!current.includes(PRE_COMMIT_MARKER)) {
    throw new Refusal(`${file} is a pre-commit hook that is not ours; merge the gate into it by hand, then rerun`);
  }
  return { file, text, state: current === text ? 'unchanged' : 'updated' };
}

// ---------------------------------------------------------------------------
// --dry-run and --apply
// ---------------------------------------------------------------------------

function statusOf(file, text) {
  if (!fs.existsSync(file)) return 'new';
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Refusal(`${file} is not a regular file; move it out of the clone`);
  return fs.readFileSync(file, 'utf8') === text ? 'unchanged' : 'changed';
}

function printPlan(args, plan, mirror, template, scan) {
  const count = (status) => mirror.writes.filter((w) => w.status === status).length;
  console.log(`source: ${args.source}`);
  console.log(`config repo: ${args.configRepo} (${originOf(args.configRepo)})`);
  for (const w of mirror.writes.filter((x) => x.status !== 'unchanged')) {
    console.log(`  ${w.status.padEnd(8)} ${w.path}${w.reason ? ` (${w.reason})` : ''}`);
  }
  for (const d of mirror.deletions) console.log(`  delete   ${d.path}`);
  for (const { path: p, rule } of plan.refused) console.log(`  refused  ${p} (denylist ${rule})`);
  for (const { path: p, reason } of plan.skipped) console.log(`  skipped  ${p} (${reason})`);
  for (const entry of plan.missing) console.log(`  missing  ${entry}`);
  console.log(
    `files: ${count('new')} new, ${count('changed')} changed, ${count('unchanged')} unchanged, ` +
      `${mirror.deletions.length} deleted, ${plan.refused.length} refused, ${plan.skipped.length} skipped`,
  );
  console.log(`template: ${SETTINGS_TEMPLATE_FILE} ${template.status}`);
  const scanned = plan.files.length + 1;
  if (scan.findings.length === 0) console.log(`scan: clean (${scanned} file(s))`);
  else console.log(`scan: ${scan.findings.length} finding(s), ${scan.excepted.length} excepted (${scanned} file(s))`);
}

/** Everything --dry-run and --apply need, with every refusal raised before a write. */
function prepareExport(args) {
  requireClone(args.configRepo);
  refuseOverlap(args.source, args.configRepo);
  const plan = planExport(args.source);
  const templateText = buildTemplateText(args.source);
  const scan = scanExport(plan, templateText, readExceptions(args.configRepo));
  if (scan.unexcepted.length) {
    printFindingsRefusal(scan);
    return null;
  }
  if (plan.files.length === 0) {
    throw new Refusal(`${args.source} has no allowlisted files; is --source the right folder? Nothing was deleted`);
  }
  const foreign = foreignTopLevel(args.configRepo);
  if (foreign.length) throw new Refusal(`the clone holds ${foreign.join(', ')} outside the allowlist; move it out first`);
  const mirror = planMirror(plan, args.configRepo);
  const blocked = mirror.writes.filter((w) => w.status === 'blocked');
  if (blocked.length) {
    throw new Refusal(`${blocked.length} write(s) would go through a link in the clone: ${blocked.map((w) => w.path).join(', ')}`);
  }
  const templateFile = path.join(args.configRepo, SETTINGS_TEMPLATE_FILE);
  const template = { file: templateFile, text: templateText, status: statusOf(templateFile, templateText) };
  const attributesFile = path.join(args.configRepo, '.gitattributes');
  const attributes = { file: attributesFile, status: statusOf(attributesFile, GITATTRIBUTES_TEXT) };
  return { plan, mirror, template, attributes, scan, hook: planHook(args.configRepo) };
}

function insideClone(clone, target) {
  if (!comparablePath(target).startsWith(`${comparablePath(clone)}/`)) {
    throw new Error(`refusing to touch ${target}: it is not inside the clone ${clone}`);
  }
}

function removeFromClone(clone, target) {
  insideClone(clone, target);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(target, { recursive: true, force: true });
  else fs.unlinkSync(target);
}

function writeVerified(clone, target, bytes) {
  insideClone(clone, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  if (sha256(fs.readFileSync(target)) !== sha256(bytes)) throw new Error(`${target} does not read back as written`);
}

function writeMirror(clone, prepared) {
  const { mirror, template, attributes, hook } = prepared;
  fs.mkdirSync(path.dirname(hook.file), { recursive: true });
  if (hook.state !== 'unchanged') fs.writeFileSync(hook.file, hook.text, { mode: 0o755 });
  if (attributes.status !== 'unchanged') writeVerified(clone, attributes.file, GITATTRIBUTES_TEXT);
  for (const w of mirror.writes.filter((x) => x.status === 'new' || x.status === 'changed')) {
    const bytes = fs.readFileSync(w.source);
    if (sha256(bytes) !== w.sha256) throw new Error(`${w.path} changed in the source during the export; run it again`);
    writeVerified(clone, w.target, bytes);
  }
  for (const d of mirror.deletions) removeFromClone(clone, d.target);
  if (template.status !== 'unchanged') writeVerified(clone, template.file, template.text);
}

function commitMessage(mirror) {
  const count = (status) => mirror.writes.filter((w) => w.status === status).length;
  return [
    `chore: export ~/.claude config (${count('new')} new, ${count('changed')} changed, ${mirror.deletions.length} deleted)`,
    '',
    `Exported by agentic-harness hooks/export-config.mjs on ${os.hostname()}. Not pushed.`,
  ].join('\n');
}

/** Stage everything and commit, or say there was nothing to commit. Never pushes. */
function commitClone(clone, mirror) {
  const git = (argv, timeoutMs = GIT_LOCAL_TIMEOUT_MS) => runGitSync(argv, { cwd: clone, timeoutMs, captureStderr: true });
  const added = git(['add', '-A']);
  if (!added.ok) throw new Error(`git add failed (${added.error}): ${added.stderr}`);
  const staged = git(['diff', '--cached', '--quiet']);
  if (staged.ok) return console.log('nothing to commit: the clone already matches');
  if (staged.status !== 1) throw new Error(`git diff --cached failed (${staged.error}): ${staged.stderr}`);
  const committed = git(['commit', '-q', '-m', commitMessage(mirror)], GIT_COMMIT_TIMEOUT_MS);
  if (!committed.ok) throw new Error(`git commit failed (${committed.error}): ${committed.stderr}`);
  const head = git(['rev-parse', '--short', 'HEAD']);
  console.log(`committed ${head.ok ? head.stdout.trim() : '(unknown)'}: ${commitMessage(mirror).split('\n')[0]}`);
}

function runExport(args) {
  const prepared = prepareExport(args);
  if (!prepared) return EXIT_REFUSED;
  printPlan(args, prepared.plan, prepared.mirror, prepared.template, prepared.scan);
  console.log(`pre-commit: ${prepared.hook.state} (${prepared.hook.file})`);
  if (args.mode === 'dry-run') {
    console.log('dry run: nothing written');
    return EXIT_OK;
  }
  writeMirror(args.configRepo, prepared);
  commitClone(args.configRepo, prepared.mirror);
  console.log(`not pushed: the push is live step L2 (git -C ${toPosix(args.configRepo)} push)`);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// --list-findings
// ---------------------------------------------------------------------------

function listFindings(args) {
  requireClone(args.configRepo);
  const plan = planExport(args.source);
  const templateText = buildTemplateText(args.source);
  const scan = scanExport(plan, templateText, readExceptions(args.configRepo));
  console.log(`source: ${args.source}`);
  console.log(`scan: ${scan.findings.length} finding(s) in ${plan.files.length + 1} file(s), ${scan.excepted.length} already excepted`);
  const excepted = new Set(scan.excepted);
  for (const f of scan.findings) {
    const state = excepted.has(f) ? 'excepted' : 'finding ';
    console.log(`  ${state} ${f.path}:${f.line} ${f.rule}`);
    console.log(`    ${JSON.stringify(exceptionEntry(f, scan.hashOf(f.path)))}`);
  }
  if (scan.unexcepted.length) {
    console.log(`To accept one, paste its entry into ${path.join(args.configRepo, SCAN_EXCEPTIONS_FILE)} (a JSON list).`);
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// --pre-commit: the hook's scan of the staged tree
// ---------------------------------------------------------------------------

/** `mode sha stage\tpath` per staged entry (`ls-files -s -z`). */
function stagedEntries(clone) {
  const result = runGitSync(['ls-files', '-s', '-z'], { cwd: clone, timeoutMs: GIT_LOCAL_TIMEOUT_MS, captureStderr: true });
  if (!result.ok) throw new Error(`git ls-files failed (${result.error}): ${result.stderr}`);
  return result.stdout.split('\0').filter(Boolean).map((record) => {
    const tab = record.indexOf('\t');
    const [mode, sha] = record.slice(0, tab).split(' ');
    return { mode, sha, path: record.slice(tab + 1) };
  });
}

/** Every staged blob's bytes in one `git cat-file --batch`, keyed by object id. */
function stagedBlobs(clone, shas) {
  const unique = [...new Set(shas)];
  if (unique.length === 0) return new Map();
  // No `encoding`: the blobs come back as raw bytes, which is what gets hashed.
  const { encoding: _text, ...base } = trustedSpawnOptions(GIT_LOCAL_TIMEOUT_MS, MAX_STAGED_BYTES, { captureStderr: true });
  const options = { ...base, input: `${unique.join('\n')}\n`, stdio: ['pipe', 'pipe', 'pipe'] };
  const out = execFileSync('git', ['--no-pager', ...repoArgs(clone), 'cat-file', '--batch'], options);
  const blobs = new Map();
  let offset = 0;
  while (offset < out.length) {
    const newline = out.indexOf(0x0a, offset);
    if (newline === -1) break;
    const [sha, type, size] = out.toString('utf8', offset, newline).split(' ');
    if (type === 'missing') {
      offset = newline + 1;
      continue;
    }
    const length = Number(size);
    blobs.set(sha, out.subarray(newline + 1, newline + 1 + length));
    offset = newline + 1 + length + 1;
  }
  return blobs;
}

const GITLINK_MODE = '160000';
const SYMLINK_MODE = '120000';

function preCommit(args) {
  const entries = stagedEntries(args.configRepo);
  const pathProblems = entries.flatMap((e) => {
    if (e.mode === SYMLINK_MODE) return [{ path: e.path, rule: 'symlink' }];
    if (e.mode === GITLINK_MODE) return [{ path: e.path, rule: 'submodule' }];
    const rule = repoPathRule(e.path);
    return rule ? [{ path: e.path, rule }] : [];
  });
  const blobs = stagedBlobs(args.configRepo, entries.filter((e) => e.mode !== GITLINK_MODE).map((e) => e.sha));
  const files = entries.filter((e) => blobs.has(e.sha)).map((e) => ({ path: e.path, content: blobs.get(e.sha) }));
  const unreadable = entries.filter((e) => e.mode !== GITLINK_MODE && !blobs.has(e.sha));
  const hashes = new Map(files.map((f) => [f.path, sha256(f.content)]));
  const { findings } = scanForSecrets(files);
  const { unexcepted } = partitionFindings(findings, readExceptions(args.configRepo), (p) => hashes.get(p));

  const problems = pathProblems.length + unexcepted.length + unreadable.length;
  if (problems === 0) return EXIT_OK;
  console.error(`claude-config pre-commit: refusing the commit (${problems} problem(s) in the staged tree)`);
  for (const p of pathProblems) console.error(`  refused  ${p.path} (${p.rule})`);
  for (const e of unreadable) console.error(`  refused  ${e.path} (unreadable blob)`);
  for (const f of unexcepted) console.error(`  finding  ${f.path}:${f.line} ${f.rule}`);
  console.error(`Accept a finding only by adding its entry to ${SCAN_EXCEPTIONS_FILE} (see export-config.mjs --list-findings).`);
  return EXIT_REFUSED;
}

// ---------------------------------------------------------------------------

export function run(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`export-config: ${error.message}`);
    console.error('usage: node hooks/export-config.mjs --dry-run|--apply|--list-findings [--config-repo <dir>] [--source <claudeDir>]');
    return EXIT_USAGE;
  }
  try {
    if (args.mode === 'list-findings') return listFindings(args);
    if (args.mode === 'pre-commit') return preCommit(args);
    return runExport(args);
  } catch (error) {
    console.error(error instanceof Refusal ? `refusing: ${error.message}` : `export-config failed: ${error.message}`);
    return EXIT_REFUSED;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = run(process.argv.slice(2));
}
