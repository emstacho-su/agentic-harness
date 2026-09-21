#!/usr/bin/env node
/**
 * One-time backfill: give every existing session note its Obsidian links.
 *
 *   node hooks/link-sessions.mjs --vault "<vault>" --backup "<dir>" [--dry-run]
 *                                [--ensure-indexes]
 *
 * The capture hook links each note it writes; the notes written before it
 * learned to are what this is for. It edits the frontmatter block only — see
 * `lib/link-notes.mjs` for the promise and how it is kept — so the next
 * `ingest` run reports a metadata update per note and re-embeds nothing.
 *
 * Safety, in the order it matters:
 *   1. `--dry-run` prints the whole plan and writes nothing.
 *   2. Every note that will change is copied to `--backup` first.
 *   3. A note that will not parse, or whose other lines would be rewritten, is
 *      reported and left alone.
 *   4. A second run changes nothing.
 *
 * `--ensure-indexes` also writes a minimal `index.md` for each collection that
 * has session notes and no index, so no `up` link points at nothing. An index
 * that exists is never touched.
 *
 * It never runs `ingest`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_VAULT_SEGMENTS, INDEX_FILENAME, VAULT_ENV_VAR } from './lib/constants.mjs';
import { relinkNote } from './lib/link-notes.mjs';
import { ensureIndex } from './lib/notes-io.mjs';
import { readSessionNotes } from './untagged-sessions.mjs';

function parseArgs(argv) {
  const args = {
    vault: process.env[VAULT_ENV_VAR] || path.join(os.homedir(), ...DEFAULT_VAULT_SEGMENTS),
    backup: '',
    dryRun: false,
    ensureIndexes: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--ensure-indexes') args.ensureIndexes = true;
    else if (arg === '--vault' || arg === '--backup') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} needs a value`);
      args[arg === '--vault' ? 'vault' : 'backup'] = value;
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }

  if (!args.dryRun && !args.backup) throw new Error('a real run needs --backup <dir>');
  return args;
}

/**
 * Copy a note into the backup, unless a copy is already there.
 *
 * The first copy is the original. A second run into the same directory would
 * otherwise replace it with the note this script already rewrote.
 */
function backupOriginal(from, vaultRoot, backupDir) {
  const destination = path.join(backupDir, path.relative(vaultRoot, from));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.copyFileSync(from, destination, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
}

/**
 * Link every session note under `vault`.
 *
 * Exported for the tests, which drive it against a scratch vault.
 *
 * @returns {{total: number, linked: string[], unchanged: number,
 *            refused: {path: string, error: string}[], indexes: string[]}}
 */
export function linkSessions({ vault, backup = '', dryRun = false, ensureIndexes = false }) {
  const { notes, problems } = readSessionNotes(vault);
  const report = {
    total: notes.length + problems.length,
    linked: [],
    unchanged: 0,
    refused: problems.map((problem) => ({ path: problem.path, error: problem.error })),
    indexes: [],
  };

  for (const note of notes) {
    // Read again rather than reassembled from the parse: the point of this
    // pass is that the bytes after the frontmatter are the bytes on disk.
    // One note's I/O failure — a OneDrive placeholder that will not hydrate, a
    // locked file — is that note's refusal, not the end of the run.
    try {
      const raw = fs.readFileSync(note.path, 'utf8');
      const result = relinkNote(raw, note.area, note.collection);
      if (result.error) {
        report.refused.push({ path: note.path, error: result.error });
      } else if (!result.changed) {
        report.unchanged += 1;
      } else {
        if (!dryRun) {
          backupOriginal(note.path, vault, backup);
          fs.writeFileSync(note.path, result.text, 'utf8');
        }
        report.linked.push(note.path);
      }
    } catch (err) {
      report.refused.push({ path: note.path, error: err?.code || err?.message || 'unknown' });
    }
  }

  if (ensureIndexes) {
    const collections = new Map(notes.map((note) => [`${note.area}/${note.collection}`, note]));
    for (const [key, note] of collections) {
      const indexPath = path.join(vault, note.area, note.collection, INDEX_FILENAME);
      if (fs.existsSync(indexPath)) continue;
      if (dryRun) {
        report.indexes.push(key);
        continue;
      }
      const created = ensureIndex(vault, note.area, note.collection);
      if (created.ok) report.indexes.push(key);
      else report.refused.push({ path: indexPath, error: created.error });
    }
  }

  return report;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.vault)) throw new Error(`vault not found: ${args.vault}`);

  const report = linkSessions(args);
  const verb = args.dryRun ? 'would link' : 'linked';

  console.log(`${report.total} session notes in ${args.vault}`);
  console.log(`  ${verb}: ${report.linked.length}`);
  console.log(`  already linked: ${report.unchanged}`);
  console.log(`  refused: ${report.refused.length}`);
  for (const refusal of report.refused) console.log(`    ${path.relative(args.vault, refusal.path)}: ${refusal.error}`);
  if (args.ensureIndexes) {
    console.log(`  ${args.dryRun ? 'would create' : 'created'} index notes: ${report.indexes.length}`);
    for (const key of report.indexes) console.log(`    ${key}/${INDEX_FILENAME}`);
  }
  if (!args.dryRun && report.linked.length) console.log(`  originals backed up to ${args.backup}`);

  if (report.refused.length) process.exitCode = 2;
}

// Importable for the tests; only a direct run hits main().
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (err) {
    console.error(`link-sessions failed: ${err?.message || err}`);
    process.exitCode = 1;
  }
}
