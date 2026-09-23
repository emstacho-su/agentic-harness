/**
 * Realm policy files (R-A1, R-A2): line endings and per-device Obsidian state
 * are decided by files committed in the realm, never by a machine's git config.
 *
 * The content tests are byte-exact. The `check-ignore` and `ls-files --eol`
 * tests run real git in a scratch repo, because whether git *reads* the files
 * the way we mean is the whole point and a fake cannot prove it.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GITATTRIBUTES_TEXT, gitignoreText, realmPolicyFiles, writeRealmFiles } from '../lib/realm-init.mjs';

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'realm-init-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];

// --------------------------------------------------------------- R-A1 content

test('R-A1: .gitattributes is byte-exact — text=auto and LF for markdown', () => {
  assert.equal(GITATTRIBUTES_TEXT, '* text=auto\n*.md text eol=lf\n');
  const files = realmPolicyFiles('projects');
  assert.equal(files.find((f) => f.relPath === '.gitattributes').text, GITATTRIBUTES_TEXT);
  assert.equal(files.find((f) => f.relPath === '.realm').text, 'projects\n');
  assert.deepEqual(
    files.map((f) => f.relPath),
    ['.realm', '.gitattributes', '.gitignore'],
  );
});

// --------------------------------------------------------------- R-A2 content

test('R-A2: projects tracks .obsidian settings but never the per-device files', () => {
  const lines = gitignoreText({ trackObsidianSettings: true }).split('\n');
  assert.equal(lines.at(-1), '', 'LF-terminated');
  for (const expected of ['.obsidian/workspace.json', '.obsidian/workspace-mobile.json', '.obsidian/plugins/*/', '.trash/', '.DS_Store', 'Thumbs.db']) {
    assert.ok(lines.includes(expected), `missing ${expected}`);
  }
  assert.ok(!lines.includes('.obsidian/'), 'projects must keep app.json and friends');
});

test('R-A2: every other realm ignores .obsidian wholesale', () => {
  const lines = gitignoreText({ trackObsidianSettings: false }).split('\n');
  assert.ok(lines.includes('.obsidian/'));
  assert.ok(!lines.includes('.obsidian/workspace.json'), 'the narrower rule is redundant next to the wide one');
  const classes = realmPolicyFiles('classes').find((f) => f.relPath === '.gitignore').text;
  assert.equal(classes, gitignoreText({ trackObsidianSettings: false }));
  const projects = realmPolicyFiles('projects').find((f) => f.relPath === '.gitignore').text;
  assert.equal(projects, gitignoreText({ trackObsidianSettings: true }));
});

test('realmPolicyFiles refuses a name that is not a realm name', () => {
  assert.throws(() => realmPolicyFiles('Projects'), /realm name/);
  assert.throws(() => realmPolicyFiles(''), /realm name/);
});

// ------------------------------------------------------------------- writer

test('writeRealmFiles: a dry run writes nothing, a real run writes three files, a rerun changes nothing', () => {
  const { root, cleanup } = scratch();
  try {
    const dry = writeRealmFiles(root, 'classes', { dryRun: true });
    assert.deepEqual(
      dry.map((r) => [r.relPath, r.action]),
      [['.realm', 'would-write'], ['.gitattributes', 'would-write'], ['.gitignore', 'would-write']],
    );
    assert.deepEqual(fs.readdirSync(root), []);

    const written = writeRealmFiles(root, 'classes');
    assert.deepEqual(written.map((r) => r.action), ['written', 'written', 'written']);
    assert.equal(fs.readFileSync(path.join(root, '.realm'), 'utf8'), 'classes\n');
    assert.equal(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'), GITATTRIBUTES_TEXT);

    const again = writeRealmFiles(root, 'classes');
    assert.deepEqual(again.map((r) => r.action), ['unchanged', 'unchanged', 'unchanged']);
  } finally {
    cleanup();
  }
});

test('writeRealmFiles refuses to overwrite a marker that names another realm', () => {
  const { root, cleanup } = scratch();
  try {
    fs.writeFileSync(path.join(root, '.realm'), 'projects\n');
    assert.throws(() => writeRealmFiles(root, 'classes'), /already marked as 'projects'/);
    assert.equal(fs.readFileSync(path.join(root, '.realm'), 'utf8'), 'projects\n');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- real git

test('R-A2 with real git: check-ignore accepts every per-device path and keeps app.json in projects', () => {
  const { root, cleanup } = scratch();
  try {
    git(['init', '--quiet', '-b', 'main'], root);
    writeRealmFiles(root, 'projects');
    const ignored = ['.obsidian/workspace.json', '.obsidian/workspace-mobile.json', '.trash/x.md', '.DS_Store', 'sub/Thumbs.db', '.obsidian/plugins/foo/data.json'];
    const out = git(['check-ignore', '--no-index', ...ignored], root);
    assert.deepEqual(out.trim().split(/\r?\n/), ignored);
    assert.throws(() => git(['check-ignore', '--no-index', '.obsidian/app.json'], root), 'app.json must not be ignored in projects');
    assert.throws(() => git(['check-ignore', '--no-index', 'a/note.md'], root));
  } finally {
    cleanup();
  }
});

test('R-A2 with real git: a non-projects realm ignores .obsidian/app.json too', () => {
  const { root, cleanup } = scratch();
  try {
    git(['init', '--quiet', '-b', 'main'], root);
    writeRealmFiles(root, 'classes');
    assert.equal(git(['check-ignore', '--no-index', '.obsidian/app.json'], root).trim(), '.obsidian/app.json');
  } finally {
    cleanup();
  }
});

test('R-A1 dry run with real git: after renormalize, every .md is LF in the index whatever autocrlf says', () => {
  const { root, cleanup } = scratch();
  try {
    git(['init', '--quiet', '-b', 'main'], root);
    // The worst case: this machine turns everything to CRLF on the way in.
    git(['config', 'core.autocrlf', 'true'], root);
    writeRealmFiles(root, 'projects');
    fs.mkdirSync(path.join(root, 'a'));
    fs.writeFileSync(path.join(root, 'a', 'crlf.md'), '# one\r\n\r\ntwo\r\n');
    fs.writeFileSync(path.join(root, 'a', 'lf.md'), '# one\n\ntwo\n');
    fs.writeFileSync(path.join(root, 'a', 'mixed.md'), '# one\r\ntwo\n');
    git(['add', '.'], root);
    git(['add', '--renormalize', '.'], root);
    git([...IDENTITY, 'commit', '--quiet', '-m', 'init realm'], root);

    const eol = git(['ls-files', '--eol'], root).trim().split(/\r?\n/);
    const markdown = eol.filter((line) => line.endsWith('.md'));
    assert.equal(markdown.length, 3);
    for (const line of markdown) assert.match(line, /^i\/lf\b/, line);
    assert.ok(eol.some((line) => line.endsWith('.gitattributes')), 'the policy is in the first commit');
  } finally {
    cleanup();
  }
});
