#!/usr/bin/env node
/**
 * One-time backfill: give every existing session note its `## Outcome`.
 *
 *   node hooks/backfill-outcome.mjs --vault "<vault>" --dry-run
 *   node hooks/backfill-outcome.mjs --vault "<vault>" --backup "<dir>"
 *
 * Notes written before the hook captured the closing assistant message hold the
 * questions and none of the answers. Each note's fact table names its
 * transcript; this reads that transcript with the hook's own extractor and
 * inserts the section the hook would now write.
 *
 * A plain re-sweep cannot do this: a concluded note with no new activity is a
 * no-op for the merge, by design.
 *
 *   1. Dry run first. It reports exactly what a real run would change.
 *   2. Every note that will change is copied to `--backup` first, and an
 *      existing backup is never overwritten: the first copy is the original.
 *   3. It inserts and never rewrites. A note that already has the section, has
 *      no transcript left, or whose session ended without a closing message is
 *      counted and left alone.
 *   4. It never runs `ingest`. The next full ingest sees the new bodies.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_VAULT_SEGMENTS, MAIN_TRANSCRIPT_MAX_BYTES, VAULT_ENV_VAR } from './lib/constants.mjs';
import { renderOutcome } from './lib/note.mjs';
import { hasOutcome, insertOutcome, transcriptPathFrom } from './lib/outcome-backfill.mjs';
import {
  createAccumulator,
  extractOutcome,
  extractPrompts,
  extractTools,
  knownSecrets,
  readEntries,
} from './lib/transcript.mjs';
import { readSessionNotes } from './untagged-sessions.mjs';

/** `<session_id>--<agent_id>.md`: a subagent's note, whose transcript is all sidechain. */
const CHILD_NOTE = /--[^/\\]+\.md$/;

function parseArgs(argv) {
  const args = {
    vault: process.env[VAULT_ENV_VAR] || path.join(os.homedir(), ...DEFAULT_VAULT_SEGMENTS),
    backup: '',
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') args.dryRun = true;
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

/** Copy a note into the backup, unless a copy is already there: the first copy is the original. */
function backupOriginal(from, vaultRoot, backupDir) {
  const destination = path.join(backupDir, path.relative(vaultRoot, from));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.copyFileSync(from, destination, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
}

/** The rendered section for one transcript, or [] when it ended without a closing message. */
function outcomeLinesFor(transcriptPath, isChildNote) {
  const entries = readEntries(transcriptPath, MAIN_TRANSCRIPT_MAX_BYTES);
  const accumulator = createAccumulator();
  extractTools(entries, accumulator);
  const outcome = extractOutcome(entries, { includeSidechain: isChildNote });
  return renderOutcome(outcome, knownSecrets(extractPrompts(entries), accumulator));
}

/**
 * Add the Outcome section to every session note under `vault` that lacks one.
 *
 * Exported for the tests, which drive it against a scratch vault.
 *
 * @returns {{total: number, added: string[], alreadyPresent: number, transcriptGone: number,
 *            noOutcome: number, refused: {path: string, error: string}[]}}
 */
export function backfillOutcomes({ vault, backup = '', dryRun = false }) {
  const { notes, problems } = readSessionNotes(vault);
  const report = {
    total: notes.length + problems.length,
    added: [],
    alreadyPresent: 0,
    transcriptGone: 0,
    noOutcome: 0,
    refused: problems.map((problem) => ({ path: problem.path, error: problem.error })),
  };

  for (const note of notes) {
    // One note's I/O failure — a OneDrive placeholder that will not hydrate, a
    // locked file — is that note's refusal, not the end of the run.
    try {
      const raw = fs.readFileSync(note.path, 'utf8');
      if (hasOutcome(raw)) {
        report.alreadyPresent += 1;
        continue;
      }
      const transcriptPath = transcriptPathFrom(raw);
      if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        report.transcriptGone += 1;
        continue;
      }
      const lines = outcomeLinesFor(transcriptPath, CHILD_NOTE.test(note.path));
      if (lines.length === 0) {
        report.noOutcome += 1;
        continue;
      }
      const result = insertOutcome(raw, lines);
      if (result.error) {
        report.refused.push({ path: note.path, error: result.error });
        continue;
      }
      if (!dryRun) {
        backupOriginal(note.path, vault, backup);
        fs.writeFileSync(note.path, result.text, 'utf8');
      }
      report.added.push(note.path);
    } catch (err) {
      report.refused.push({ path: note.path, error: err?.code || err?.message || 'unknown' });
    }
  }
  return report;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.vault)) throw new Error(`vault not found: ${args.vault}`);

  const report = backfillOutcomes(args);
  console.log(`${report.total} session notes in ${args.vault}`);
  console.log(`  ${args.dryRun ? 'would add' : 'added'} an outcome: ${report.added.length}`);
  console.log(`  already had one: ${report.alreadyPresent}`);
  console.log(`  transcript no longer on disk: ${report.transcriptGone}`);
  console.log(`  session ended without a closing message: ${report.noOutcome}`);
  console.log(`  refused: ${report.refused.length}`);
  for (const refusal of report.refused) console.log(`    ${path.relative(args.vault, refusal.path)}: ${refusal.error}`);
  if (!args.dryRun && report.added.length) console.log(`  originals backed up to ${args.backup}`);

  if (report.refused.length) process.exitCode = 2;
}

// Importable for the tests; only a direct run hits main().
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (err) {
    console.error(`backfill-outcome failed: ${err?.message || err}`);
    process.exitCode = 1;
  }
}
