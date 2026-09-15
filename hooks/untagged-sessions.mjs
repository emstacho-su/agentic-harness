#!/usr/bin/env node
/**
 * The weekly "untagged sessions" list (R-27.4).
 *
 * `tags: [unclassified]` means the classifier had nothing mechanical to go on —
 * a planning conversation that edited no files looks exactly like that. It is a
 * reviewable state, not a failure, and this is the review: run it weekly, and
 * for each note either add a tag by hand or add a rule to `docs/tags.md`.
 *
 *   node hooks/untagged-sessions.mjs [--vault <path>] [--json] [--since <date>]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AREA_CLASSES, AREA_PROJECTS, DEFAULT_VAULT_SEGMENTS, VAULT_ENV_VAR } from './lib/constants.mjs';
import { parseFrontmatter } from './lib/frontmatter.mjs';
import { UNCLASSIFIED } from './lib/vocabulary.mjs';

const FIRST_PROMPT = /^##\s+What I asked for\s*\n+\s*1\.\s+(.+)$/m;
const SNIPPET_CHARS = 90;

function parseArgs(argv) {
  const args = {
    vault: process.env[VAULT_ENV_VAR] || path.join(os.homedir(), ...DEFAULT_VAULT_SEGMENTS),
    json: false,
    since: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--vault' || arg === '--since') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} needs a value`);
      args[arg === '--vault' ? 'vault' : 'since'] = value;
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/** Every session note in the vault, parsed. Unreadable notes are reported, not skipped silently. */
export function readSessionNotes(vaultRoot) {
  const notes = [];
  const problems = [];

  for (const area of [AREA_PROJECTS, AREA_CLASSES]) {
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
        files = fs.readdirSync(sessionsDir).filter((name) => name.endsWith('.md'));
      } catch {
        continue;
      }
      for (const name of files) {
        const notePath = path.join(sessionsDir, name);
        const parsed = parseFrontmatter(fs.readFileSync(notePath, 'utf8'));
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

/** Notes whose tags contain the sentinel, newest first. */
export function untaggedSessions(notes, since = '') {
  return notes
    .filter((note) => asList(note.fields.tags).includes(UNCLASSIFIED))
    .filter((note) => !since || String(note.fields.date ?? '') >= since)
    .sort((a, b) => String(b.fields.date ?? '').localeCompare(String(a.fields.date ?? '')))
    .map((note) => ({
      date: String(note.fields.date ?? ''),
      collection: String(note.fields.collection ?? note.collection),
      session_id: String(note.fields.session_id ?? ''),
      status: String(note.fields.status ?? ''),
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.vault)) {
    console.error(`vault not found: ${args.vault}`);
    process.exitCode = 1;
    return;
  }

  const { notes, problems } = readSessionNotes(args.vault);
  const rows = untaggedSessions(notes, args.since);

  if (args.json) {
    console.log(JSON.stringify({ vault: args.vault, total: notes.length, unclassified: rows, problems }, null, 2));
    return;
  }

  console.log(`${rows.length} unclassified of ${notes.length} session notes in ${args.vault}`);
  if (rows.length) console.log('');
  for (const row of rows) {
    console.log(`${row.date}  ${row.collection.padEnd(18)} ${row.status.padEnd(10)} ${row.session_id}`);
    if (row.first_prompt) console.log(`            ${row.first_prompt}`);
  }
  for (const problem of problems) {
    console.log(`\nUNREADABLE ${problem.path}: ${problem.error}`);
  }
}

// Importable for the tests and for the migration; only a direct run hits main().
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (err) {
    console.error(`untagged-sessions failed: ${err?.message || err}`);
    process.exitCode = 1;
  }
}
