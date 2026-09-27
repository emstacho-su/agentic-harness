/**
 * The one-shot hub rename (R-N1), end to end against a scratch vault.
 *
 * The fixture carries every shape the live vault has: hook-written session
 * notes, a Python-written materials note, a worker linking to its parent by
 * UUID, a CRLF note, a note the parser refuses, a collection whose `<c>.md`
 * already exists, and a link to a collection that has no hub at all.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runGitSync } from '../lib/git-log.mjs';
import { checkUpLinks, renameHubs, rewriteUpLines } from '../lib/rename-hubs.mjs';

const SCRIPT = fileURLToPath(new URL('../rename-hubs.mjs', import.meta.url));

const PARENT = '11111111-1111-4111-8111-111111111111';
const WORKER = `${PARENT}--a0283f0fe443b2b69`;
const CLASS_SESSION = '22222222-2222-4222-8222-222222222222';

const hub = (id, collection) =>
  ['---', `id: '${id}'`, `title: '${collection}'`, `collection: '${collection}'`, 'type: index', '---', '', `# ${collection}`, ''].join('\n');

const session = (stem, up, extra = []) =>
  ['---', `id: 'session-${stem}'`, 'type: session', "collection: 'bb2dash'", ...extra, `up: ${up}`, 'related: []', '---', '', `# ${stem}`, ''].join('\n');

/** vault-relative path → contents. */
const FIXTURE = Object.freeze({
  'projects/bb2dash/index.md': hub('aaaaaaaa-0000-4000-8000-000000000001', 'bb2dash'),
  [`projects/bb2dash/sessions/${PARENT}.md`]: `${session(PARENT, "'[[projects/bb2dash/index|bb2dash]]'")}\nSee [[projects/bb2dash/index]] and the index page.\n`,
  [`projects/bb2dash/sessions/${WORKER}.md`]: session(WORKER, `'[[${PARENT}]]'`, [`parent_session: '${PARENT}'`]),
  'projects/bb2dash/sessions/crlf.md': session('crlf', "'[[projects/bb2dash/index|bb2dash]]'").replace(/\n/g, '\r\n'),
  'projects/bb2dash/sessions/broken.md': "---\nid: 'unterminated\nup: '[[projects/bb2dash/index|bb2dash]]'\n---\n",
  'projects/bb2dash/notes/no-alias.md': ['---', 'title: plain', 'up: "[[projects/bb2dash/index]]"', '---', 'body', ''].join('\n'),
  'projects/clash/index.md': hub('aaaaaaaa-0000-4000-8000-000000000002', 'clash'),
  'projects/clash/clash.md': ['---', "title: 'a note that happens to share the name'", '---', ''].join('\n'),
  'projects/clash/sessions/s.md': session('s', "'[[projects/clash/index|clash]]'"),
  'projects/misc/sessions/orphan.md': session('orphan', "'[[projects/misc/index|misc]]'"),
  'classes/ist323/index.md': hub('aaaaaaaa-0000-4000-8000-000000000003', 'ist323'),
  'classes/ist323/materials/week-3.md': [
    '---',
    'collection: ist323',
    'id: 5a1c0d2e-3f40-4a5b-8c6d-7e8f90a1b2c3',
    'ingest: false',
    "title: 'Week 3: Networks'",
    'type: material',
    "up: '[[classes/ist323/index|ist323]]'",
    'week: 3',
    '---',
    '',
    '# Week 3',
    '',
  ].join('\n'),
  [`classes/ist323/sessions/${CLASS_SESSION}.md`]: session(CLASS_SESSION, "'[[classes/ist323/index|Stack''s class]]'"),
});

