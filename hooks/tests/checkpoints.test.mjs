/**
 * The checkpoint collector: notes come out of git, get validated and redacted,
 * and land in the vault under a folder the vault already has.
 *
 * The fixture is real git: a bare "origin" with two branches each carrying a
 * note, and a clone the collector fetches from, exactly as the nightly job
 * sees a repository after a cloud session pushed.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { EXIT_OK, EXIT_PROBLEMS, EXIT_USAGE, LOG_ENV_VAR, parseArgs } from '../collect-checkpoints.mjs';
import { fileNote, gatherNotes, resolvePlacement, runCollect, validateNote } from '../lib/checkpoints.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';
import { createSandbox } from './helpers/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'collect-checkpoints.mjs');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A checkpoint note as the skill writes it. */
function note({ sessionId, collection, source = 'argument', capturedBy = 'skill', body = '## What I asked for\n1. Do the thing.\n\n## What was done\n- Done.\n\n## Decisions\n- none\n\n## Open questions / next steps\n- none\n', extra = '' }) {
  return [
    '---',
    `id: 'session-${sessionId}'`,
    `title: 'Session 2026-09-16 — ${collection}'`,
    'type: session',
    'schema_version: 2',
    `collection: '${collection}'`,
    `collection_source: '${source}'`,
    `session_id: '${sessionId}'`,
    'date: 2026-09-16',
    "started_at: ''",
    "ended_at: '2026-09-16T23:59:00.000Z'",
    'duration_minutes: 0',
    "status: 'concluded'",
    "concluded_at: '2026-09-16T23:59:00.000Z'",
    "end_reason: 'other'",
    "repo: 'emstacho-su/bb2dash'",
    "branch: 'feat/x'",
    "worktree: ''",
    'repos_touched: []',
    "cwd: ''",
    'cwds_seen: []',
    "phase: ''",
    'tags: []',
    'supersedes: []',
    "resumed_from: ''",
    "parent_session: ''",
    'child_sessions: []',
    'commits: []',
    'prs: []',
    'memory_files: []',
    "plan_file: ''",
    'docs_touched: []',
    'artifacts: []',
    'files_modified: []',
    'prompt_count: 1',
    'command_count: 0',
    'agent: claude-code',
    "agent_type: ''",
    "origin: 'cloud'",
    `captured_by: '${capturedBy}'`,
    "generator: 'checkpoint 1.0.0'",
    'tools_used: {}',
    extra,
    '---',
    '',
    `# Session 2026-09-16 — ${collection}`,
    '',
    body,
  ].filter((line) => line !== '').join('\n');
}

/**
 * origin (bare) with main + two feature branches carrying notes, and a clone
 * that has fetched nothing yet beyond main.
 */
