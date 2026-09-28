/**
 * `install.mjs --config`: placing a claude-config clone on a machine (R-H5).
 *
 * Every run points `--config-repo`, `--target` and HOME at a temp folder, so
 * the real ~/.claude is never read or written. The fake key is assembled from
 * parts at test time so no scanner mistakes this file for a leak.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { HOME_PLACEHOLDER, SCAN_EXCEPTIONS_FILE, SETTINGS_TEMPLATE_FILE } from '../lib/claude-config.mjs';

const INSTALLER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'install.mjs');
const FAKE_GITHUB_TOKEN = ['gh', 'p_', 'FakeTestKeyNotReal', '0'.repeat(20)].join('');
const MISSING_NODE = 'Z:/no-such-dir/node.exe';
const THIS_NODE = process.execPath.replace(/\\/g, '/');

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-config-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function write(dir, relPath, content) {
  const full = path.join(dir, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

const read = (dir, relPath) => fs.readFileSync(path.join(dir, ...relPath.split('/')), 'utf8');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function template() {
  const hooks = `${HOME_PLACEHOLDER}/.claude/hooks`;
  return {
    hooks: {
      SessionEnd: [{ hooks: [{ type: 'command', command: `"${MISSING_NODE}" "${hooks}/session-capture.mjs"`, timeout: 20 }] }],
      SessionStart: [
        { matcher: 'startup|resume', hooks: [{ type: 'command', command: `"${MISSING_NODE}" "${hooks}/session-start.mjs"`, timeout: 5 }] },
      ],
    },
    permissions: { allow: ['Bash(git status)', `Read(${HOME_PLACEHOLDER}/notes/**)`], deny: ['Read(./.env)'] },
  };
}

/** A home with an empty `.claude` and a config repo clone beside it. */
function world(root) {
  const home = path.join(root, 'home');
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const repo = path.join(root, 'claude-config');
  write(repo, 'CLAUDE.md', '# global instructions\n');
  write(repo, 'rules/common/style.md', 'be kind\n');
  write(repo, 'skills/tdd/SKILL.md', '---\nname: tdd\n---\nred, green, refactor\n');
  write(repo, 'README.md', '# claude-config\n');
  write(repo, '.git/HEAD', 'ref: refs/heads/main\n');
  write(repo, SETTINGS_TEMPLATE_FILE, `${JSON.stringify(template(), null, 2)}\n`);
  return { home, claudeDir, repo };
}

function install({ home, claudeDir, repo }, ...flags) {
  const args = [INSTALLER, '--config', ...flags, '--config-repo', repo, '--target', claudeDir, '--node', process.execPath];
  const env = { ...process.env, HOME: home, USERPROFILE: home, HARNESS_MACHINE_ENV: path.join(home, 'absent.env') };
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout: 60_000 });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function listTree(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)).replace(/\\/g, '/'))
    .sort();
}

test('--config needs --dry-run or --apply, and refuses the hook-install flags', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    assert.equal(install(w).status, 1);
    assert.match(install(w).out, /--dry-run or --apply/);
    assert.match(install(w, '--dry-run', '--apply').out, /either --dry-run or --apply/);
    assert.match(install(w, '--dry-run', '--register-mcp').out, /--register-mcp.*not with --config/);
  } finally {
    cleanup();
  }
});

test('a dry run lists every file with its status and the counts, and writes nothing', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    write(w.claudeDir, 'CLAUDE.md', '# an older version\n');
    const before = listTree(w.claudeDir);

    const { status, out } = install(w, '--dry-run');
    assert.equal(status, 0, out);
    assert.match(out, /changed\s+CLAUDE\.md/);
    assert.match(out, /new\s+rules\/common\/style\.md/);
    assert.match(out, /new\s+skills\/tdd\/SKILL\.md/);
    assert.match(out, /ignored\s+README\.md/);
    assert.match(out, /files: 2 new, 1 changed, 0 unchanged, 0 blocked, 1 ignored/);
    assert.match(out, /settings: \+2 hook\(s\)/);
    assert.match(out, /dry run: nothing written/);
    assert.deepEqual(listTree(w.claudeDir), before);
    assert.equal(read(w.claudeDir, 'CLAUDE.md'), '# an older version\n');
  } finally {
    cleanup();
  }
});

