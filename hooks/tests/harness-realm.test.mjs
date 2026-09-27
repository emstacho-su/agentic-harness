/**
 * R-H1: the `harness` realm, a third top-level area next to `projects` and
 * `classes`. The realm tools already take any realm name; what these tests pin
 * is that the capture side treats `harness/<collection>/` like the other two
 * areas (hub links, hub notes, the sweep's index, the untagged list), and that
 * `init-realm` and `sync-realms --push --dry-run` work on it end to end.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { run as initRealm } from '../init-realm.mjs';
import { deriveCollection } from '../lib/collection.mjs';
import { AREA_HARNESS, AREAS } from '../lib/constants.mjs';
import { runGitSync } from '../lib/git-log.mjs';
import { hubLink, withLinks } from '../lib/links.mjs';
import { planNote } from '../lib/migrate.mjs';
import { ensureIndex, findNotesByName } from '../lib/notes-io.mjs';
import { indexNotedSessions } from '../lib/sweep.mjs';
import { run as syncRealms } from '../sync-realms.mjs';
import { readSessionNotes } from '../untagged-sessions.mjs';

const SESSION = '0b8f3c1e-7a2d-4e6f-9c10-5d4b3a2f1e0d';
const COLLECTION = 'agentic-harness';
const HUB = `${COLLECTION}.md`;
/** Identity for the realm commits; the machine file points inside the scratch root, where none exists. */
const identityEnv = (root) =>
  Object.freeze({ HARNESS_MACHINE_ENV: path.join(root, 'absent-machine.env'), HARNESS_MACHINE: 'home-pc', HARNESS_GIT_EMAIL: 'me@example.edu' });
const yamlQuoted = (value) => `'${String(value).replace(/'/g, "''")}'`;

function scratchVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-realm-'));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, AREA_HARNESS, COLLECTION, 'sessions'), { recursive: true });
  return { root, vault, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function writeSession(vault, fields) {
  const frontmatter = Object.entries(fields).map(([key, value]) => `${key}: ${yamlQuoted(value)}`).join('\n');
  const file = path.join(vault, AREA_HARNESS, COLLECTION, 'sessions', `${SESSION}.md`);
  fs.writeFileSync(file, `---\n${frontmatter}\n---\n\nbody\n`, 'utf8');
  return file;
}

test('AREAS holds harness after the two original areas', () => {
  assert.equal(AREA_HARNESS, 'harness');
  assert.deepEqual([...AREAS], ['projects', 'classes', 'harness']);
  assert.ok(Object.isFrozen(AREAS));
});

test('hub links and session up links resolve inside the harness area', () => {
  assert.equal(hubLink(AREA_HARNESS, COLLECTION), `[[harness/${COLLECTION}/${COLLECTION}|${COLLECTION}]]`);
  const linked = withLinks({ session_id: SESSION, collection: COLLECTION }, AREA_HARNESS);
  assert.equal(linked.up, `[[harness/${COLLECTION}/${COLLECTION}|${COLLECTION}]]`);
});

test('ensureIndex writes the collection hub under harness/', () => {
  const s = scratchVault();
  try {
    const made = ensureIndex(s.vault, AREA_HARNESS, COLLECTION);
    assert.equal(made.ok, true, made.error);
    assert.equal(made.created, true);
    assert.equal(made.path, path.join(s.vault, AREA_HARNESS, COLLECTION, HUB));
    assert.ok(fs.statSync(made.path).size > 0);
  } finally {
    s.cleanup();
  }
});

test('a harness session note is found by name, indexed by the sweep, and read by the untagged list', () => {
  const s = scratchVault();
  try {
    writeSession(s.vault, { session_id: SESSION, date: '2026-09-27', collection: COLLECTION, status: 'concluded', tags: 'unclassified' });
    assert.deepEqual(
      findNotesByName(s.vault, `${SESSION}.md`).map(({ area, collection }) => ({ area, collection })),
      [{ area: AREA_HARNESS, collection: COLLECTION }],
    );
    assert.deepEqual([...indexNotedSessions(s.vault)], [SESSION]);
    const { notes, problems } = readSessionNotes(s.vault);
    assert.deepEqual(problems, []);
    assert.deepEqual(notes.map((note) => [note.area, note.collection, note.fields.session_id]), [[AREA_HARNESS, COLLECTION, SESSION]]);
  } finally {
    s.cleanup();
  }
});

test('migration keeps a harness note in the harness area when nothing reroutes it', () => {
  const note = { area: AREA_HARNESS, collection: COLLECTION, name: `${SESSION}.md`, fields: { session_id: SESSION } };
  const plan = planNote({ note, resolveRepoFor: () => null, overrides: {} });
  assert.equal(plan.area, AREA_HARNESS);
  assert.equal(plan.collection, COLLECTION);
});

test('a worktree folder is owned by its project when the project folder is under harness/', () => {
  const s = scratchVault();
  try {
    const cwd = path.join(s.root, 'agentic-harness-wt-gone');
    const placed = deriveCollection({ cwd, vaultRoot: s.vault, repo: null });
    assert.equal(placed.collection, COLLECTION, 'not a new agentic-harness-wt-gone collection');
  } finally {
    s.cleanup();
  }
});

// ------------------------------------------------------------------- real git

function realGit(root) {
  const globalConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  const isolation = Object.freeze({ GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: root });
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...isolation }, stdio: ['ignore', 'pipe', 'pipe'] });
  const runGit = (args, options) => runGitSync(args, { ...options, env: { ...(options.env ?? {}), ...isolation } });
  return { git, runGit };
}

