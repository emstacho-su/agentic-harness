/**
 * `~/.claude` as a portable config repo (R-H5).
 *
 * The folder holds live credentials, so everything here is about what does
 * NOT travel: an allowlist picks the few paths that may, a denylist refuses a
 * credential even inside an allowlisted folder, symlinks and oversized files
 * are reported and left behind, and a secret scan with the capture hook's own
 * rules turns any hit into a refusal.
 *
 * The static fixture (`fixtures/claude-home`) holds only harmless files. Every
 * hazard is planted in a temp copy at test time, and the fake key is assembled
 * from parts so no scanner mistakes this file for a leak.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ALLOWLIST,
  DENYLIST,
  HOME_PLACEHOLDER,
  MAX_CONFIG_FILE_BYTES,
  SETTINGS_TEMPLATE_FILE,
  buildSettingsTemplate,
  denylistRule,
  planExport,
  planInstall,
  renderSettingsTemplate,
  scanForSecrets,
} from '../lib/claude-config.mjs';
import { SECRET_RULES, findSecretMatches, redact } from '../lib/redact.mjs';
import { FIXTURES_DIR } from './helpers/sandbox.mjs';

const FIXTURE_HOME = path.join(FIXTURES_DIR, 'claude-home');

/** Obviously fake, and never spelled out whole in the repo. */
const FAKE_GITHUB_TOKEN = ['gh', 'p_', 'FakeTestKeyNotReal', '0'.repeat(20)].join('');

const FIXTURE_FILES = Object.freeze([
  'CLAUDE.md',
  'rules/common/coding-style.md',
  'skill-vault/languages/python/SKILL.md',
  'skills/tdd/SKILL.md',
]);

