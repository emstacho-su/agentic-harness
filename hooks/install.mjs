#!/usr/bin/env node
/**
 * Deploy the hook to `~/.claude/hooks/`.
 *
 * The source of truth is this repository. The deployed copy is a byte-identical
 * copy, never a symlink and never a `settings.json` entry pointing into a
 * worktree — a worktree gets deleted, and a hook that vanishes with it takes
 * every future session's note with it.
 *
 *   node hooks/install.mjs [--dry-run] [--target <dir>] [--settings <file>]
 *                          [--node <path to node.exe>] [--skip-settings]
 *
 * The existing deployment is backed up first, and every copied file is read
 * back and compared by SHA-256, because "it looked like it copied" is not the
 * standard for something that runs on every session exit.
 *
 * It then registers the hook for `SessionEnd` and `SubagentStop` in
 * `~/.claude/settings.json`. That file is the user's — permissions, model,
 * plugins, other tools' hooks — so the write is a read-merge-write that touches
 * only those two events and leaves everything else exactly as it found it. A
 * second run changes nothing.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hookCommand, withHookRegistered } from './lib/settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Exactly what the hook needs at runtime. Tests and tools stay in the repo. */
const PAYLOAD = [
  'session-capture.mjs',
  'lib/analyse.mjs',
  'lib/capture.mjs',
  'lib/collection.mjs',
  'lib/constants.mjs',
  'lib/enqueue-ingest.mjs',
  'lib/frontmatter.mjs',
  'lib/git-log.mjs',
  'lib/links.mjs',
  'lib/logger.mjs',
  'lib/merge.mjs',
  'lib/note.mjs',
  'lib/notes-io.mjs',
  'lib/paths.mjs',
  'lib/redact.mjs',
  'lib/repo.mjs',
  'lib/spawn.mjs',
  'lib/stdin.mjs',
  'lib/subagent.mjs',
  'lib/tags.mjs',
  'lib/text.mjs',
  'lib/transcript.mjs',
  'lib/vocabulary.mjs',
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    skipSettings: false,
    target: path.join(os.homedir(), '.claude', 'hooks'),
    settings: path.join(os.homedir(), '.claude', 'settings.json'),
    node: process.execPath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--skip-settings') args.skipSettings = true;
    else if (arg === '--target' || arg === '--settings' || arg === '--node') {
      if (!value) throw new Error(`${arg} needs a value`);
      args[arg === '--target' ? 'target' : arg === '--settings' ? 'settings' : 'node'] = value;
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/**
 * Register the hook for both events, preserving the rest of the file.
 *
 * Written through a temporary file and renamed into place: settings.json is
 * read by every Claude Code session, and a half-written one is worse than an
 * unregistered hook.
 */
function registerHook(args) {
  const hookPath = path.join(args.target, 'session-capture.mjs');
  const command = hookCommand(args.node, hookPath);

  // A settings file next to a hook somewhere else is almost always a mistake —
  // a test installing into a temp directory, say. Registering it would point
  // every future session at a path that is about to be deleted, and leave the
  // entry behind forever. Refuse unless both were redirected together.
  if (!sameDirectory(path.dirname(args.settings), path.dirname(args.target))) {
    console.log(
      `  settings: skipped — ${args.target} is not beside ${args.settings}; ` +
        'pass --settings too, or --skip-settings to silence this',
    );
    return { ok: true, added: [], unchanged: [] };
  }

  let raw = '';
  try {
    raw = fs.readFileSync(args.settings, 'utf8');
  } catch {
    raw = '';
  }

  let current = {};
  if (raw.trim()) {
    try {
      current = JSON.parse(raw);
    } catch (err) {
      console.error(`refusing to touch settings: ${args.settings} is not valid JSON (${err.message})`);
      return { ok: false, added: [], unchanged: [] };
    }
  }

  const { settings, added, unchanged } = withHookRegistered(current, command);
  for (const event of unchanged) console.log(`  settings ${event}: already registered`);
  for (const event of added) console.log(`  settings ${event}: registering`);
  if (added.length === 0) return { ok: true, added, unchanged };
  if (args.dryRun) return { ok: true, added, unchanged };

  const text = `${JSON.stringify(settings, null, 2)}
`;
  const temporary = `${args.settings}.session-capture-tmp`;
  try {
    if (raw) fs.writeFileSync(`${args.settings}.bak`, raw, 'utf8');
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, args.settings);
  } catch (err) {
    console.error(`settings write failed: ${err?.message || err}`);
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* the temporary file is not worth a second error */
    }
    return { ok: false, added, unchanged };
  }
  return { ok: true, added, unchanged };
}

/** Are these the same directory, separators and case aside? */
function sameDirectory(a, b) {
  const normalise = (value) => path.resolve(value).replace(/\\/g, '/').toLowerCase();
  return normalise(a) === normalise(b);
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
    if (!args.skipSettings && !registerHook(args).ok) process.exitCode = 1;
    return;
  }

  console.log(`target: ${args.target}`);
  for (const change of toWrite) console.log(`  ${change.isNew ? 'add   ' : 'update'} ${change.relative}`);
  if (args.dryRun) {
    console.log(`dry run: ${toWrite.length} file(s) would change, nothing written`);
    if (!args.skipSettings) registerHook(args);
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
  if (!args.skipSettings && !registerHook(args).ok) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error(`install failed: ${err?.message || err}`);
  process.exitCode = 1;
}