test('apply writes new and changed files, backs up what it overwrites, and never deletes', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    write(w.claudeDir, 'CLAUDE.md', '# an older version\n');
    write(w.claudeDir, 'rules/local-only.md', 'this machine only\n');
    write(w.claudeDir, 'history.jsonl', '{}\n');

    const { status, out } = install(w, '--apply');
    assert.equal(status, 0, out);
    assert.match(out, /verified/);
    assert.equal(read(w.claudeDir, 'CLAUDE.md'), '# global instructions\n');
    assert.equal(read(w.claudeDir, 'skills/tdd/SKILL.md'), read(w.repo, 'skills/tdd/SKILL.md'));
    assert.equal(read(w.claudeDir, 'rules/local-only.md'), 'this machine only\n', 'a file the repo lacks is kept');
    assert.equal(read(w.claudeDir, 'history.jsonl'), '{}\n');
    assert.ok(!fs.existsSync(path.join(w.claudeDir, 'README.md')), 'repo meta files are not installed');

    const backups = fs.readdirSync(w.claudeDir).filter((name) => name.startsWith('config-backup-'));
    assert.equal(backups.length, 1);
    assert.equal(read(path.join(w.claudeDir, backups[0]), 'CLAUDE.md'), '# an older version\n');

    const again = install(w, '--apply');
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /files: 0 new, 0 changed, 3 unchanged/);
    assert.match(again.out, /settings: no change/);
    assert.equal(fs.readdirSync(w.claudeDir).filter((name) => name.startsWith('config-backup-')).length, 1);
  } finally {
    cleanup();
  }
});

test('a denylisted path in the repo is refused, and the whole apply with it', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    write(w.repo, 'skills/evil/.credentials.json', '{"fake":true}\n');

    const { status, out } = install(w, '--apply');
    assert.equal(status, 1, out);
    assert.match(out, /refused\s+skills\/evil\/\.credentials\.json \(denylist \.credentials\.json\)/);
    assert.match(out, /refusing/);
    assert.deepEqual(listTree(w.claudeDir), [], 'nothing is written');
  } finally {
    cleanup();
  }
});

test('a secret planted in the repo refuses the apply by path, rule and line, never the value', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    // No `token =` in front: that would add a second finding (named-secret-assignment).
    const planted = `---\nname: tdd\n---\npasted ${FAKE_GITHUB_TOKEN} here\n`;
    write(w.repo, 'skills/tdd/SKILL.md', planted);

    const refused = install(w, '--apply');
    assert.equal(refused.status, 1, refused.out);
    assert.match(refused.out, /skills\/tdd\/SKILL\.md:4 github-token/);
    assert.ok(!refused.out.includes(FAKE_GITHUB_TOKEN), 'the value is never printed');
    assert.deepEqual(listTree(w.claudeDir), []);

    const dry = install(w, '--dry-run');
    assert.equal(dry.status, 1, 'a dry run says the apply would refuse');

    // A reviewed exception with the file's hash lets it through.
    const entry = { path: 'skills/tdd/SKILL.md', rule: 'github-token', line: 4, sha256: sha256(planted) };
    write(w.repo, SCAN_EXCEPTIONS_FILE, JSON.stringify([entry]));
    const allowed = install(w, '--apply');
    assert.equal(allowed.status, 0, allowed.out);
    assert.match(allowed.out, /1 excepted/);
  } finally {
    cleanup();
  }
});

test('a malformed exceptions file refuses rather than excepting nothing or everything', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    write(w.repo, SCAN_EXCEPTIONS_FILE, '{ nope');
    const { status, out } = install(w, '--apply');
    assert.equal(status, 1);
    assert.match(out, /\.scan-exceptions\.json is not valid JSON/);
    assert.deepEqual(listTree(w.claudeDir), []);
  } finally {
    cleanup();
  }
});