function scratch(prefix = 'claude-config-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A temp copy of the fixture `~/.claude`, to plant hazards in. */
function fakeClaudeDir(root) {
  const dir = path.join(root, '.claude');
  fs.cpSync(FIXTURE_HOME, dir, { recursive: true });
  return dir;
}

function write(dir, relPath, content) {
  const full = path.join(dir, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

/** A directory link that needs no privilege on Windows: a junction. */
function linkDir(target, link, t) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    t.skip(`cannot create a directory link here (${error.code})`);
    return false;
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const paths = (entries) => entries.map((entry) => entry.path);

// ---------------------------------------------------------------------------
// The lists as data
// ---------------------------------------------------------------------------

test('the allowlist is exactly CLAUDE.md, rules/, skills/, skill-vault/ and the generated template', () => {
  assert.deepEqual(
    ALLOWLIST.map((entry) => `${entry.path}:${entry.kind}`),
    ['CLAUDE.md:file', 'rules:dir', 'skills:dir', 'skill-vault:dir', `${SETTINGS_TEMPLATE_FILE}:generated`],
  );
  assert.ok(Object.isFrozen(ALLOWLIST));
});

test('the denylist carries every required rule, each with a reason', () => {
  const required = [
    '.credentials.json', 'history.jsonl', 'projects/', 'sessions/', 'file-history/', 'paste-cache/',
    'shell-snapshots/', 'telemetry/', '*.log', 'daemon*', 'settings.json', 'settings.local.json',
    '.env*', 'node_modules/', '.git/', '*.pem', '*.key', 'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*',
  ];
  const patterns = DENYLIST.map((entry) => entry.pattern);
  for (const pattern of required) assert.ok(patterns.includes(pattern), `missing ${pattern}`);
  for (const entry of DENYLIST) assert.ok(entry.reason.length > 10, `${entry.pattern} has no reason`);
  assert.ok(Object.isFrozen(DENYLIST));
});

test('denylist resolution matches any segment, directory rules only on directories', () => {
  const cases = [
    ['.credentials.json', false, '.credentials.json'],
    ['skills/foo/.env', false, '.env*'],
    ['skills/foo/.env.local', false, '.env*'],
    ['skills/foo/.ENV', false, '.env*'],
    ['skills/x/node_modules', true, 'node_modules/'],
    ['skills/x/node_modules/pkg/index.js', false, 'node_modules/'],
    ['skills/x/.git', true, '.git/'],
    ['skills/projects/notes.md', false, 'projects/'],
    ['rules/debug.log', false, '*.log'],
    ['daemon', true, 'daemon*'],
    ['daemon.json', false, 'daemon*'],
    ['skills/ssh/id_ed25519', false, 'id_ed25519*'],
    ['skills/ssh/id_ed25519.pub', false, 'id_ed25519*'],
    ['skills/x/id_rsa', false, 'id_rsa*'],
    ['skills/x/id_rsa_work', false, 'id_rsa*'],
    ['skills/x/id_ecdsa_sk', false, 'id_ecdsa*'],
    ['skills/x/id_dsa', false, 'id_dsa*'],
    // daemon* is a top-level entry of ~/.claude only; id_ names only SSH keys.
    ['skills/daemon-tools/a.md', false, null],
    ['skills/daemon-helper/SKILL.md', false, null],
    ['skills/x/scripts/id_map.py', false, null],
    ['skills/x/id_rsa.md', false, 'id_rsa*'],
    ['skills/tls/server.pem', false, '*.pem'],
    ['skills/tls/server.key', false, '*.key'],
    ['skills/foo/settings.json', false, 'settings.json'],
    ['skills/foo/settings.local.json', false, 'settings.local.json'],
    ['skills/foo/history.jsonl', false, 'history.jsonl'],
    // A file merely named like a denylisted directory is not that directory.
    ['skills/foo/projects', false, null],
    ['skills/foo/projects.md', false, null],
    ['skills/tdd/SKILL.md', false, null],
    ['rules/common/coding-style.md', false, null],
    ['CLAUDE.md', false, null],
  ];
  for (const [relPath, isDirectory, expected] of cases) {
    assert.equal(denylistRule(relPath, { isDirectory }), expected, relPath);
  }
});

// ---------------------------------------------------------------------------
// planExport
// ---------------------------------------------------------------------------

test('planExport on a clean tree lists the allowlisted files, sized and hashed, in order', () => {
  const { root, cleanup } = scratch();
  try {
    const claudeDir = fakeClaudeDir(root);
    const plan = planExport(claudeDir);

    assert.deepEqual(paths(plan.files), FIXTURE_FILES);
    for (const file of plan.files) {
      const full = path.join(claudeDir, ...file.path.split('/'));
      assert.equal(file.size, fs.statSync(full).size);
      assert.equal(file.sha256, sha256(full));
    }
    assert.deepEqual(plan.refused, []);
    assert.deepEqual(plan.skipped, []);
    assert.deepEqual(plan.missing, []);
    assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.files) && Object.isFrozen(plan.files[0]));
  } finally {
    cleanup();
  }
});

test('planExport never walks outside the allowlist and refuses denylisted paths inside it', () => {
  const { root, cleanup } = scratch();
  try {
    const claudeDir = fakeClaudeDir(root);
    // Outside the allowlist: never even visited.
    write(claudeDir, '.credentials.json', '{"fake":true}');
    write(claudeDir, 'history.jsonl', '{}\n');
    write(claudeDir, 'projects/p/memory/MEMORY.md', '# memory');
    write(claudeDir, 'NEXT-SESSION.md', 'notes');
    // Inside the allowlist: refused, with the rule that refused each.
    write(claudeDir, 'skills/foo/.env', 'FAKE=1');
    write(claudeDir, 'skills/foo/SKILL.md', '# foo');
    write(claudeDir, 'skills/x/node_modules/pkg/index.js', 'module.exports = 1;');
    write(claudeDir, 'skills/x/SKILL.md', '# x');
    write(claudeDir, 'rules/debug.log', 'log');
    write(claudeDir, 'skills/ssh/id_rsa', 'fake');
    // Named like a hazard, but not one: exported.
    write(claudeDir, 'skills/x/scripts/id_map.py', 'ID_MAP = {}\n');
    write(claudeDir, 'skills/daemon-tools/a.md', '# daemon tools\n');

    const plan = planExport(claudeDir);

    assert.deepEqual(paths(plan.files), [
      'CLAUDE.md',
      'rules/common/coding-style.md',
      'skill-vault/languages/python/SKILL.md',
      'skills/daemon-tools/a.md',
      'skills/foo/SKILL.md',
      'skills/tdd/SKILL.md',
      'skills/x/SKILL.md',
      'skills/x/scripts/id_map.py',
    ]);
    assert.deepEqual(plan.refused, [
      { path: 'rules/debug.log', rule: '*.log' },
      { path: 'skills/foo/.env', rule: '.env*' },
      { path: 'skills/ssh/id_rsa', rule: 'id_rsa*' },
      { path: 'skills/x/node_modules', rule: 'node_modules/' },
    ]);
    for (const leaked of ['.credentials.json', 'history.jsonl', 'NEXT-SESSION.md', 'settings.json']) {
      assert.ok(!paths(plan.files).includes(leaked), leaked);
    }
  } finally {
    cleanup();
  }
});

test('planExport reports allowlisted entries that do not exist', () => {
  const { root, cleanup } = scratch();
  try {
    const claudeDir = fakeClaudeDir(root);
    fs.rmSync(path.join(claudeDir, 'skill-vault'), { recursive: true });
    const plan = planExport(claudeDir);
    assert.deepEqual(plan.missing, ['skill-vault']);
    assert.ok(!paths(plan.files).some((p) => p.startsWith('skill-vault/')));
  } finally {
    cleanup();
  }
});

test('planExport throws when the directory does not exist', () => {
  assert.throws(() => planExport(path.join(os.tmpdir(), 'no-such-claude-dir-xyz')), /not a directory/);
  assert.throws(() => planExport(''), TypeError);
});

test('a directory link inside an allowlisted folder is reported and not followed', (t) => {
  const { root, cleanup } = scratch();
  try {
    const claudeDir = fakeClaudeDir(root);
    const outside = path.join(root, 'outside');
    write(outside, 'secret.md', 'outside the tree');
    if (!linkDir(outside, path.join(claudeDir, 'skills', 'linked'), t)) return;

    const plan = planExport(claudeDir);
    assert.deepEqual(plan.skipped, [{ path: 'skills/linked', reason: 'symlink' }]);
    assert.ok(!paths(plan.files).some((p) => p.startsWith('skills/linked')));
  } finally {
    cleanup();
  }
});

test('an allowlisted root that is itself a link is reported and not followed', (t) => {
  const { root, cleanup } = scratch();
  try {
    const claudeDir = fakeClaudeDir(root);
    const outside = path.join(root, 'rules-elsewhere');
    write(outside, 'r.md', 'outside');
    fs.rmSync(path.join(claudeDir, 'rules'), { recursive: true });
    if (!linkDir(outside, path.join(claudeDir, 'rules'), t)) return;

    const plan = planExport(claudeDir);
    assert.deepEqual(plan.skipped, [{ path: 'rules', reason: 'symlink' }]);
    assert.ok(!paths(plan.files).some((p) => p.startsWith('rules/')));
  } finally {
    cleanup();
  }
});

test('a file symlink is reported and not followed', (t) => {
  const { root, cleanup } = scratch();
  try {
    const claudeDir = fakeClaudeDir(root);
    const target = write(root, 'outside.md', 'outside');
    try {
      fs.symlinkSync(target, path.join(claudeDir, 'skills', 'tdd', 'link.md'), 'file');
    } catch (error) {
      t.skip(`cannot create a file symlink here (${error.code})`);
      return;
    }
    const plan = planExport(claudeDir);
    assert.deepEqual(plan.skipped, [{ path: 'skills/tdd/link.md', reason: 'symlink' }]);
  } finally {
    cleanup();
  }
});

test('a file over the size cap is skipped and reported; one at the cap travels', () => {
  const { root, cleanup } = scratch();
  try {
    const claudeDir = fakeClaudeDir(root);
    write(claudeDir, 'skills/big/at-cap.md', Buffer.alloc(MAX_CONFIG_FILE_BYTES, 0x61));
    write(claudeDir, 'skills/big/over-cap.md', Buffer.alloc(MAX_CONFIG_FILE_BYTES + 1, 0x61));

    const plan = planExport(claudeDir);
    assert.ok(paths(plan.files).includes('skills/big/at-cap.md'));
    assert.ok(!paths(plan.files).includes('skills/big/over-cap.md'));
    assert.deepEqual(plan.skipped, [{ path: 'skills/big/over-cap.md', reason: 'size-cap' }]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// scanForSecrets
// ---------------------------------------------------------------------------

test('findSecretMatches names the rule and where, never the value', () => {
  const text = `line one\nconst t = "${FAKE_GITHUB_TOKEN}";\n`;
  const matches = findSecretMatches(text);
  assert.deepEqual(matches.map((m) => m.rule), ['github-token']);
  assert.equal(text.slice(matches[0].index).startsWith(FAKE_GITHUB_TOKEN), true);
  assert.ok(!JSON.stringify(matches).includes(FAKE_GITHUB_TOKEN));
});

test('findSecretMatches ignores placeholders and references, as the capture hook does', () => {
  assert.deepEqual(findSecretMatches('API_KEY=your-key\nTOKEN=$GITHUB_TOKEN\npassword: changeme'), []);
  assert.deepEqual(findSecretMatches(''), []);
  assert.deepEqual(findSecretMatches(null), []);
});

test('findSecretMatches: a rule that throws is a finding named <rule>:error, so the gate fails closed', () => {
  const throwsOnMatch = { name: 'throws-on-match', re: /t/g, secret: () => { throw new Error('rule bug'); } };
  const notGlobal = { name: 'not-global', re: /t/ }; // matchAll itself throws on a non-global pattern
  const text = `line one\npasted ${FAKE_GITHUB_TOKEN}\n`;
  const matches = findSecretMatches(text, [throwsOnMatch, ...SECRET_RULES, notGlobal]);
  assert.deepEqual(matches.map((m) => m.rule), ['throws-on-match:error', 'github-token', 'not-global:error']);
  assert.ok(!JSON.stringify(matches).includes(FAKE_GITHUB_TOKEN));
  // The capture hook's redaction still skips a bad rule rather than lose the note.
  assert.equal(redact(`x ${FAKE_GITHUB_TOKEN}`), 'x [REDACTED-KEY]');
});

test('findSecretMatches reads PAT as a word, not the letters inside path, pattern or dispatch', () => {
  const value = 'ValueLongEnough123';
  const lines = [
    `output_path = "${value}"`,
    `template_pattern = "${value}"`,
    `dispatch=${value}`,
    `PATH=${value}`,
    `compatibility: ${value}`,
    `GITHUB_PAT=${value}`,
    `githubPat: '${value}'`,
    `pat_value=${value}`,
    `relative_path_token=${value}`,
  ];
  const text = lines.join('\n');
  const hitLines = findSecretMatches(text).map((m) => text.slice(0, m.index).split('\n').length);
  assert.deepEqual(hitLines, [6, 7, 8, 9]);
});

test('redaction reads PAT as a word too, the same as the scan', () => {
  // Redacting `output_path = …` blanked file paths out of notes (bb2dash PR #48 review).
  assert.equal(redact('output_path = "ValueLongEnough123"'), 'output_path = "ValueLongEnough123"');
  assert.equal(redact('GITHUB_PAT = "ValueLongEnough123"'), 'GITHUB_PAT = [REDACTED]');
});

test('a clean export scans clean', () => {
  const { root, cleanup } = scratch();
  try {
    const verdict = scanForSecrets(planExport(fakeClaudeDir(root)).files);
    assert.equal(verdict.clean, true);
    assert.deepEqual(verdict.findings, []);
  } finally {
    cleanup();
  }
});

test('a planted fake key in a skill file is found, by path, rule and line, and refuses', () => {
  const { root, cleanup } = scratch();
  try {
    const claudeDir = fakeClaudeDir(root);
    write(claudeDir, 'skills/leaky/SKILL.md', `# leaky\n\nuse ${FAKE_GITHUB_TOKEN} to push\n`);

    const verdict = scanForSecrets(planExport(claudeDir).files);
    assert.equal(verdict.clean, false);
    assert.deepEqual(verdict.findings, [{ path: 'skills/leaky/SKILL.md', rule: 'github-token', line: 3 }]);
    assert.ok(!JSON.stringify(verdict).includes(FAKE_GITHUB_TOKEN), 'the finding must not carry the secret');
    assert.ok(Object.isFrozen(verdict) && Object.isFrozen(verdict.findings));
  } finally {
    cleanup();
  }
});

test('a key inside a binary file is still found: binaries are scanned as bytes, not skipped', () => {
  const { root, cleanup } = scratch();
  try {
    const claudeDir = fakeClaudeDir(root);
    const bytes = Buffer.concat([Buffer.from([0, 1, 2, 0xff, 0]), Buffer.from(FAKE_GITHUB_TOKEN), Buffer.from([0, 0xfe])]);
    write(claudeDir, 'skills/bin/blob.dat', bytes);

    const verdict = scanForSecrets(planExport(claudeDir).files);
    assert.deepEqual(verdict.findings, [{ path: 'skills/bin/blob.dat', rule: 'github-token', line: 1 }]);
  } finally {
    cleanup();
  }
});

test('a key in a UTF-16 file is found: LE or BE, with a BOM or without, on disk or in memory', () => {
  const { root, cleanup } = scratch();
  try {
    const text = `# notes\r\n\r\nuse ${FAKE_GITHUB_TOKEN} to push\r\n`;
    const le = Buffer.from(text, 'utf16le');
    const be = Buffer.from(le).swap16();
    const bom = (bytes, mark) => Buffer.concat([Buffer.from(mark), bytes]);
    const files = [
      { path: 'skills/u/utf8.md', bytes: Buffer.from(text, 'utf8') },
      { path: 'skills/u/le-bom.md', bytes: bom(le, [0xff, 0xfe]) },
      { path: 'skills/u/be-bom.md', bytes: bom(be, [0xfe, 0xff]) },
      { path: 'skills/u/le-plain.md', bytes: le },
      { path: 'skills/u/be-plain.md', bytes: be },
    ];
    for (const file of files) write(root, file.path, file.bytes);

    const onDisk = scanForSecrets(files.map((file) => ({ path: file.path, source: path.join(root, ...file.path.split('/')) })));
    const inMemory = scanForSecrets(files.map((file) => ({ path: file.path, content: file.bytes })));
    for (const verdict of [onDisk, inMemory]) {
      assert.deepEqual(
        verdict.findings,
        files.map((file) => ({ path: file.path, rule: 'github-token', line: 3 })).sort((a, b) => (a.path < b.path ? -1 : 1)),
      );
    }
  } finally {
    cleanup();
  }
});

test('in-memory content is scanned too, so the rendered template can be checked before commit', () => {
  const template = JSON.stringify({ permissions: { allow: [`Bash(curl -H "Authorization: Bearer ${'x'.repeat(24)}")`] } });
  const verdict = scanForSecrets([{ path: SETTINGS_TEMPLATE_FILE, content: template }]);
  assert.equal(verdict.clean, false);
  assert.deepEqual(verdict.findings.map((f) => f.rule), ['bearer-header']);
});

test('a file that cannot be read is a finding, not a pass', () => {
  const verdict = scanForSecrets([{ path: 'skills/gone.md', source: path.join(os.tmpdir(), 'no-such-file-xyz.md') }]);
  assert.equal(verdict.clean, false);
  assert.deepEqual(verdict.findings, [{ path: 'skills/gone.md', rule: 'unreadable', line: 0 }]);
});

test('scanForSecrets rejects input that is not a list', () => {
  assert.throws(() => scanForSecrets('skills'), TypeError);
});

// ---------------------------------------------------------------------------
// Settings template
// ---------------------------------------------------------------------------

const FIXTURE_SETTINGS = JSON.parse(fs.readFileSync(path.join(FIXTURE_HOME, 'settings.json'), 'utf8'));
const FIXTURE_USER_HOME = 'C:\\Users\\fixture';

test('the template keeps only hooks and permissions, with home paths as a forward-slash placeholder', () => {
  const template = buildSettingsTemplate(FIXTURE_SETTINGS, { home: FIXTURE_USER_HOME });

  assert.deepEqual(Object.keys(template).sort(), ['hooks', 'permissions']);
  assert.deepEqual(template.permissions.allow, [`Read(${HOME_PLACEHOLDER}/notes/**)`, 'Bash(git status)']);
  assert.equal(
    template.hooks.SessionEnd[0].hooks[0].command,
    `"C:/Program Files/nodejs/node.exe" "${HOME_PLACEHOLDER}/.claude/hooks/session-capture.mjs"`,
  );
  const text = JSON.stringify(template);
  for (const gone of ['fixture-model', 'key-helper', 'FIXTURE_ONLY', 'mcpServers', 'Users/fixture', 'Users\\\\fixture']) {
    assert.ok(!text.includes(gone), `${gone} survived`);
  }
});

test('the template does not mutate its input', () => {
  const before = JSON.stringify(FIXTURE_SETTINGS);
  buildSettingsTemplate(FIXTURE_SETTINGS, { home: FIXTURE_USER_HOME });
  assert.equal(JSON.stringify(FIXTURE_SETTINGS), before);
});

test('home replacement covers every spelling and stops at a path boundary', () => {
  const settings = {
    permissions: {
      allow: [
        'Read(c:/users/FIXTURE/a/b)',
        'Read(/c/Users/fixture/msys)',
        'Read(C:\\Users\\fixture)',
        'Read(C:\\Users\\fixturex\\other)',
        'Read(D:\\Users\\fixture\\other-drive)',
      ],
    },
  };
  const template = buildSettingsTemplate(settings, { home: 'C:/Users/fixture' });
  assert.deepEqual(template.permissions.allow, [
    `Read(${HOME_PLACEHOLDER}/a/b)`,
    `Read(${HOME_PLACEHOLDER}/msys)`,
    `Read(${HOME_PLACEHOLDER})`,
    'Read(C:\\Users\\fixturex\\other)',
    'Read(D:\\Users\\fixture\\other-drive)',
  ]);
});

test('settings without hooks or permissions give an empty template; bad input throws', () => {
  assert.deepEqual(buildSettingsTemplate({ model: 'x' }, { home: FIXTURE_USER_HOME }), {});
  assert.throws(() => buildSettingsTemplate(null, { home: FIXTURE_USER_HOME }), TypeError);
  assert.throws(() => buildSettingsTemplate([], { home: FIXTURE_USER_HOME }), TypeError);
  assert.throws(() => buildSettingsTemplate({}, {}), TypeError);
  assert.throws(() => buildSettingsTemplate({ hooks: 'nope' }, { home: FIXTURE_USER_HOME }), TypeError);
});

test('render puts the target home in, forward slashes', () => {
  const template = buildSettingsTemplate(FIXTURE_SETTINGS, { home: FIXTURE_USER_HOME });
  const rendered = renderSettingsTemplate(template, { home: 'D:\\Profiles\\other' });
  assert.deepEqual(rendered.permissions.allow, ['Read(D:/Profiles/other/notes/**)', 'Bash(git status)']);
  assert.ok(!JSON.stringify(rendered).includes(HOME_PLACEHOLDER));
});

test('round trip: render(build(s)) gives back hooks and permissions; build(render(t)) gives back t', () => {
  const home = 'C:/Users/fixture';
  const template = buildSettingsTemplate(FIXTURE_SETTINGS, { home: FIXTURE_USER_HOME });
  const rendered = renderSettingsTemplate(template, { home });

  assert.deepEqual(rendered.hooks, FIXTURE_SETTINGS.hooks);
  assert.deepEqual(rendered.permissions, {
    ...FIXTURE_SETTINGS.permissions,
    allow: ['Read(C:/Users/fixture/notes/**)', 'Bash(git status)'],
  });
  assert.deepEqual(buildSettingsTemplate(rendered, { home }), template);
  // Round trip through a different machine's home, too.
  const elsewhere = renderSettingsTemplate(template, { home: '/home/stack' });
  assert.deepEqual(buildSettingsTemplate(elsewhere, { home: '/home/stack' }), template);
});

test('render keeps only hooks and permissions, even from a tampered template', () => {
  const tampered = { hooks: {}, permissions: { allow: [] }, apiKeyHelper: 'evil.cmd', env: { X: '1' } };
  assert.deepEqual(Object.keys(renderSettingsTemplate(tampered, { home: '/h' })).sort(), ['hooks', 'permissions']);
  assert.throws(() => renderSettingsTemplate(null, { home: '/h' }), TypeError);
  assert.throws(() => renderSettingsTemplate({}, { home: '' }), TypeError);
});

// ---------------------------------------------------------------------------
// planInstall
// ---------------------------------------------------------------------------

/** A clone of the config repo, built from the fixture, with the template beside it. */
function fakeConfigRepo(root) {
  const repo = path.join(root, 'claude-config');
  for (const rel of FIXTURE_FILES) {
    write(repo, rel, fs.readFileSync(path.join(FIXTURE_HOME, ...rel.split('/'))));
  }
  const template = buildSettingsTemplate(FIXTURE_SETTINGS, { home: FIXTURE_USER_HOME });
  write(repo, SETTINGS_TEMPLATE_FILE, `${JSON.stringify(template, null, 2)}\n`);
  write(repo, 'README.md', '# claude-config');
  write(repo, '.git/HEAD', 'ref: refs/heads/main\n');
  return repo;
}

test('planInstall sorts every file into new, changed or unchanged and renders the template', () => {
  const { root, cleanup } = scratch();
  try {
    const repo = fakeConfigRepo(root);
    const claudeDir = path.join(root, 'home', '.claude');
    write(claudeDir, 'CLAUDE.md', fs.readFileSync(path.join(FIXTURE_HOME, 'CLAUDE.md')));
    write(claudeDir, 'rules/common/coding-style.md', 'an older version');

    const plan = planInstall(repo, claudeDir, { home: path.join(root, 'home') });

    assert.deepEqual(
      plan.files.map((f) => `${f.path}:${f.status}`),
      [
        'CLAUDE.md:unchanged',
        'rules/common/coding-style.md:changed',
        'skill-vault/languages/python/SKILL.md:new',
        'skills/tdd/SKILL.md:new',
      ],
    );
    assert.equal(plan.files[1].target, path.join(claudeDir, 'rules', 'common', 'coding-style.md'));
    assert.deepEqual(plan.ignored, ['README.md']);
    assert.deepEqual(plan.refused, []);
    const homePosix = path.join(root, 'home').replace(/\\/g, '/');
    assert.deepEqual(plan.settingsTemplate.permissions.allow, [`Read(${homePosix}/notes/**)`, 'Bash(git status)']);
    assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.files));
  } finally {
    cleanup();
  }
});

test('planInstall refuses a denylisted path a tampered repo slipped into an allowlisted folder', () => {
  const { root, cleanup } = scratch();
  try {
    const repo = fakeConfigRepo(root);
    write(repo, 'skills/evil/.credentials.json', '{"fake":true}');
    write(repo, 'skills/evil/settings.json', '{"apiKeyHelper":"x"}');
    write(repo, 'rules/projects/x.md', 'x');
    const claudeDir = path.join(root, 'home', '.claude');

    const plan = planInstall(repo, claudeDir, { home: path.join(root, 'home') });
    assert.deepEqual(plan.refused, [
      { path: 'rules/projects', rule: 'projects/' },
      { path: 'skills/evil/.credentials.json', rule: '.credentials.json' },
      { path: 'skills/evil/settings.json', rule: 'settings.json' },
    ]);
    assert.ok(!paths(plan.files).some((p) => p.startsWith('skills/evil') || p.startsWith('rules/projects')));
  } finally {
    cleanup();
  }
});

test('planInstall blocks a write that would pass through a link in the target', (t) => {
  const { root, cleanup } = scratch();
  try {
    const repo = fakeConfigRepo(root);
    const claudeDir = path.join(root, 'home', '.claude');
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });
    if (!linkDir(elsewhere, path.join(claudeDir, 'skills', 'tdd'), t)) return;

    const plan = planInstall(repo, claudeDir, { home: path.join(root, 'home') });
    const tdd = plan.files.find((f) => f.path === 'skills/tdd/SKILL.md');
    assert.equal(tdd.status, 'blocked');
    assert.equal(tdd.reason, 'target-symlink');
  } finally {
    cleanup();
  }
});

test('planInstall without a template says so, and a malformed template throws', () => {
  const { root, cleanup } = scratch();
  try {
    const repo = fakeConfigRepo(root);
    const claudeDir = path.join(root, 'home', '.claude');
    fs.rmSync(path.join(repo, SETTINGS_TEMPLATE_FILE));
    assert.equal(planInstall(repo, claudeDir, { home: root }).settingsTemplate, null);

    write(repo, SETTINGS_TEMPLATE_FILE, '{ not json');
    assert.throws(() => planInstall(repo, claudeDir, { home: root }), /settings\.template\.json/);
  } finally {
    cleanup();
  }
});
