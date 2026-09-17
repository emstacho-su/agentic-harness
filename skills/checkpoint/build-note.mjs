#!/usr/bin/env node
/**
 * build-note.mjs — the deterministic half of `/checkpoint`.
 *
 * Runs inside the repository a cloud session is working in, so it has no
 * access to `hooks/lib`: everything it needs is here, and a test in the harness
 * pins this file's serializer against `hooks/lib/frontmatter.mjs`.
 *
 *   node .claude/skills/checkpoint/build-note.mjs --body <file> [--collection <slug>]
 *        [--repo <dir>] [--out-dir <dir>] [--session-id <id>] [--now <iso>] [--base <ref>]
 *
 * Facts come from git and the arguments; the model writes only the body. The
 * note is a schema-v2 session note with every field present, `captured_by:
 * skill` and `origin: cloud`, written to `<repo>/.harness/sessions/<id>.md`.
 * Stdout is one JSON line: { ok, path, id, session_id, collection } or
 * { ok: false, error }. Exit 0 on a note, 2 on bad input.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GENERATOR = 'checkpoint 1.0.0';
export const SCHEMA_VERSION = 2;
export const CAPTURED_BY = 'skill';
export const ORIGIN = 'cloud';
export const NOTES_DIR = path.join('.harness', 'sessions');

/** The body's fixed shape. Missing one is a refusal, not a guess. */
export const REQUIRED_HEADINGS = Object.freeze([
  '## What I asked for',
  '## What was done',
  '## Decisions',
  '## Open questions / next steps',
]);

const MAX_COMMITS = 40;
const MAX_FILES = 60;
const GIT_TIMEOUT_MS = 5_000;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_ENV_VARS = ['CLAUDE_CODE_REMOTE_SESSION_ID'];
const SESSION_TOKEN_VAR = 'CLAUDE_CODE_SESSION_ACCESS_TOKEN';
const SESSION_CLAIM = 'ccr:session_id';

// ----------------------------------------------------------- frontmatter
// A faithful copy of hooks/lib/frontmatter.mjs's emit rules. Field order is the
// frozen v2 contract; the harness test `checkpoint-build.test.mjs` asserts the
// two stay identical.

const QUOTED = 'quoted';
const PLAIN = 'plain';
const LIST = 'list';
const NUMBER_LIST = 'numlist';
const MAP = 'map';

export const FIELD_SPEC = Object.freeze([
  ['id', QUOTED], ['title', QUOTED], ['type', PLAIN], ['schema_version', PLAIN],
  ['collection', QUOTED], ['collection_source', QUOTED], ['session_id', QUOTED], ['date', PLAIN],
  ['started_at', QUOTED], ['ended_at', QUOTED], ['duration_minutes', PLAIN], ['status', QUOTED],
  ['concluded_at', QUOTED], ['end_reason', QUOTED], ['repo', QUOTED], ['branch', QUOTED],
  ['worktree', QUOTED], ['repos_touched', LIST], ['cwd', QUOTED], ['cwds_seen', LIST],
  ['phase', QUOTED], ['tags', LIST], ['supersedes', LIST], ['resumed_from', QUOTED],
  ['parent_session', QUOTED], ['child_sessions', LIST], ['commits', LIST], ['prs', NUMBER_LIST],
  ['memory_files', LIST], ['plan_file', QUOTED], ['docs_touched', LIST], ['artifacts', LIST],
  ['files_modified', LIST], ['prompt_count', PLAIN], ['command_count', PLAIN], ['agent', PLAIN],
  ['agent_type', QUOTED], ['origin', QUOTED], ['captured_by', QUOTED], ['generator', QUOTED],
  ['tools_used', MAP],
]);

const EMITTABLE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

export function yamlStr(value) {
  return `'${String(value ?? '').replace(/'/g, "''").replace(/[\r\n]+/g, ' ')}'`;
}

function emitField(key, value, kind) {
  switch (kind) {
    case PLAIN:
      return [`${key}: ${value === '' ? "''" : String(value)}`];
    case LIST:
    case NUMBER_LIST: {
      const items = Array.isArray(value) ? value : [];
      if (items.length === 0) return [`${key}: []`];
      const render = kind === NUMBER_LIST ? (v) => String(v) : (v) => yamlStr(v);
      return [`${key}:`, ...items.map((item) => `  - ${render(item)}`)];
    }
    case MAP: {
      const entries = Object.entries(value && typeof value === 'object' ? value : []).filter(([name]) =>
        EMITTABLE_KEY.test(name),
      );
      if (entries.length === 0) return [`${key}: {}`];
      return [`${key}:`, ...entries.map(([name, count]) => `  ${name}: ${Number(count) || 0}`)];
    }
    default:
      return [`${key}: ${yamlStr(value)}`];
  }
}