/** note → the one line the apply must change in it, [before, after]. */
const EXPECTED_REWRITES = Object.freeze({
  [`projects/bb2dash/sessions/${PARENT}.md`]: ["up: '[[projects/bb2dash/index|bb2dash]]'", "up: '[[projects/bb2dash/bb2dash|bb2dash]]'"],
  'projects/bb2dash/sessions/crlf.md': ["up: '[[projects/bb2dash/index|bb2dash]]'\r\n", "up: '[[projects/bb2dash/bb2dash|bb2dash]]'\r\n"],
  'projects/bb2dash/notes/no-alias.md': ['up: "[[projects/bb2dash/index]]"', 'up: "[[projects/bb2dash/bb2dash|bb2dash]]"'],
  'classes/ist323/materials/week-3.md': ["up: '[[classes/ist323/index|ist323]]'", "up: '[[classes/ist323/ist323|ist323]]'"],
  [`classes/ist323/sessions/${CLASS_SESSION}.md`]: [
    "up: '[[classes/ist323/index|Stack''s class]]'",
    "up: '[[classes/ist323/ist323|Stack''s class]]'",
  ],
});

const EXPECTED_MOVES = Object.freeze({
  'projects/bb2dash/index.md': 'projects/bb2dash/bb2dash.md',
  'classes/ist323/index.md': 'classes/ist323/ist323.md',
});

function scratchVault(t, files = FIXTURE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-hubs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(vault, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  }
  return { root, vault };
}

/** vault-relative path → sha256 of every file outside `.git`. */
function hashTree(vault) {
  const hashes = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hashes[path.relative(vault, full).split(path.sep).join('/')] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(vault);
  return hashes;
}

const read = (vault, rel) => fs.readFileSync(path.join(vault, rel), 'utf8');

test('rewriteUpLines edits only the up line, keeps quoting, alias and CRLF', () => {
  const targets = new Set(['projects/bb2dash']);
  const raw = "---\r\nid: 'x'\r\nup: '[[projects/bb2dash/index|B''s]]'\r\n---\r\nup: '[[projects/bb2dash/index|b]]'\r\n";
  const result = rewriteUpLines(raw, targets);
  assert.equal(result.text, raw.replace("up: '[[projects/bb2dash/index|B''s]]'", "up: '[[projects/bb2dash/bb2dash|B''s]]'"));
  assert.equal(result.changes.length, 1);

  assert.equal(rewriteUpLines('---\nup: [[projects/bb2dash/index]]\n---\n', targets).text, '---\nup: [[projects/bb2dash/bb2dash|bb2dash]]\n---\n');
  assert.equal(rewriteUpLines("---\nup: '[[projects/other/index|o]]'\n---\n", targets).changes.length, 0, 'not a target');
  assert.equal(rewriteUpLines(`---\nup: '[[${PARENT}]]'\n---\n`, targets).changes.length, 0, 'a UUID link');
  assert.equal(rewriteUpLines("---\n  up: '[[projects/bb2dash/index|b]]'\n---\n", targets).changes.length, 0, 'indented');
  assert.equal(rewriteUpLines("---\nup: '[[projects/bb2dash/index|b]]\n---\n", targets).changes.length, 0, 'unbalanced quote');
});

test('a dry run reports the plan and writes nothing', (t) => {
  const { vault } = scratchVault(t);
  const before = hashTree(vault);

  const report = renameHubs({ vault, apply: false });

  assert.deepEqual(hashTree(vault), before);
  assert.deepEqual(Object.fromEntries(report.moves.map((m) => [m.from, m.to])), EXPECTED_MOVES);
  assert.ok(report.moves.every((m) => m.method === 'rename'), 'no git in this fixture');
  assert.deepEqual(report.rewrites.map((r) => r.path).sort(), Object.keys(EXPECTED_REWRITES).sort());
  assert.deepEqual(report.refused.map((r) => r.path), ['projects/clash/index.md']);
  assert.deepEqual(report.unreadable.map((r) => r.path), ['projects/bb2dash/sessions/broken.md']);
});

