#!/usr/bin/env node
/**
 * Deploy the hook to `~/.claude/hooks/`.
 *
 * The source of truth is this repository. The deployed copy is a byte-identical
 * copy, never a symlink and never a `settings.json` entry pointing into a
 * worktree — a worktree gets deleted, and a hook that vanishes with it takes
 * every future session's note with it.
 *
 *   node hooks/install.mjs [--dry-run] [--target <dir>]
 *
 * The existing deployment is backed up first, and every copied file is read
 * back and compared by SHA-256, because "it looked like it copied" is not the
 * standard for something that runs on every session exit.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Exactly what the hook needs at runtime. Tests and tools stay in the repo. */
const PAYLOAD = [
  'session-capture.mjs',
  'lib/capture.mjs',
  'lib/collection.mjs',
  'lib/constants.mjs',
  'lib/frontmatter.mjs',
  'lib/git-log.mjs',
  'lib/logger.mjs',
  'lib/merge.mjs',
  'lib/note.mjs',
  'lib/paths.mjs',
  'lib/redact.mjs',
  'lib/repo.mjs',
  'lib/stdin.mjs',
  'lib/tags.mjs',
  'lib/text.mjs',
  'lib/transcript.mjs',
  'lib/vocabulary.mjs',
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function parseArgs(argv) {
  const args = { dryRun: false, target: path.join(os.homedir(), '.claude', 'hooks') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--target') {
      args.target = argv[index + 1];
      index += 1;
      if (!args.target) throw new Error('--target needs a directory');
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function backup(target, relativePaths) {
  const existing = relativePaths.filter((relative) => fs.existsSync(path.join(target, relative)));
  if (existing.length === 0) return '';

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(target, `backup-${stamp}`);
  for (const relative of existing) {
    const destination = path.join(dir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(target, relative), destination);
  }
  return dir;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const missing = PAYLOAD.filter((relative) => !fs.existsSync(path.join(HERE, relative)));
  if (missing.length) {
    console.error(`refusing to install: missing source files\n  ${missing.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }

  const changes = PAYLOAD.map((relative) => {
    const source = path.join(HERE, relative);
    const destination = path.join(args.target, relative);
    const sourceHash = sha256(source);
    const targetHash = fs.existsSync(destination) ? sha256(destination) : '';
    return { relative, source, destination, sourceHash, same: sourceHash === targetHash, isNew: !targetHash };
  });

  const toWrite = changes.filter((change) => !change.same);
  if (toWrite.length === 0) {
    console.log(`already current: ${args.target} matches ${PAYLOAD.length} source files`);
    return;
  }

  console.log(`target: ${args.target}`);
  for (const change of toWrite) console.log(`  ${change.isNew ? 'add   ' : 'update'} ${change.relative}`);
  if (args.dryRun) {
    console.log(`dry run: ${toWrite.length} file(s) would change, nothing written`);
    return;
  }

  const backupDir = backup(args.target, toWrite.filter((change) => !change.isNew).map((change) => change.relative));
  if (backupDir) console.log(`backed up the previous copy to ${backupDir}`);

  for (const change of toWrite) {
    fs.mkdirSync(path.dirname(change.destination), { recursive: true });
    fs.copyFileSync(change.source, change.destination);
  }

  const mismatched = changes.filter((change) => sha256(change.destination) !== change.sourceHash);
  if (mismatched.length) {
    console.error(`INSTALL FAILED: ${mismatched.length} file(s) differ after copying`);
    for (const change of mismatched) console.error(`  ${change.relative}`);
    process.exitCode = 1;
    return;
  }

  console.log(`installed ${toWrite.length} file(s); all ${PAYLOAD.length} verified byte-identical`);
  console.log('settings.json already points at this path; no change needed there.');
}

try {
  main();
} catch (err) {
  console.error(`install failed: ${err?.message || err}`);
  process.exitCode = 1;
}