function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoints-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const clone = path.join(root, 'clone');

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, ['config', 'user.email', 't@example.com']);
  git(work, ['config', 'user.name', 'T']);
  git(work, ['remote', 'add', 'origin', origin]);
  fs.writeFileSync(path.join(work, 'README.md'), '# fixture\n', 'utf8');
  git(work, ['add', '.']);
  git(work, ['commit', '-q', '-m', 'init']);
  git(work, ['push', '-q', 'origin', 'main']);

  // The clone is what the collector operates on; it knows main only.
  execFileSync('git', ['clone', '-q', origin, clone]);

  const addNote = (branch, fileName, text) => {
    git(work, ['checkout', '-q', '-B', branch, 'main']);
    const dir = path.join(work, '.harness', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), text, 'utf8');
    git(work, ['add', '.harness']);
    git(work, ['commit', '-q', '-m', `chore(harness): checkpoint ${fileName}`]);
    git(work, ['push', '-q', 'origin', branch]);
  };

  return { root, origin, work, clone, addNote, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

test('notes on remote branches are fetched, deduplicated by file, validated, and filed into the vault', () => {
  const fx = createFixture();
  const sandbox = createSandbox();
  try {
    fx.addNote('claude/one', `${A}.md`, note({ sessionId: A, collection: 'ist323' }));
    fx.addNote('claude/two', `${B}.md`, note({ sessionId: B, collection: 'bb2dash', source: 'git' }));
    // The same note again on a third branch: one note, not two.
    fx.addNote('claude/three', `${A}.md`, note({ sessionId: A, collection: 'ist323' }));

    const lines = [];
    const summary = runCollect({ repos: [fx.clone], vaultRoot: sandbox.vaultRoot, log: (l) => lines.push(l) });

    assert.equal(summary.repos[0].status, 'ok');
    assert.equal(summary.found, 2, 'A appears on two branches but is one note');
    assert.equal(summary.created, 2);
    assert.equal(summary.skipped, 0);

    const classNote = path.join(sandbox.vaultRoot, 'classes', 'ist323', 'sessions', `${A}.md`);
    const projectNote = path.join(sandbox.vaultRoot, 'projects', 'bb2dash', 'sessions', `${B}.md`);
    assert.ok(fs.existsSync(classNote), 'a class argument files under classes/');
    assert.ok(fs.existsSync(projectNote), 'a git-derived collection files under projects/');

    const parsed = parseFrontmatter(fs.readFileSync(classNote, 'utf8'));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.fields.tags, ['unclassified'], 'no tags becomes exactly unclassified');
    assert.equal(parsed.fields.captured_by, 'skill');

    // Second run: nothing changes.
    const again = runCollect({ repos: [fx.clone], vaultRoot: sandbox.vaultRoot });
    assert.equal(again.created, 0);
    assert.equal(again.unchanged, 2);
  } finally {
    fx.cleanup();
    sandbox.cleanup();
  }
});

test('validation refuses what the hook would refuse, and redacts the body', () => {
  assert.equal(validateNote('no frontmatter here').ok, false);
  assert.match(validateNote(note({ sessionId: A, collection: 'x', capturedBy: 'hook' })).reason, /captured_by/);
  assert.match(validateNote(note({ sessionId: '../../etc', collection: 'x' })).reason, /session_id/);
  assert.match(validateNote(note({ sessionId: A, collection: 'x' }).replace(`id: 'session-${A}'`, "id: 'session-other'")).reason, /id does not match/);
  assert.match(validateNote(note({ sessionId: A, collection: '' })).reason, /collection is empty/);
  assert.match(validateNote(note({ sessionId: A, collection: 'x' }).replace('type: session', 'type: index')).reason, /type/);

  const leaky = validateNote(note({ sessionId: A, collection: 'x', body: '## What I asked for\n1. Use postgresql://postgres.abc:SuperSecret123@aws-0-us-east-1.pooler.supabase.com:5432/postgres\n\n## What was done\n- x\n\n## Decisions\n- none\n\n## Open questions / next steps\n- none\n' }));
  assert.ok(leaky.ok);
  assert.ok(!leaky.body.includes('SuperSecret123'), 'the connection string is redacted before filing');
});

test('an argument that names no vault folder files under misc and says so; a git-derived project is created', () => {
  const sandbox = createSandbox();
  try {
    const typo = resolvePlacement(sandbox.vaultRoot, { collection: 'ist999', collection_source: 'argument' });
    assert.equal(typo.collection, 'misc');
    assert.match(typo.reason, /names no vault folder/);

    const fromGit = resolvePlacement(sandbox.vaultRoot, { collection: 'brand-new-repo', collection_source: 'git' });
    assert.equal(fromGit.collection, 'brand-new-repo');
    assert.equal(fromGit.area, 'projects');

    const known = resolvePlacement(sandbox.vaultRoot, { collection: 'ist323', collection_source: 'argument' });
    assert.equal(known.area, 'classes');
  } finally {
    sandbox.cleanup();
  }
});

