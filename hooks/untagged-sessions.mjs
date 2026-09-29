#!/usr/bin/env node
/**
 * The weekly "untagged sessions" list (R-27.4, R-103).
 *
 * `tags: [unclassified]` means the classifier had nothing mechanical to go on —
 * a planning conversation that edited no files looks exactly like that. It is a
 * reviewable state, not a failure, and this is the review: for each note
 * either add a tag by hand or add a rule to `docs/tags.md`.
 *
 *   node hooks/untagged-sessions.mjs [--vault <p>] [--json] [--since <date>]
 *        [--include-sdk] [--due] [--threshold <n>] [--mark-reviewed] [--state <file>]
 *
 * The vault comes from `resolveHarnessConfig` (the shell, then the machine
 * file) unless `--vault` names one. Notes whose `origin` starts `sdk-` are left
 * out unless `--include-sdk`. The last review is recorded in the state file
 * (default `~/.harness/state/untagged-review.json`, `{ "reviewed_at": "<ISO>" }`),
 * and `--since` defaults to it.
 *
 * The cadence (H-5, H-11): `--due` exits 3 when the review is due (no review
 * recorded, the last one 7 or more days old, or at least `--threshold`
 * untagged notes since it, default UNTAGGED_EARLY_TRIGGER), else 0.
 * `--mark-reviewed` records a review now.
 *
 * Exit codes: 0 ok (or not due), 2 bad usage or no vault, 3 review due.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AREAS } from './lib/constants.mjs';
import { isEntryPoint } from './lib/entry-point.mjs';
import { parseFrontmatter } from './lib/frontmatter.mjs';
import { resolveHarnessConfig } from './lib/machine-env.mjs';
import { STATE_DIR_ENV_VAR } from './lib/session-start.mjs';
import { UNCLASSIFIED } from './lib/vocabulary.mjs';

/** Review early once this many untagged notes have arrived since the last one. */
export const UNTAGGED_EARLY_TRIGGER = 25;
/** Review at least this often. */
export const UNTAGGED_REVIEW_DAYS = 7;
/** The origin prefix of Agent SDK sessions, which are left out by default. */
export const SDK_ORIGIN_PREFIX = 'sdk-';
export const STATE_FILE_NAME = 'untagged-review.json';

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_DUE = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ARG = /^\d{4}-\d{2}-\d{2}(?:T[0-9:.]+Z?)?$/;
const FIRST_PROMPT = /^##\s+What I asked for\s*\n+\s*1\.\s+(.+)$/m;
const SNIPPET_CHARS = 90;

const USAGE = `usage: node untagged-sessions.mjs [options]
  --vault <p>        vault root (default: HARNESS_VAULT from the shell or the machine file)
  --json             print JSON
  --since <date>     only notes since this date or ISO time (default: the last review)
  --include-sdk      include notes whose origin starts ${SDK_ORIGIN_PREFIX}
  --due              exit ${EXIT_DUE} when the review is due, else 0
  --threshold <n>    untagged notes since the last review that make it due (default ${UNTAGGED_EARLY_TRIGGER})
  --mark-reviewed    record a review now
  --state <file>     the review record (default ~/.harness/state/${STATE_FILE_NAME})`;

/** The default review record: `$HARNESS_STATE_DIR` or `~/.harness/state`. */
export function defaultStatePath(env = process.env, home = os.homedir()) {
  const root = env?.[STATE_DIR_ENV_VAR] || path.join(home, '.harness', 'state');
  return path.join(root, STATE_FILE_NAME);
}