test('apply moves the hubs byte for byte and rewrites exactly the expected lines', (t) => {
  const { vault } = scratchVault(t);
  const before = hashTree(vault);

  const report = renameHubs({ vault, apply: true });
  const after = hashTree(vault);

  assert.equal(report.moves.length, 2);
  for (const [from, to] of Object.entries(EXPECTED_MOVES)) {
    assert.equal(after[from], undefined, `${from} is gone`);
    assert.equal(after[to], before[from], `${to} is the old hub, unchanged`);
  }
  for (const [rel, [oldLine, newLine]] of Object.entries(EXPECTED_REWRITES)) {
    assert.equal(read(vault, rel), FIXTURE[rel].replace(oldLine, newLine), rel);
  }
  const touched = new Set([...Object.keys(EXPECTED_MOVES), ...Object.values(EXPECTED_MOVES), ...Object.keys(EXPECTED_REWRITES)]);
  for (const rel of Object.keys(before)) {
    if (!touched.has(rel)) assert.equal(after[rel], before[rel], `${rel} is untouched`);
  }
  // The body mention of the hub stays as it was: links in the body are the author's.
  assert.match(read(vault, `projects/bb2dash/sessions/${PARENT}.md`), /See \[\[projects\/bb2dash\/index\]\] and the index page\./);
  assert.ok(fs.existsSync(path.join(vault, 'projects/clash/index.md')), 'the collision is left in place');
});

test('a second apply, and a dry run after it, change nothing', (t) => {
  const { vault } = scratchVault(t);
  renameHubs({ vault, apply: true });
  const settled = hashTree(vault);

  const again = renameHubs({ vault, apply: true });
  const dry = renameHubs({ vault, apply: false });

  assert.deepEqual(hashTree(vault), settled);
  for (const report of [again, dry]) {
    assert.equal(report.moves.length, 0);
    assert.equal(report.rewrites.length, 0);
  }
});

test('a hub already moved by hand still gets its links rewritten', (t) => {
  const { vault } = scratchVault(t);
  fs.renameSync(path.join(vault, 'projects/bb2dash/index.md'), path.join(vault, 'projects/bb2dash/bb2dash.md'));

  const report = renameHubs({ vault, apply: true });

  assert.deepEqual(report.moves.map((m) => m.from), ['classes/ist323/index.md']);
  assert.deepEqual(report.rewrites.map((r) => r.path).sort(), Object.keys(EXPECTED_REWRITES).sort());
});

test('check is clean after apply except for the link to a collection with no hub', (t) => {
  const { vault } = scratchVault(t);
  renameHubs({ vault, apply: true });

  const check = checkUpLinks({ vault });

  // The collision's links still name `clash/index.md`, which is still there.
  assert.deepEqual(check.broken.map((b) => [b.path, b.value]), [['projects/misc/sessions/orphan.md', '[[projects/misc/index|misc]]']]);
  assert.deepEqual(check.unreadable.map((u) => u.path), ['projects/bb2dash/sessions/broken.md']);
});

test('check: a worker link to a parent not captured yet is pending, not broken (bare UUID)', (t) => {
  const { vault } = scratchVault(t, {
    'projects/a/a.md': hub('aaaaaaaa-0000-4000-8000-000000000004', 'a'),
    [`projects/a/sessions/${PARENT}.md`]: session(PARENT, "'[[projects/a/a|a]]'"),
    [`projects/a/sessions/${WORKER}.md`]: session(WORKER, `'[[${PARENT}]]'`),
    'projects/a/sessions/w1.md': session('w1', `'[[${CLASS_SESSION}]]'`),
    'projects/a/sessions/w2.md': session('w2', `'[[${CLASS_SESSION}]]'`),
    'projects/a/sessions/stray.md': session('stray', "'[[nosuch]]'"),
  });

  const check = checkUpLinks({ vault });

  // A bare stem that is not a UUID names a hub or a note, and is judged.
  assert.deepEqual(check.broken.map((b) => b.path), ['projects/a/sessions/stray.md']);
  assert.deepEqual(check.pending.map((p) => [p.path, p.parent]), [
    ['projects/a/sessions/w1.md', CLASS_SESSION],
    ['projects/a/sessions/w2.md', CLASS_SESSION],
  ]);
  assert.deepEqual(check.pendingByParent, [{ parent: CLASS_SESSION, count: 2 }]);
});

