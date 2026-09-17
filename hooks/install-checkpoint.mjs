#!/usr/bin/env node
/**
 * install-checkpoint.mjs — put the /checkpoint skill into a repository.
 *
 *   node hooks/install-checkpoint.mjs --repo <path> [--dry-run]
 *
 * Cloud sessions load skills from the repository they run in, not from
 * ~/.claude, so the skill has to be committed into every repo where cloud
 * sessions happen. `skills/checkpoint/` in this checkout is the source of
 * truth; this copies it to `<repo>/.claude/skills/checkpoint/`, verifies each
 * file by SHA-256, and makes sure `.harness/checkpoint-body.md` (the model's
 * scratch file) is git-ignored while the notes themselves stay committable.
 *
 * It never commits: what lands in the repo's history is Stack's call.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE_DIR = path.resolve(HERE, '..', 'skills', 'checkpoint');
export const TARGET_RELATIVE = path.join('.claude', 'skills', 'checkpoint');
export const PAYLOAD = Object.freeze(['SKILL.md', 'build-note.mjs']);
export const GITIGNORE_LINE = '.harness/checkpoint-body.md';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function parseArgs(argv) {
  const options = { repo: '', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo') {
      i += 1;
      if (i >= argv.length) return { ok: false, error: '--repo needs a value' };
      options.repo = argv[i];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else {
      return { ok: false, error: `unknown option ${arg}` };
    }
  }
  if (!options.repo) return { ok: false, error: '--repo <path> is required' };
  return { ok: true, options };
}

/**
 * Plan and (unless dry) apply the install. Returns what changed; throws only
 * when the repository or the source payload is not where it should be.
 */
export function installCheckpoint({ repo, dryRun = false, sourceDir = SOURCE_DIR }) {
  if (!fs.existsSync(path.join(repo, '.git'))) throw new Error(`not a git repository: ${repo}`);
  for (const name of PAYLOAD) {
    if (!fs.existsSync(path.join(sourceDir, name))) throw new Error(`payload file missing: ${path.join(sourceDir, name)}`);
  }

  const targetDir = path.join(repo, TARGET_RELATIVE);
  const files = PAYLOAD.map((name) => {
    const source = path.join(sourceDir, name);
    const destination = path.join(targetDir, name);
    const sourceHash = sha256(source);
    const existing = fs.existsSync(destination) ? sha256(destination) : '';
    return { name, source, destination, sourceHash, action: existing === sourceHash ? 'unchanged' : existing ? 'update' : 'create' };
  });

  const gitignorePath = path.join(repo, '.gitignore');
  const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const ignoreAction = gitignore.split(/\r?\n/).some((line) => line.trim() === GITIGNORE_LINE) ? 'unchanged' : 'append';

  if (!dryRun) {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const file of files) {
      if (file.action === 'unchanged') continue;
      fs.copyFileSync(file.source, file.destination);
      if (sha256(file.destination) !== file.sourceHash) throw new Error(`verification failed for ${file.destination}`);
    }
    if (ignoreAction === 'append') {
      const separator = gitignore && !gitignore.endsWith('\n') ? '\n' : '';
      fs.writeFileSync(gitignorePath, `${gitignore}${separator}${GITIGNORE_LINE}\n`, 'utf8');
    }
  }

  return { repo, targetDir, dryRun, files: files.map(({ name, action }) => ({ name, action })), gitignore: ignoreAction };
}

export function run(argv, { out = console.log, err = console.error } = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    err(`error: ${parsed.error}\nusage: node hooks/install-checkpoint.mjs --repo <path> [--dry-run]`);
    return EXIT_USAGE;
  }
  try {
    const result = installCheckpoint(parsed.options);
    for (const file of result.files) out(`  ${file.action} ${path.join(TARGET_RELATIVE, file.name)}`);
    out(`  ${result.gitignore === 'append' ? 'append' : 'unchanged'} .gitignore (${GITIGNORE_LINE})`);
    out(result.dryRun ? 'dry run: nothing written' : `installed into ${result.targetDir}; commit it in that repo`);
    return EXIT_OK;
  } catch (error) {
    err(`error: ${error.message}`);
    return EXIT_FAILED;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(run(process.argv.slice(2)));