test('real git: init-realm makes the harness baseline from the policy files alone (no second hub before R-H3), and a push dry run would commit, pull and push a new note', () => {
  const s = scratchVault();
  try {
    const { git, runGit } = realGit(s.root);
    const realmDir = path.join(s.vault, AREA_HARNESS);
    const remote = path.join(s.root, 'vault-harness.git');
    git(['init', '--bare', '--quiet', '-b', 'main', remote], s.root);
    const env = { ...identityEnv(s.root), HARNESS_REALMS: 'projects:push,classes:push,harness:push' };

    const lines = [];
    const say = (line) => lines.push(line);
    const initArgs = ['--vault', s.vault, '--realm', AREA_HARNESS, '--remote', pathToFileURL(remote).href];
    const dry = initRealm([...initArgs, '--dry-run'], { env, out: say, err: say, runGit });
    assert.equal(dry, 0, lines.join('\n'));
    assert.equal(fs.existsSync(path.join(realmDir, '.git')), false, 'the dry run made no repository');

    lines.length = 0;
    const real = initRealm(initArgs, { env, out: say, err: say, runGit });
    assert.equal(real, 0, lines.join('\n'));
    assert.equal(fs.readFileSync(path.join(realmDir, '.realm'), 'utf8').trim(), AREA_HARNESS);
    assert.equal(git(['rev-list', '--count', 'main'], realmDir).trim(), '1', 'one baseline commit');
    assert.deepEqual(
      git(['ls-tree', '-r', '--name-only', 'HEAD'], realmDir).trim().split('\n'),
      ['.gitattributes', '.gitignore', '.realm'],
    );

    // The one hand step the sync asks for on a realm's first push (realm-steps: "no upstream").
    git(['push', '--quiet', '-u', 'origin', 'main'], realmDir);
    writeSession(s.vault, { session_id: SESSION, date: '2026-09-27', collection: COLLECTION, status: 'concluded' });

    lines.length = 0;
    const code = syncRealms(['--push', '--dry-run', '--vault', s.vault], { env, out: say, err: say, runGit });
    assert.ok(lines.includes('harness: would-commit -> would-pull -> would-push'), lines.join('\n'));
    assert.equal(code, 0, lines.join('\n'));
  } finally {
    s.cleanup();
  }
});