test('check: a path-qualified sessions/ link to a missing parent is pending, not broken', (t) => {
  const { vault } = scratchVault(t, {
    'projects/a/a.md': hub('aaaaaaaa-0000-4000-8000-000000000004', 'a'),
    [`projects/a/sessions/${PARENT}.md`]: session(PARENT, "'[[projects/a/a|a]]'"),
    [`projects/a/sessions/${WORKER}.md`]: session(WORKER, `'[[projects/a/sessions/${PARENT}|parent]]'`),
    'projects/a/sessions/w.md': session('w', `'[[projects/a/sessions/${CLASS_SESSION}|2026-09-24 · a · later]]'`),
  });

  const check = checkUpLinks({ vault });

  assert.deepEqual(check.broken, []);
  assert.deepEqual(check.pending.map((p) => [p.path, p.parent]), [['projects/a/sessions/w.md', CLASS_SESSION]]);
  assert.equal(check.checked, 3, "the hub has no up link; the three notes do");
});

function gitScratch(t) {
  const { root, vault } = scratchVault(t, {
    'projects/bb2dash/index.md': FIXTURE['projects/bb2dash/index.md'],
    [`projects/bb2dash/sessions/${PARENT}.md`]: FIXTURE[`projects/bb2dash/sessions/${PARENT}.md`],
    [`projects/bb2dash/sessions/${WORKER}.md`]: FIXTURE[`projects/bb2dash/sessions/${WORKER}.md`],
  });
  const realm = path.join(vault, 'projects');
  const globalConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  // Keep the user's ~/.gitconfig (autocrlf, signing, hooks) out of the fixture.
  const isolation = Object.freeze({ GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' });
  const git = (...args) =>
    execFileSync('git', ['-C', realm, ...args], { encoding: 'utf8', env: { ...process.env, ...isolation }, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.name', 'fixture');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('commit', '--quiet', '-m', 'fixture');
  const runGit = (args, options) => runGitSync(args, { ...options, env: { ...(options?.env ?? {}), ...isolation } });
  return { vault, realm, git, runGit };
}

test('real git: the hub move is a git mv, and status shows the rename and the rewrite only', (t) => {
  const { vault, git, runGit } = gitScratch(t);
  // A hub the realm has never committed cannot be `git mv`ed; it is renamed.
  fs.mkdirSync(path.join(vault, 'projects/fresh'));
  fs.writeFileSync(path.join(vault, 'projects/fresh/index.md'), hub('aaaaaaaa-0000-4000-8000-000000000005', 'fresh'));

  const dry = renameHubs({ vault, apply: false, runGit });
  assert.deepEqual(dry.moves.map((m) => [m.from, m.method]), [
    ['projects/bb2dash/index.md', 'git mv'],
    ['projects/fresh/index.md', 'rename'],
  ]);
  assert.equal(git('status', '--porcelain'), '?? fresh/\n', 'the dry run changed nothing git can see');

  const report = renameHubs({ vault, apply: true, runGit });

  assert.deepEqual(report.moves.map((m) => m.from), ['projects/bb2dash/index.md', 'projects/fresh/index.md']);
  const status = git('status', '--porcelain').split('\n').filter(Boolean).sort();
  assert.deepEqual(status, [`R  bb2dash/index.md -> bb2dash/bb2dash.md`, ` M bb2dash/sessions/${PARENT}.md`, '?? fresh/'].sort());
  assert.ok(fs.existsSync(path.join(vault, 'projects/fresh/fresh.md')));
});

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, HARNESS_VAULT: '' } });
}

test('cli: no mode, or two modes, is a usage error', () => {
  for (const args of [[], ['--dry-run', '--apply'], ['--check', '--dry-run'], ['--bogus']]) {
    const result = runCli(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /usage: node hooks\/rename-hubs\.mjs/);
  }
});

test('cli: a dry run prints moves, rewrites and totals, and exits 2 on a refusal', (t) => {
  const { vault } = scratchVault(t);
  const before = hashTree(vault);

  const result = runCli(['--dry-run', '--vault', vault]);

  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(hashTree(vault), before);
  assert.match(result.stdout, /^projects\/bb2dash\/index\.md -> projects\/bb2dash\/bb2dash\.md \(rename\)$/m);
  assert.match(result.stdout, /^classes\/ist323\/materials\/week-3\.md: up: '\[\[classes\/ist323\/index\|ist323\]\]' -> '\[\[classes\/ist323\/ist323\|ist323\]\]'$/m);
  assert.match(result.stdout, /^refused: projects\/clash\/index\.md: projects\/clash\/clash\.md already exists$/m);
  assert.match(result.stdout, /^moves: 2, rewrites: 5, refused: 1, unreadable: 1$/m);
});