test('a checkpoint is written once: a later copy never touches the vault note, and a hook-written id is refused', () => {
  const sandbox = createSandbox();
  try {
    const checked = validateNote(note({ sessionId: A, collection: 'bb2dash', source: 'git' }));
    assert.ok(checked.ok);
    const first = fileNote({ vaultRoot: sandbox.vaultRoot, fields: checked.fields, body: checked.body });
    assert.equal(first.action, 'create');

    // Stack edits the note by hand: a manual tag and a line in the body.
    const notePath = path.join(sandbox.vaultRoot, 'projects', 'bb2dash', 'sessions', `${A}.md`);
    const edited = fs.readFileSync(notePath, 'utf8').replace("tags:\n  - 'unclassified'", "tags:\n  - 'review'").replace('- Done.', '- Done. (Stack: verified)');
    fs.writeFileSync(notePath, edited, 'utf8');

    // A forged or re-collected copy with more in it: refused, nothing changes.
    const richer = { ...checked.fields, commits: ['abc1234'], status: 'superseded' };
    const second = fileNote({ vaultRoot: sandbox.vaultRoot, fields: richer, body: 'a different body that must not win' });
    assert.equal(second.action, 'noop');
    assert.equal(fs.readFileSync(notePath, 'utf8'), edited, 'the note on disk is byte-identical to the hand-edited one');

    // An id the hook or the sweep already wrote is never a checkpoint's to take.
    const hookNote = path.join(sandbox.vaultRoot, 'projects', 'bb2dash', 'sessions', `${B}.md`);
    fs.writeFileSync(hookNote, "---\nid: 'session-b'\ncaptured_by: 'hook'\n---\n\nreal\n", 'utf8');
    const forged = validateNote(note({ sessionId: B, collection: 'bb2dash', source: 'git' }));
    const refused = fileNote({ vaultRoot: sandbox.vaultRoot, fields: forged.fields, body: forged.body });
    assert.equal(refused.action, 'skip');
    assert.match(refused.reason, /hook or the sweep/);
    assert.equal(fs.readFileSync(hookNote, 'utf8').includes('real'), true);

    const dry = fileNote({ vaultRoot: sandbox.vaultRoot, fields: checked.fields, body: checked.body, dryRun: true });
    assert.equal(dry.action, 'noop', 'dry run reports the same decision');
  } finally {
    sandbox.cleanup();
  }
});

test('validation keeps only the v2 fields and pins the ones a note may not decide for itself', () => {
  const text = note({ sessionId: A, collection: 'bb2dash', source: 'git', extra: "evil_key: 'x'\nstatus: 'superseded'\nschema_version: 1" });
  const checked = validateNote(text);
  assert.ok(checked.ok);
  assert.equal(checked.fields.status, 'concluded');
  assert.equal(checked.fields.schema_version, 2);
  assert.equal(checked.fields.captured_by, 'skill');
  assert.equal('evil_key' in checked.fields, false, 'unknown keys are dropped');
  assert.deepEqual(checked.fields.supersedes, []);

  // A hand-built note missing half the fields comes out with every field present.
  const sparse = "---\nid: 'session-" + A + "'\ntype: session\ncaptured_by: 'skill'\nsession_id: '" + A + "'\ncollection: 'ist323'\n---\n\n# x\n\nbody text that is long enough\n";
  const filled = validateNote(sparse);
  assert.ok(filled.ok, filled.reason);
  assert.deepEqual(filled.fields.files_modified, []);
  assert.equal(filled.fields.repo, '');
  assert.equal(filled.fields.prompt_count, 0);
  assert.deepEqual(filled.fields.tools_used, {});
});

test('an author allow-list refuses notes committed by anyone else, and the log names the author', () => {
  const fx = createFixture();
  const sandbox = createSandbox();
  try {
    fx.addNote('claude/one', `${A}.md`, note({ sessionId: A, collection: 'ist323' }));
    const lines = [];

    const refused = runCollect({ repos: [fx.clone], vaultRoot: sandbox.vaultRoot, authors: ['someone-else@example.com'], log: (l) => lines.push(l) });
    assert.equal(refused.skipped, 1);
    assert.equal(refused.created, 0);
    assert.ok(lines.some((l) => /author "t@example.com" is not in the allow-list/.test(l)));

    const accepted = runCollect({ repos: [fx.clone], vaultRoot: sandbox.vaultRoot, authors: ['T@Example.com'], log: (l) => lines.push(l) });
    assert.equal(accepted.created, 1);
    assert.ok(lines.some((l) => /create classes\/ist323\/sessions\/.* by t@example.com/.test(l)));
  } finally {
    fx.cleanup();
    sandbox.cleanup();
  }
});