test('settings: adds our registrations and permissions once, keeps the rest, rewrites a missing node', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    const otherTool = { hooks: [{ type: 'command', command: 'other-tool on-end' }] };
    const original = {
      model: 'opus',
      env: { KEEP: '1' },
      hooks: { SessionEnd: [otherTool], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] },
      permissions: { allow: ['Bash(ls)'] },
    };
    const settingsFile = path.join(w.claudeDir, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify(original, null, 2));

    const { status, out } = install(w, '--apply');
    assert.equal(status, 0, out);
    assert.match(out, /node rewritten/);
    const merged = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(merged.model, 'opus');
    assert.deepEqual(merged.env, { KEEP: '1' });
    assert.deepEqual(merged.hooks.PreToolUse, original.hooks.PreToolUse);
    assert.deepEqual(merged.hooks.SessionEnd[0], otherTool);
    const homePosix = w.home.replace(/\\/g, '/');
    assert.equal(
      merged.hooks.SessionEnd[1].hooks[0].command,
      `"${THIS_NODE}" "${homePosix}/.claude/hooks/session-capture.mjs"`,
    );
    assert.equal(merged.hooks.SessionStart[0].matcher, 'startup|resume');
    assert.deepEqual(merged.permissions.allow, ['Bash(ls)', 'Bash(git status)', `Read(${homePosix}/notes/**)`]);
    assert.deepEqual(merged.permissions.deny, ['Read(./.env)']);

    const backup = fs.readdirSync(w.claudeDir).find((name) => name.startsWith('config-backup-'));
    assert.deepEqual(JSON.parse(read(path.join(w.claudeDir, backup), 'settings.json')), original);
    assert.ok(!fs.readdirSync(w.claudeDir).some((name) => name.includes('tmp')), 'no temporary file left behind');

    const bytes = fs.readFileSync(settingsFile, 'utf8');
    const again = install(w, '--apply');
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /settings: no change/);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), bytes, 'a second run changes nothing');
  } finally {
    cleanup();
  }
});

test('settings: no settings.json yet is created; one that is not JSON is refused before any write', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    const created = install(w, '--apply');
    assert.equal(created.status, 0, created.out);
    const settings = JSON.parse(read(w.claudeDir, 'settings.json'));
    assert.equal(Object.keys(settings.hooks).length, 2);

    const other = world(path.join(root, 'b'));
    fs.writeFileSync(path.join(other.claudeDir, 'settings.json'), '{ "env": { "TOKEN": "hunter2" }, oops');
    const refused = install(other, '--apply');
    assert.equal(refused.status, 1);
    assert.match(refused.out, /settings\.json is not valid JSON/);
    assert.ok(!refused.out.includes('hunter2'));
    assert.deepEqual(listTree(other.claudeDir), ['settings.json'], 'no file was installed');
  } finally {
    cleanup();
  }
});

test('a repo that is not a directory, or has no allowlisted files, is refused', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    const missing = install({ ...w, repo: path.join(root, 'nope') }, '--dry-run');
    assert.equal(missing.status, 1);
    assert.match(missing.out, /is not a directory/);

    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    const bare = install({ ...w, repo: empty }, '--apply');
    assert.equal(bare.status, 1);
    assert.match(bare.out, /no allowlisted files/);
  } finally {
    cleanup();
  }
});

test('a fresh machine with no ~/.claude yet gets the files and a settings.json', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    fs.rmSync(w.claudeDir, { recursive: true });
    const { status, out } = install(w, '--apply');
    assert.equal(status, 0, out);
    assert.deepEqual(listTree(w.claudeDir), ['CLAUDE.md', 'rules/common/style.md', 'settings.json', 'skills/tdd/SKILL.md']);
  } finally {
    cleanup();
  }
});