test('cli: apply without a refusal exits 0, and check then exits 0', (t) => {
  const files = Object.fromEntries(Object.entries(FIXTURE).filter(([rel]) => !/clash|misc|broken/.test(rel)));
  const { vault } = scratchVault(t, files);

  const applied = runCli(['--apply', '--vault', vault]);
  const check = runCli(['--check', '--vault', vault]);

  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /^projects\/bb2dash\/index\.md -> projects\/bb2dash\/bb2dash\.md: moved \(rename\)$/m);
  assert.equal(check.status, 0, check.stdout);
  assert.match(check.stdout, /^broken hub links: 0$/m);
  assert.match(check.stdout, /^pending worker links: 0 \(parent session not captured yet\)$/m);
});

test('cli: check exits 2 and names the offender', (t) => {
  const { vault } = scratchVault(t);
  const result = runCli(['--check', '--vault', vault]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^projects\/misc\/sessions\/orphan\.md: up: \[\[projects\/misc\/index\|misc\]\]$/m);
  assert.match(result.stdout, /^broken hub links: 1$/m);
});

test('cli: pending worker links alone exit 0, with a tally of their parents', (t) => {
  const { vault } = scratchVault(t, {
    'projects/a/a.md': hub('aaaaaaaa-0000-4000-8000-000000000004', 'a'),
    'projects/a/sessions/w1.md': session('w1', `'[[${PARENT}]]'`),
    'projects/a/sessions/w2.md': session('w2', `'[[projects/a/sessions/${PARENT}|parent]]'`),
    'projects/a/sessions/w3.md': session('w3', `'[[${CLASS_SESSION}]]'`),
  });

  const result = runCli(['--check', '--vault', vault]);

  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^broken hub links: 0$/m);
  assert.match(result.stdout, /^pending worker links: 3 \(parent session not captured yet\)$/m);
  assert.match(result.stdout, new RegExp(`^  ${PARENT}: 2 workers\n  ${CLASS_SESSION}: 1 workers$`, 'm'));
});

test('a hub whose move fails keeps its links: nothing points at a hub that is not there', (t) => {
  const { vault } = scratchVault(t);
  const before = hashTree(vault);
  const runGit = (args) => {
    if (args[0] === 'rev-parse') return { ok: true, stdout: 'true\n' };
    if (args[0] === 'ls-files') return { ok: true, stdout: '' };
    return { ok: false, stdout: '', error: 'exit 128', stderr: 'fatal: boom' };
  };

  const report = renameHubs({ vault, apply: true, runGit });

  assert.deepEqual(hashTree(vault), before);
  assert.equal(report.moves.length, 0);
  assert.equal(report.rewrites.length, 0);
  assert.ok(report.refused.some((r) => r.path === 'projects/bb2dash/index.md' && /git mv failed \(exit 128: fatal: boom\)/.test(r.error)));
  assert.ok(report.refused.some((r) => r.path === 'classes/ist323/materials/week-3.md' && /hub move failed/.test(r.error)));
});

test('a realm that cannot be listed is reported, not taken for an empty one (review #10)', (t) => {
  const { vault } = scratchVault(t);
  fs.rmSync(path.join(vault, 'classes'), { recursive: true, force: true });
  fs.writeFileSync(path.join(vault, 'classes'), 'not a folder', 'utf8');

  const report = renameHubs({ vault, apply: false });
  assert.ok(report.unreadable.some((entry) => entry.path === 'classes'), JSON.stringify(report.unreadable));
  assert.ok(checkUpLinks({ vault }).unreadable.some((entry) => entry.path === 'classes'));
});

test('a realm that is simply absent is not an error', (t) => {
  const { vault } = scratchVault(t);
  fs.rmSync(path.join(vault, 'classes'), { recursive: true, force: true });
  assert.ok(!renameHubs({ vault, apply: false }).unreadable.some((entry) => entry.path === 'classes'));
});