test('a missing repository is reported and skipped; a missing vault is refused outright', () => {
  const sandbox = createSandbox();
  try {
    const summary = runCollect({ repos: [path.join(sandbox.root, 'nope')], vaultRoot: sandbox.vaultRoot, fetch: false });
    assert.equal(summary.repos[0].status, 'missing');
    assert.equal(summary.found, 0);
    assert.throws(() => runCollect({ repos: [], vaultRoot: path.join(sandbox.root, 'no', 'vault') }), /vaultRoot is not available/);
  } finally {
    sandbox.cleanup();
  }
});

test('gatherNotes reads local branches too, so a note committed in a local session counts', () => {
  const fx = createFixture();
  try {
    fx.addNote('claude/local-only', `${B}.md`, note({ sessionId: B, collection: 'bb2dash', source: 'git' }));
    // `work` never pushed this branch anywhere else; read it without fetching.
    git(fx.work, ['checkout', '-q', '-b', 'never-pushed']);
    fs.writeFileSync(path.join(fx.work, '.harness', 'sessions', `${A}.md`), note({ sessionId: A, collection: 'ist323' }), 'utf8');
    git(fx.work, ['add', '.harness']);
    git(fx.work, ['commit', '-q', '-m', 'local checkpoint']);

    const gathered = gatherNotes({ repoRoot: fx.work, fetch: false });
    assert.deepEqual(gathered.notes.map((n) => path.basename(n.file)).sort(), [`${A}.md`, `${B}.md`]);
  } finally {
    fx.cleanup();
  }
});

test('argument parsing and the CLI exit codes', () => {
  const parsed = parseArgs(['--repo', 'a', '--repo', 'b', '--no-fetch', '--dry-run'], {}, 'C:/home');
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.options.repos, ['a', 'b']);
  assert.equal(parsed.options.fetch, false);
  assert.equal(parsed.options.dryRun, true);
  assert.equal(parseArgs([], {}, 'C:/home').options.repos.length, 2, 'the two default repositories');
  assert.equal(parseArgs(['--repo'], {}, 'C:/home').ok, false);
  assert.equal(parseArgs(['--bogus'], {}, 'C:/home').ok, false);

  const fx = createFixture();
  const sandbox = createSandbox();
  try {
    fx.addNote('claude/one', `${A}.md`, note({ sessionId: A, collection: 'ist323' }));
    fx.addNote('claude/bad', `${B}.md`, note({ sessionId: B, collection: 'x', capturedBy: 'hook' }));
    const logPath = path.join(sandbox.root, 'collect.log');
    const exitOf = (args) => {
      try {
        execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, [LOG_ENV_VAR]: logPath } });
        return EXIT_OK;
      } catch (err) {
        return err.status;
      }
    };
    assert.equal(exitOf(['--bogus']), EXIT_USAGE);
    assert.equal(exitOf(['--vault', path.join(sandbox.root, 'no', 'vault'), '--repo', fx.clone]), EXIT_USAGE);
    assert.equal(exitOf(['--vault', sandbox.vaultRoot, '--repo', fx.clone, '--dry-run']), EXIT_PROBLEMS, 'one refused note is a problem, not a crash');
    assert.ok(!fs.existsSync(path.join(sandbox.vaultRoot, 'classes', 'ist323', 'sessions', `${A}.md`)), 'dry run wrote nothing');
    assert.match(fs.readFileSync(logPath, 'utf8'), /captured_by/);
  } finally {
    fx.cleanup();
    sandbox.cleanup();
  }
});