export function serializeFrontmatter(fields) {
  const lines = ['---'];
  for (const [key, kind] of FIELD_SPEC) {
    if (key in fields) lines.push(...emitField(key, fields[key], kind));
  }
  lines.push('---');
  return lines.join('\n');
}

// ------------------------------------------------------------------- git

function git(repo, args, { allowFailure = true } = {}) {
  try {
    return execFileSync('git', ['-C', repo, '--no-pager', ...args], {
      cwd: os.homedir(),
      env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' },
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch (err) {
    if (allowFailure) return '';
    throw err;
  }
}

/** `owner/name` from any remote shape git accepts, else `''`. */
export function parseRepoFullName(url) {
  const match = /[:/]([^/:]+)\/([^/:]+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  return match ? `${match[1]}/${match[2]}` : '';
}

/** Verbatim copy of hooks/lib/text.mjs slugify; pinned by checkpoint-build.test.mjs. */
export function slugify(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ._-]+/g, '-')
    .replace(/[-\s]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .trim();
  if (!slug) return '';
  // A reserved Windows device name would produce an uncreatable folder.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(slug)) return `${slug}-dir`;
  return slug.slice(0, 64);
}

function baseRef(repo, explicit) {
  const candidates = explicit ? [explicit] : ['origin/main', 'main', 'origin/master', 'master'];
  return candidates.find((ref) => git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) ?? '';
}

function lines(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function gitFacts(repo, { base = '' } = {}) {
  const remote = git(repo, ['remote', 'get-url', 'origin']);
  const repoFullName = parseRepoFullName(remote);
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const ref = baseRef(repo, base);

  const commits = ref ? lines(git(repo, ['log', '--format=%h', `${ref}..HEAD`])).slice(0, MAX_COMMITS) : [];
  const changed = ref ? lines(git(repo, ['diff', '--name-only', `${ref}...HEAD`])) : [];
  const uncommitted = lines(git(repo, ['status', '--porcelain'])).map((line) => line.slice(3).trim().replace(/^"|"$/g, ''));
  const files = [...new Set([...changed, ...uncommitted])].sort().slice(0, MAX_FILES);

  return { repoFullName, branch: branch === 'HEAD' ? '' : branch, base: ref, commits, files };
}

// ------------------------------------------------------------ session id

function claimFromJwt(token) {
  try {
    const payload = String(token).split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const value = JSON.parse(json)?.[SESSION_CLAIM];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/**
 * The checkpoint's own id: `cp-` + the sandbox's session id when one is
 * exposed, else `cp-` + a UUID. The prefix is deliberate: a cloud session later
 * pulled down with `claude --teleport` gets a transcript named by the *raw*
 * session id, and the nightly sweep skips any id that already has a note. With
 * the prefix the two never collide, so the fuller sweep note is still written.
 */
export const SESSION_ID_PREFIX = 'cp-';

export function resolveSessionId({ explicit = '', env = process.env } = {}) {
  if (typeof explicit === 'string' && SAFE_SEGMENT.test(explicit) && !explicit.includes('..')) return explicit;
  const candidates = [
    ...SESSION_ENV_VARS.map((name) => env[name]),
    env[SESSION_TOKEN_VAR] ? claimFromJwt(env[SESSION_TOKEN_VAR]) : '',
  ];
  const found = candidates.find((value) => typeof value === 'string' && SAFE_SEGMENT.test(value) && !value.includes('..'));
  return `${SESSION_ID_PREFIX}${found ?? crypto.randomUUID()}`;
}

// ------------------------------------------------------------------ body

export function validateBody(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const missing = REQUIRED_HEADINGS.filter((heading) => !new RegExp(`^${escapeRegExp(heading)}\\s*$`, 'm').test(text));
  if (missing.length) return { ok: false, error: `body is missing heading(s): ${missing.join(', ')}` };
  if (text.trim().length < 40) return { ok: false, error: 'body is empty' };
  return { ok: true, text: text.trim() };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The number of list items under "What I asked for": the closest thing to a prompt count. */
export function countRequests(body) {
  const section = body.split(/^## /m).find((part) => part.startsWith('What I asked for')) ?? '';
  return section.split('\n').filter((line) => /^\s*(?:[-*]|\d+[.)])\s+\S/.test(line)).length;
}

// ------------------------------------------------------------------ note

export function buildNote({ repo, body, collection = '', sessionId = '', now = new Date(), env = process.env, base = '' }) {
  const checked = validateBody(body);
  if (!checked.ok) return { ok: false, error: checked.error };

  const facts = gitFacts(repo, { base });
  const id = resolveSessionId({ explicit: sessionId, env });
  const requested = slugify(collection);
  const fromRepo = slugify(facts.repoFullName.split('/')[1] ?? '');
  const finalCollection = requested || fromRepo || 'misc';
  const iso = now.toISOString();
  const date = iso.slice(0, 10);
  const title = `Session ${date} — ${finalCollection}`;

  const fields = {
    id: `session-${id}`,
    title,
    type: 'session',
    schema_version: SCHEMA_VERSION,
    collection: finalCollection,
    collection_source: requested ? 'argument' : fromRepo ? 'git' : 'folder',
    session_id: id,
    date,
    started_at: '',
    ended_at: iso,
    duration_minutes: 0,
    status: 'concluded',
    concluded_at: iso,
    end_reason: 'other',
    repo: facts.repoFullName,
    branch: facts.branch,
    worktree: '',
    repos_touched: facts.repoFullName ? [facts.repoFullName.split('/')[1]] : [],
    cwd: '',
    cwds_seen: [],
    phase: '',
    tags: [],
    supersedes: [],
    resumed_from: '',
    parent_session: '',
    child_sessions: [],
    commits: facts.commits,
    prs: [],
    memory_files: [],
    plan_file: '',
    docs_touched: facts.files.filter((file) => /^docs\/|\.md$/.test(file)),
    artifacts: [],
    files_modified: facts.files,
    prompt_count: countRequests(checked.text),
    command_count: 0,
    agent: 'claude-code',
    agent_type: '',
    origin: ORIGIN,
    captured_by: CAPTURED_BY,
    generator: GENERATOR,
    tools_used: {},
  };

  const text =
    `${serializeFrontmatter(fields)}\n\n# ${title}\n\n` +
    `Cloud session on \`${facts.repoFullName || 'unknown repository'}\`` +
    `${facts.branch ? ` (branch \`${facts.branch}\`)` : ''}, checkpointed by the \`/checkpoint\` skill ` +
    `on ${date}. The frontmatter is from git; the sections below are Claude's own account of the session.\n\n` +
    `${checked.text}\n`;

  return { ok: true, id: fields.id, sessionId: id, collection: finalCollection, fields, text };
}

// ------------------------------------------------------------------- cli

function parseArgs(argv) {
  const options = { repo: process.cwd(), body: '', collection: '', outDir: '', sessionId: '', now: '', base: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    switch (arg) {
      case '--repo': options.repo = value(); break;
      case '--body': options.body = value(); break;
      case '--collection': options.collection = value(); break;
      case '--out-dir': options.outDir = value(); break;
      case '--session-id': options.sessionId = value(); break;
      case '--now': options.now = value(); break;
      case '--base': options.base = value(); break;
      default: throw new Error(`unknown option ${arg}`);
    }
  }
  if (!options.body) throw new Error('--body <file> is required');
  return options;
}

export function main(argv, env = process.env) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    return { code: 2, output: { ok: false, error: err.message } };
  }

  let body;
  try {
    body = fs.readFileSync(options.body, 'utf8');
  } catch (err) {
    return { code: 2, output: { ok: false, error: `cannot read body: ${err.message}` } };
  }

  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) return { code: 2, output: { ok: false, error: `--now is not a date: ${options.now}` } };

  const note = buildNote({ repo: options.repo, body, collection: options.collection, sessionId: options.sessionId, now, env, base: options.base });
  if (!note.ok) return { code: 2, output: note };

  const outDir = options.outDir || path.join(options.repo, NOTES_DIR);
  const notePath = path.join(outDir, `${note.sessionId}.md`);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(notePath, note.text, 'utf8');
  } catch (err) {
    return { code: 2, output: { ok: false, error: `cannot write note: ${err.message}` } };
  }

  return {
    code: 0,
    output: { ok: true, path: notePath.replace(/\\/g, '/'), id: note.id, session_id: note.sessionId, collection: note.collection },
  };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { code, output } = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exit(code);
}
