/**
 * The pieces the two claude-config CLIs share (R-H5): the reviewed exceptions
 * list, which repo paths may exist at all, the clone mirror plan, and the
 * settings merge `install.mjs --config` does on a machine.
 *
 * Pure functions over temp folders; no git, no real ~/.claude.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  REPO_META_FILES,
  SCAN_EXCEPTIONS_FILE,
  exceptionEntry,
  mergeSettingsTemplate,
  parseScanExceptions,
  partitionFindings,
  planExport,
  planMirror,
  repoPathRule,
} from '../lib/claude-config.mjs';
import { hookCommands, withHookRegistered } from '../lib/settings.mjs';

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const HASH_A = sha('a');

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-helpers-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function write(dir, relPath, content) {
  const full = path.join(dir, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// ---------------------------------------------------------------------------
// .scan-exceptions.json
// ---------------------------------------------------------------------------

test('the exceptions file is named once, and sits beside the allowlist as a repo meta file', () => {
  assert.equal(SCAN_EXCEPTIONS_FILE, '.scan-exceptions.json');
  assert.ok(REPO_META_FILES.includes(SCAN_EXCEPTIONS_FILE));
  assert.ok(Object.isFrozen(REPO_META_FILES));
});

test('parseScanExceptions reads a list of {path, rule, line, sha256}, with an optional reason', () => {
  const text = JSON.stringify([
    { path: 'skills/a/SKILL.md', rule: 'jwt', line: 3, sha256: HASH_A },
    { path: 'rules/b.md', rule: 'openai-key', line: 1, sha256: HASH_A, reason: 'documented example' },
  ]);
  const parsed = parseScanExceptions(text);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { path: 'skills/a/SKILL.md', rule: 'jwt', line: 3, sha256: HASH_A });
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed[0]));
  assert.deepEqual(parseScanExceptions(''), []);
  assert.deepEqual(parseScanExceptions('[]'), []);
});

test('parseScanExceptions refuses anything it cannot read exactly, naming the entry', () => {
  const bad = [
    ['{ nope', /not valid JSON/],
    ['{"path":"x"}', /must be a JSON list/],
    ['[1]', /entry 0/],
    [JSON.stringify([{ path: 'x', rule: 'jwt', line: 1 }]), /entry 0.*sha256/],
    [JSON.stringify([{ path: 'x', rule: 'jwt', line: 1, sha256: 'abc' }]), /sha256/],
    [JSON.stringify([{ path: 'x', rule: 'jwt', line: 0, sha256: HASH_A }]), /line/],
    [JSON.stringify([{ path: 'x', rule: 'jwt', line: 1.5, sha256: HASH_A }]), /line/],
    [JSON.stringify([{ path: '', rule: 'jwt', line: 1, sha256: HASH_A }]), /path/],
    [JSON.stringify([{ path: 'x', rule: 'jwt', line: 1, sha: HASH_A }]), /unknown key "sha"/],
  ];
  for (const [text, message] of bad) assert.throws(() => parseScanExceptions(text), message, text);
});

test('exceptionEntry is the finding plus the hash, and never anything else', () => {
  const entry = exceptionEntry({ path: 'skills/a/SKILL.md', rule: 'jwt', line: 3 }, HASH_A);
  assert.deepEqual(entry, { path: 'skills/a/SKILL.md', rule: 'jwt', line: 3, sha256: HASH_A });
  assert.deepEqual(Object.keys(entry), ['path', 'rule', 'line', 'sha256']);
});

test('a finding is excepted only when path, rule, line and the file hash all match', () => {
  const finding = { path: 'skills/a/SKILL.md', rule: 'jwt', line: 3 };
  const exceptions = parseScanExceptions(JSON.stringify([exceptionEntry(finding, HASH_A)]));
  const hashes = { 'skills/a/SKILL.md': HASH_A };
  const hashOf = (p) => hashes[p];

  const passed = partitionFindings([finding], exceptions, hashOf);
  assert.deepEqual(passed.unexcepted, []);
  assert.deepEqual(passed.excepted, [finding]);

  // The file was edited: same finding, different content, so it comes back.
  const edited = partitionFindings([finding], exceptions, () => sha('edited'));
  assert.deepEqual(edited.unexcepted, [finding]);

  for (const other of [
    { ...finding, line: 4 },
    { ...finding, rule: 'openai-key' },
    { ...finding, path: 'skills/b/SKILL.md' },
  ]) {
    const result = partitionFindings([other], exceptions, () => HASH_A);
    assert.deepEqual(result.unexcepted, [other], JSON.stringify(other));
  }
  assert.throws(() => partitionFindings('x', [], hashOf), TypeError);
});

// ---------------------------------------------------------------------------
// Which repo paths may exist
// ---------------------------------------------------------------------------

test('repoPathRule allows the allowlist and the repo meta files, and nothing else', () => {
  for (const ok of [
    'CLAUDE.md',
    'settings.template.json',
    'rules/common/x.md',
    'skills/tdd/SKILL.md',
    'skill-vault/a/b/c.py',
    '.gitattributes',
    '.gitignore',
    'README.md',
    '.scan-exceptions.json',
  ]) {
    assert.equal(repoPathRule(ok), null, ok);
  }
  assert.equal(repoPathRule('settings.json'), 'not-allowlisted');
  assert.equal(repoPathRule('notes/x.md'), 'not-allowlisted');
  assert.equal(repoPathRule('rules'), 'not-allowlisted', 'a bare folder name is not a file in it');
  assert.equal(repoPathRule('Skills/tdd/SKILL.md'), 'not-allowlisted', 'names match exactly, as git paths do');
  assert.equal(repoPathRule('rules/README.md/x'), null);
  assert.equal(repoPathRule('skills/x/.credentials.json'), 'denylist:.credentials.json');
  assert.equal(repoPathRule('skills/x/node_modules/y.js'), 'denylist:node_modules/');
  assert.equal(repoPathRule('rules/app.log'), 'denylist:*.log');
});

// ---------------------------------------------------------------------------
// planMirror: what an export writes into and deletes from the clone
// ---------------------------------------------------------------------------

test('planMirror lists new, changed and unchanged writes, and stale files only inside allowlisted folders', () => {
  const { root, cleanup } = scratch();
  try {
    const source = path.join(root, '.claude');
    write(source, 'CLAUDE.md', 'same');
    write(source, 'rules/a.md', 'new text');
    write(source, 'skills/x/SKILL.md', 'fresh');

    const clone = path.join(root, 'clone');
    write(clone, 'CLAUDE.md', 'same');
    write(clone, 'rules/a.md', 'old text');
    write(clone, 'rules/gone.md', 'stale');
    write(clone, 'skills/old/SKILL.md', 'stale');
    write(clone, 'skills/x/.env', 'refused in the clone too');
    write(clone, 'skill-vault/v/SKILL.md', 'the source has no skill-vault at all');
    write(clone, 'README.md', 'not ours to delete');
    write(clone, 'other/keep.md', 'outside the allowlist: never touched');
    write(clone, '.git/HEAD', 'ref: refs/heads/main\n');

    const mirror = planMirror(planExport(source), clone);
    assert.deepEqual(
      mirror.writes.map((w) => `${w.path}:${w.status}`),
      ['CLAUDE.md:unchanged', 'rules/a.md:changed', 'skills/x/SKILL.md:new'],
    );
    assert.equal(mirror.writes[1].target, path.join(clone, 'rules', 'a.md'));
    assert.deepEqual(mirror.deletions.map((d) => d.path), [
      'rules/gone.md',
      'skill-vault/v/SKILL.md',
      'skills/old/SKILL.md',
      'skills/x/.env',
    ]);
    for (const d of mirror.deletions) assert.ok(d.target.startsWith(clone + path.sep), d.target);
    assert.ok(Object.isFrozen(mirror));
  } finally {
    cleanup();
  }
});

test('planMirror keeps a clone file whose name differs from the source only in case', () => {
  const { root, cleanup } = scratch();
  try {
    const source = path.join(root, '.claude');
    write(source, 'skills/Tdd/SKILL.md', 'x');
    const clone = path.join(root, 'clone');
    write(clone, 'skills/tdd/SKILL.md', 'x');
    assert.deepEqual(planMirror(planExport(source), clone).deletions, []);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// mergeSettingsTemplate
// ---------------------------------------------------------------------------

const NODE_HERE = 'C:/Program Files/nodejs/node.exe';
const NODE_THERE = 'D:/tools/node/node.exe';
const HOME = 'C:/Users/me';
const cmd = (node, script) => `"${node}" "${script}"`;
const captureScript = `${HOME}/.claude/hooks/session-capture.mjs`;
const startScript = `${HOME}/.claude/hooks/session-start.mjs`;

function template() {
  return {
    hooks: {
      SessionEnd: [{ hooks: [{ type: 'command', command: cmd(NODE_THERE, captureScript), timeout: 20 }] }],
      SessionStart: [
        { matcher: 'startup|resume', hooks: [{ type: 'command', command: cmd(NODE_THERE, startScript), timeout: 5 }] },
      ],
    },
    permissions: {
      allow: ['Bash(git status)', `Read(${HOME}/notes/**)`],
      deny: ['Read(./.env)'],
      defaultMode: 'auto',
    },
  };
}

const onlyHere = (file) => file === NODE_HERE;

test('merge adds our registrations and permissions once, keeping every unrelated key and hook', () => {
  const current = Object.freeze({
    model: 'opus',
    env: Object.freeze({ KEEP: '1' }),
    enabledPlugins: { a: true },
    hooks: {
      SessionEnd: [{ hooks: [{ type: 'command', command: 'node C:/other/tool.mjs' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool check' }] }],
    },
    permissions: { allow: ['Bash(ls)'], defaultMode: 'default' },
  });
  const before = JSON.stringify(current);

  const first = mergeSettingsTemplate(current, template(), { nodePath: NODE_HERE, exists: onlyHere });
  assert.equal(JSON.stringify(current), before, 'the input is not mutated');
  const merged = first.settings;
  assert.equal(merged.model, 'opus');
  assert.deepEqual(merged.env, { KEEP: '1' });
  assert.deepEqual(merged.enabledPlugins, { a: true });
  assert.deepEqual(merged.hooks.PreToolUse, current.hooks.PreToolUse);
  assert.equal(merged.hooks.SessionEnd.length, 2, "the other tool's SessionEnd entry stays");
  assert.equal(merged.hooks.SessionEnd[0], current.hooks.SessionEnd[0]);
  assert.deepEqual(merged.hooks.SessionStart[0].matcher, 'startup|resume');
  assert.deepEqual(merged.permissions.allow, ['Bash(ls)', 'Bash(git status)', `Read(${HOME}/notes/**)`]);
  assert.deepEqual(merged.permissions.deny, ['Read(./.env)']);
  assert.equal(merged.permissions.defaultMode, 'default', 'a setting the machine has is kept');
  assert.deepEqual(first.hooksAdded, [
    { event: 'SessionEnd', script: captureScript },
    { event: 'SessionStart', script: startScript },
  ]);
  assert.equal(first.permissionsAdded.length, 3);
  assert.deepEqual(first.permissionsKept, [{ key: 'defaultMode' }]);
  assert.equal(first.changed, true);

  const second = mergeSettingsTemplate(merged, template(), { nodePath: NODE_HERE, exists: onlyHere });
  assert.equal(second.changed, false, 'a second merge changes nothing');
  assert.deepEqual(second.settings, merged);
  assert.deepEqual(second.hooksAdded, []);
  assert.deepEqual(second.permissionsAdded, []);
});

test('merge rewrites a node path this machine does not have, and leaves one it has', () => {
  const missing = mergeSettingsTemplate({}, template(), { nodePath: NODE_HERE, exists: onlyHere });
  const commands = Object.values(missing.settings.hooks).flatMap((m) => m.flatMap((g) => g.hooks.map((h) => h.command)));
  assert.deepEqual(commands, [cmd(NODE_HERE, captureScript), cmd(NODE_HERE, startScript)]);
  assert.deepEqual(missing.nodeRewritten, [
    { event: 'SessionEnd', from: NODE_THERE, to: NODE_HERE },
    { event: 'SessionStart', from: NODE_THERE, to: NODE_HERE },
  ]);

  const present = mergeSettingsTemplate({}, template(), { nodePath: NODE_HERE, exists: () => true });
  assert.equal(present.settings.hooks.SessionEnd[0].hooks[0].command, cmd(NODE_THERE, captureScript));
  assert.deepEqual(present.nodeRewritten, []);
});

test('merge recognises a registration by its script, whatever node or slashes it runs with', () => {
  const current = {
    hooks: {
      SessionEnd: [{ hooks: [{ type: 'command', command: `"C:\\node\\node.exe" "${captureScript.replace(/\//g, '\\')}"` }] }],
    },
  };
  const result = mergeSettingsTemplate(current, template(), { nodePath: NODE_HERE, exists: onlyHere });
  assert.equal(result.settings.hooks.SessionEnd.length, 1);
  assert.deepEqual(result.hooksAdded.map((h) => h.event), ['SessionStart']);
});

test('merge leaves a bare node, and a non-node executable, alone', () => {
  const t = {
    hooks: {
      Stop: [{ hooks: [
        { type: 'command', command: 'node "C:/x/a.mjs"' },
        { type: 'command', command: '"D:/py/python.exe" "C:/x/b.py"' },
      ] }],
    },
  };
  const result = mergeSettingsTemplate({}, t, { nodePath: NODE_HERE, exists: () => false });
  assert.deepEqual(result.settings.hooks.Stop[0].hooks.map((h) => h.command), [
    'node "C:/x/a.mjs"',
    '"D:/py/python.exe" "C:/x/b.py"',
  ]);
});

test('merge compares permissions with either slash, and adds a missing list whole', () => {
  const current = { permissions: { allow: ['Read(C:\\Users\\me\\notes\\**)'] } };
  const result = mergeSettingsTemplate(current, template(), { nodePath: NODE_HERE, exists: onlyHere });
  assert.deepEqual(result.settings.permissions.allow, ['Read(C:\\Users\\me\\notes\\**)', 'Bash(git status)']);
  assert.deepEqual(result.settings.permissions.deny, ['Read(./.env)']);
  assert.equal(result.settings.permissions.defaultMode, 'auto', 'absent here, so it is added');
});

test('merge keeps a permissions key whose shape differs, and refuses a template that is not an object', () => {
  const current = { permissions: { allow: 'Bash(ls)' } };
  const result = mergeSettingsTemplate(current, template(), { nodePath: NODE_HERE, exists: onlyHere });
  assert.equal(result.settings.permissions.allow, 'Bash(ls)');
  assert.ok(result.permissionsKept.some((k) => k.key === 'allow'));
  assert.throws(() => mergeSettingsTemplate({}, null, { nodePath: NODE_HERE }), TypeError);
  assert.throws(() => mergeSettingsTemplate({}, {}, {}), /nodePath/);
});

test('an empty template changes nothing', () => {
  const current = { model: 'x' };
  const result = mergeSettingsTemplate(current, {}, { nodePath: NODE_HERE });
  assert.equal(result.changed, false);
  assert.deepEqual(result.settings, current);
});

// ------------------------------------------------- one hook-recognition rule (settings.mjs hookIdentity)

const commandsOf = (settings, event) => (settings.hooks?.[event] ?? []).flatMap((group) => group.hooks.map((h) => h.command));

test('merge: two different non-node commands are two hooks; an existing one blocks only itself', () => {
  const t = (...commands) => ({ hooks: { Stop: [{ hooks: commands.map((command) => ({ type: 'command', command })) }] } });
  const both = mergeSettingsTemplate({}, t('bash -c "a"', 'bash -c "b"'), { nodePath: NODE_HERE });
  assert.deepEqual(commandsOf(both.settings, 'Stop'), ['bash -c "a"', 'bash -c "b"']);

  const current = t('bash -c "x"');
  const added = mergeSettingsTemplate(current, t('bash -c "y"'), { nodePath: NODE_HERE });
  assert.deepEqual(commandsOf(added.settings, 'Stop'), ['bash -c "x"', 'bash -c "y"']);
  assert.equal(added.hooksAdded.length, 1);

  const again = mergeSettingsTemplate(added.settings, t('bash -c "y"', '  bash   -c "x" '), { nodePath: NODE_HERE });
  assert.equal(again.changed, false, 'the same command, spacing aside, is already there');
});

test('bootstrap step 7 (config merge) then step 8 (hook install) under another node leaves one entry per event', () => {
  const hooksDir = `${HOME}/.claude/hooks`;
  // Step 7: the template carries the exporting machine's node, which exists here too.
  const step7 = mergeSettingsTemplate({}, template(), { nodePath: NODE_HERE, exists: () => true });
  // Step 8: install.mjs registers with this process's node, a different path.
  const step8 = withHookRegistered(step7.settings, hookCommands(NODE_HERE, hooksDir));
  assert.deepEqual(step8.unchanged, ['SessionEnd', 'SessionStart']);
  assert.deepEqual(step8.added, ['SubagentStop'], 'the template had no SubagentStop, so only it is added');
  for (const event of ['SessionEnd', 'SubagentStop', 'SessionStart']) {
    assert.equal(commandsOf(step8.settings, event).length, 1, event);
  }

  // And in the other order: the hook install first, then the merge.
  const installed = withHookRegistered({}, hookCommands(NODE_HERE, hooksDir)).settings;
  const merged = mergeSettingsTemplate(installed, template(), { nodePath: NODE_HERE, exists: () => true });
  assert.equal(merged.changed, true, 'the template permissions are still new');
  assert.deepEqual(merged.hooksAdded, []);
  for (const event of ['SessionEnd', 'SubagentStop', 'SessionStart']) {
    assert.equal(commandsOf(merged.settings, event).length, 1, event);
  }
});