export function parseArgs(argv) {
  const options = {
    vault: '', json: false, since: undefined, includeSdk: false, due: false,
    threshold: UNTAGGED_EARLY_TRIGGER, markReviewed: false, state: '', help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      index += 1;
      return next;
    };
    try {
      switch (arg) {
        case '--vault': options.vault = value(); break;
        case '--json': options.json = true; break;
        case '--since': options.since = dateArg(value()); break;
        case '--include-sdk': options.includeSdk = true; break;
        case '--due': options.due = true; break;
        case '--threshold': options.threshold = positiveInteger(value()); break;
        case '--mark-reviewed': options.markReviewed = true; break;
        case '--state': options.state = value(); break;
        case '--help': case '-h': options.help = true; break;
        default: throw new Error(`unknown argument: ${arg}`);
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return { ok: true, options };
}

function dateArg(raw) {
  if (!DATE_ARG.test(raw) || Number.isNaN(Date.parse(raw))) throw new Error(`--since is not a date: ${raw.slice(0, 40)}`);
  return raw;
}

function positiveInteger(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--threshold must be a whole number >= 1, got ${raw.slice(0, 20)}`);
  return n;
}

/** Every session note in the vault, parsed. Unreadable notes are reported, not skipped silently. */
export function readSessionNotes(vaultRoot) {
  const notes = [];
  const problems = [];

  for (const area of AREAS) {
    const areaDir = path.join(vaultRoot, area);
    let collections;
    try {
      collections = fs.readdirSync(areaDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of collections) {
      if (!entry.isDirectory()) continue;
      const sessionsDir = path.join(areaDir, entry.name, 'sessions');
      let files;
      try {
        files = fs
          .readdirSync(sessionsDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const name of files) {
        const notePath = path.join(sessionsDir, name);
        let raw;
        try {
          raw = fs.readFileSync(notePath, 'utf8');
        } catch (err) {
          // A directory named `x.md`, or a placeholder that will not hydrate.
          // Reported, because throwing here aborts the whole migration.
          problems.push({ path: notePath, error: err?.code || err?.message || 'unreadable' });
          continue;
        }
        const parsed = parseFrontmatter(raw);
        if (!parsed.ok) {
          problems.push({ path: notePath, error: parsed.error });
          continue;
        }
        notes.push({ path: notePath, area, collection: entry.name, name, fields: parsed.fields, body: parsed.body });
      }
    }
  }
  return { notes, problems };
}

/**
 * When the session happened, as precisely as the note says: `ended_at`, else
 * `started_at`, else `date`. ISO strings, so they compare as text against a
 * `since` that is either a date or an ISO time.
 */
function noteTime(note) {
  const { ended_at: ended, started_at: started, date } = note.fields;
  return String(ended || started || date || '');
}

/** Notes whose tags contain the sentinel, newest first; SDK sessions only with `includeSdk`. */
export function untaggedSessions(notes, since = '', { includeSdk = false } = {}) {
  return notes
    .filter((note) => asList(note.fields.tags).includes(UNCLASSIFIED))
    .filter((note) => includeSdk || !String(note.fields.origin ?? '').startsWith(SDK_ORIGIN_PREFIX))
    .filter((note) => !since || noteTime(note) >= since)
    .sort((a, b) => noteTime(b).localeCompare(noteTime(a)))
    .map((note) => ({
      date: String(note.fields.date ?? ''),
      collection: String(note.fields.collection ?? note.collection),
      session_id: String(note.fields.session_id ?? ''),
      status: String(note.fields.status ?? ''),
      origin: String(note.fields.origin ?? ''),
      path: note.path,
      first_prompt: firstPrompt(note.body),
    }));
}

function firstPrompt(body) {
  const match = String(body ?? '').match(FIRST_PROMPT);
  if (!match) return '';
  const text = match[1].trim();
  return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS - 1)}…` : text;
}

function asList(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

/**
 * The last review's ISO time, or '' when none is recorded. A file that is
 * there but unusable is reported and counts as no review, so the review is due.
 */
export function readReviewedAt(statePath, report = () => {}, now = new Date()) {
  let text;
  try {
    text = fs.readFileSync(statePath, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') report(`review record unreadable (${err?.code || 'error'}): ${statePath}`);
    return '';
  }
  let reviewedAt = '';
  try {
    reviewedAt = String(JSON.parse(text)?.reviewed_at ?? '');
  } catch {
    report(`review record is not valid JSON; treating the review as due: ${statePath}`);
    return '';
  }
  const at = Date.parse(reviewedAt);
  if (!reviewedAt || Number.isNaN(at) || at > now.getTime()) {
    report(`review record has no usable reviewed_at; treating the review as due: ${statePath}`);
    return '';
  }
  return new Date(at).toISOString();
}

/** Record a review at `now`, by temp file and rename so a reader never sees half a file. */
export function writeReviewedAt(statePath, now = new Date()) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ reviewed_at: now.toISOString() })}\n`, 'utf8');
  fs.renameSync(temp, statePath);
}

/** Is the review due? `{ due, reason }`. */
export function reviewDue({ reviewedAt, count, threshold = UNTAGGED_EARLY_TRIGGER, now = new Date() }) {
  if (!reviewedAt) return { due: true, reason: 'no review recorded' };
  const ageDays = (now.getTime() - Date.parse(reviewedAt)) / DAY_MS;
  if (ageDays >= UNTAGGED_REVIEW_DAYS) return { due: true, reason: `last review ${reviewedAt}, ${Math.floor(ageDays)} days ago` };
  if (count >= threshold) return { due: true, reason: `${count} untagged since ${reviewedAt} (threshold ${threshold})` };
  return { due: false, reason: `${count} untagged since ${reviewedAt}; last review ${ageDays.toFixed(1)} days ago` };
}

function printList(rows, total, vault, problems, out) {
  out(`${rows.length} unclassified of ${total} session notes in ${vault}`);
  if (rows.length) out('');
  for (const row of rows) {
    out(`${row.date}  ${row.collection.padEnd(18)} ${row.status.padEnd(10)} ${row.session_id}`);
    if (row.first_prompt) out(`            ${row.first_prompt}`);
  }
  for (const problem of problems) out(`\nUNREADABLE ${problem.path}: ${problem.error}`);
}

/** The CLI body. Returns the exit code; only the entry-point block exits. */
export function run(argv, { env = process.env, home = os.homedir(), now = () => new Date(), out = console.log, err = console.error } = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    err(`untagged-sessions: ${parsed.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const options = parsed.options;
  if (options.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const report = (line) => err(`untagged-sessions: ${line}`);
  const at = now();
  const statePath = options.state || defaultStatePath(env, home);
  if (options.markReviewed) {
    writeReviewedAt(statePath, at);
    out(`reviewed_at ${at.toISOString()} recorded in ${statePath}`);
    return EXIT_OK;
  }

  const config = options.vault ? null : resolveHarnessConfig({ env, home, report });
  const vault = options.vault || config.vault;
  if (!vault) {
    err(`untagged-sessions: no vault: pass --vault or set HARNESS_VAULT (machine file ${config.machineFile})`);
    return EXIT_USAGE;
  }
  if (!fs.existsSync(vault)) {
    err(`untagged-sessions: vault not found: ${vault}`);
    return EXIT_USAGE;
  }

  const reviewedAt = readReviewedAt(statePath, report, at);
  const since = options.since ?? reviewedAt;
  const { notes, problems } = readSessionNotes(vault);
  const rows = untaggedSessions(notes, since, { includeSdk: options.includeSdk });

  if (options.due) {
    const verdict = reviewDue({ reviewedAt, count: untaggedSessions(notes, reviewedAt, options).length, threshold: options.threshold, now: at });
    out(`${verdict.due ? 'due' : 'not due'}: ${verdict.reason}`);
    return verdict.due ? EXIT_DUE : EXIT_OK;
  }
  if (options.json) {
    out(JSON.stringify({ vault, since, reviewed_at: reviewedAt, total: notes.length, unclassified: rows, problems }, null, 2));
  } else {
    printList(rows, notes.length, vault, problems, out);
  }
  return EXIT_OK;
}

// Importable for the tests and for the migration; only a direct run acts.
if (isEntryPoint(import.meta.url)) {
  let code;
  try {
    code = run(process.argv.slice(2));
  } catch (error) {
    console.error(`untagged-sessions failed: ${error?.message || error}`);
    code = 1;
  }
  process.exit(code);
}
