/**
 * The field back-fill (brief 101 H-8, task 14) on a fixture vault.
 *
 * Every case runs against a scratch vault in the temp folder, never the live
 * one: the tool writes notes, and the only safe place to prove it writes the
 * right ones is a vault nobody reads. Git and `gh` are injected fakes; the one
 * CLI case runs with `--no-network` against a fake checkout.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as backfillFields from '../lib/backfill-fields.mjs';
import { REPORT_KEYS, parseRelocation, runBackfill } from '../lib/backfill-fields.mjs';
import { FIELD_SPEC, parseFrontmatter } from '../lib/frontmatter.mjs';
import { renderFacts, renderNote } from '../lib/note.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'backfill-fields.mjs');

const BB2DASH = 'emstacho-su/bb2dash';
const SESSIONS = 'projects/bb2dash/sessions';
const ONEDRIVE_CHECKOUT = 'C:/Users/stack/OneDrive - Syracuse University/.fall2026/.projects2026/bb2dash';

const IDS = Object.freeze({
  mcp: '0e3b3d00-157a-4323-ae9e-c481e5042e88',
  sixReplay: '11111111-1111-4111-8111-111111111111',
  sixNoTranscript: '3a1f9923-0000-4000-8000-000000000001',
  parent: '22222222-2222-4222-8222-222222222222',
  onedrive: '33333333-3333-4333-8333-333333333333',
  bare: '44444444-4444-4444-8444-444444444444',
  worktree: '55555555-5555-4555-8555-555555555555',
  classNote: 'ca25962a-1466-4000-8000-000000000001',
  harness: '66666666-6666-4666-8666-666666666666',
});
const WORKFLOW_AGENT = 'wf0001';
const PHASE_WORKER = 'c0ffee12';

// ------------------------------------------------------------------ fixtures

function blankFields() {
  const defaults = { list: [], numlist: [], map: {}, records: [], quoted: '', plain: '' };
  return Object.fromEntries(FIELD_SPEC.map(([name, kind]) => [name, structuredClone(defaults[kind] ?? '')]));
}

/** A schema-v2 note as the hook or the migration left it; `omit` drops fields (a note from before them). */
function noteText(overrides, { transcriptPath = '', omit = ['hook_tags'], tail = '' } = {}) {
  const fields = {
    ...blankFields(),
    type: 'session',
    schema_version: 2,
    collection: 'bb2dash',
    collection_source: 'git',
    date: '2026-09-10',
    started_at: '2026-09-10T10:00:00.000Z',
    ended_at: '2026-09-10T11:00:00.000Z',
    duration_minutes: 60,
    status: 'concluded',
    end_reason: 'logout',
    agent: 'claude-code',
    generator: 'session-capture.mjs 2.3.0',
    ...overrides,
  };
  for (const name of omit) delete fields[name];
  const body = [
    `# ${fields.title || 'A session'}`,
    '',
    'Working directory somewhere.',
    '',
    ...renderFacts({ ...blankFields(), ...fields }, { transcriptPath }),
  ].join('\n');
  return renderNote(fields, `${body}${tail}`);
}

function writeNote(sandbox, relative, text) {
  const file = path.join(sandbox.vault, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function writeTranscript(sandbox, name, records) {
  const file = path.join(sandbox.root, 'transcripts', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return file.replace(/\\/g, '/');
}

function edit(filePath, at) {
  return {
    type: 'assistant',
    timestamp: at,
    entrypoint: 'cli',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `t-${at}`, name: 'Edit', input: { file_path: filePath } }] },
  };
}

function bash(command, at) {
  return {
    type: 'assistant',
    timestamp: at,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `b-${at}`, name: 'Bash', input: { command } }] },
  };
}

function createSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-fields-')).replace(/\\/g, '/');
  const checkout = `${root}/repos/bb2dash`;
  fs.mkdirSync(`${checkout}/.git`, { recursive: true });
  fs.writeFileSync(`${checkout}/.git/config`, `[remote "origin"]\n\turl = https://github.com/${BB2DASH}.git\n`, 'utf8');
  fs.writeFileSync(`${checkout}/.git/HEAD`, 'ref: refs/heads/main\n', 'utf8');
  const sandbox = {
    root,
    checkout,
    vault: `${root}/vault`,
    backup: `${root}/archive/2026-09-29/backfill`,
    home: `${root}/home`,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
  fs.mkdirSync(`${sandbox.vault}/${SESSIONS}`, { recursive: true });
  fs.mkdirSync(`${sandbox.vault}/classes/ist466/sessions`, { recursive: true });
  return sandbox;
}

/** The fixture vault: one note per case the brief names, each in its own shape. */
function buildVault(sandbox) {
  const { checkout } = sandbox;
  const workflowCwd = `${sandbox.home}/.claude/projects/${encode(checkout)}/${IDS.parent}/subagents/workflows/wf-1`;

  // A feat/retrieval-mcp session tagged phase-7 today (the 0e3b3d00 shape).
  writeNote(sandbox, `${SESSIONS}/${IDS.mcp}.md`, noteText({
    id: `session-${IDS.mcp}`, session_id: IDS.mcp, repo: BB2DASH, branch: 'feat/retrieval-mcp', cwd: checkout,
    phase: 'phase-7', tags: ['phase-7', 'mcp'],
  }));

  // Six vocabulary tags and a hand tag, transcript on disk: the classifier is replayed.
  const sixTranscript = writeTranscript(sandbox, 'six.jsonl', [
    { type: 'user', timestamp: '2026-09-10T10:00:00.000Z', entrypoint: 'cli', cwd: checkout, origin: { kind: 'human' }, message: { role: 'user', content: 'Build the grades table.' } },
    edit(`${checkout}/web/src/app/grades/page.tsx`, '2026-09-10T10:10:00.000Z'),
    edit(`${checkout}/db/migrations/041_grades.sql`, '2026-09-10T10:20:00.000Z'),
    bash('npm test', '2026-09-10T10:30:00.000Z'),
  ]);
  writeNote(sandbox, `${SESSIONS}/${IDS.sixReplay}.md`, noteText({
    id: `session-${IDS.sixReplay}`, session_id: IDS.sixReplay, repo: BB2DASH, branch: 'feat/grades-10a', cwd: checkout,
    phase: '', tags: ['phase-10a', 'db', 'gui', 'validation', 'pr', 'planning', 'stack-favourite'],
    files_modified: [`${checkout}/web/src/app/grades/page.tsx`, 'db/migrations/041_grades.sql'],
  }, { transcriptPath: sixTranscript }));

  // Six tags, no transcript here (the amendment's case): tags stay, hook_tags: [].
  writeNote(sandbox, `${SESSIONS}/${IDS.sixNoTranscript}.md`, noteText({
    id: `session-${IDS.sixNoTranscript}`, session_id: IDS.sixNoTranscript, repo: BB2DASH, branch: 'feat/db-hygiene-15', cwd: checkout,
    phase: 'phase-15', tags: ['phase-15', 'db', 'ingest', 'harness', 'validation', 'pr'],
  }, { transcriptPath: `${sandbox.root}/gone/${IDS.sixNoTranscript}.jsonl` }));

  // A PM note on a phase branch, its workflow worker (repo ''), and a worker on main.
  writeNote(sandbox, `${SESSIONS}/${IDS.parent}.md`, noteText({
    id: `session-${IDS.parent}`, session_id: IDS.parent, repo: BB2DASH, branch: 'fix/page-pass-12b', cwd: checkout,
    phase: '', tags: ['hotfix'], child_sessions: [`session-${IDS.parent}--${WORKFLOW_AGENT}`],
  }));
  writeNote(sandbox, `${SESSIONS}/${IDS.parent}--${WORKFLOW_AGENT}.md`, noteText({
    id: `session-${IDS.parent}--${WORKFLOW_AGENT}`, session_id: IDS.parent, parent_session: IDS.parent,
    repo: '', branch: '', cwd: workflowCwd, agent_type: 'workflow', tags: ['unclassified'],
  }));
  writeNote(sandbox, `${SESSIONS}/${IDS.parent}--${PHASE_WORKER}.md`, noteText({
    id: `session-${IDS.parent}--${PHASE_WORKER}`, session_id: IDS.parent, parent_session: IDS.parent,
    repo: BB2DASH, branch: 'main', cwd: checkout, agent_type: 'general-purpose', tags: ['docs'],
  }));

  // The pre-move OneDrive checkout.
  writeNote(sandbox, `${SESSIONS}/${IDS.onedrive}.md`, noteText({
    id: `session-${IDS.onedrive}`, session_id: IDS.onedrive, repo: '', branch: '', cwd: ONEDRIVE_CHECKOUT, tags: ['unclassified'],
  }));

  // Nothing derivable: no cwd that resolves, no branch, no transcript.
  writeNote(sandbox, `${SESSIONS}/${IDS.bare}.md`, noteText({
    id: `session-${IDS.bare}`, session_id: IDS.bare, repo: '', branch: '', cwd: '', tags: ['unclassified'],
  }));

  // A worktree session with an absolute path under the worktree.
  writeNote(sandbox, `${SESSIONS}/${IDS.worktree}.md`, noteText({
    id: `session-${IDS.worktree}`, session_id: IDS.worktree, repo: '', branch: 'feat/web-polish-17',
    cwd: `${checkout}-wt-polish`, files_modified: [`${checkout}-wt-polish/web/src/app/page.tsx`], tags: ['gui'],
  }));

  // A class session misfiled under bb2dash, for --relocate.
  writeNote(sandbox, `${SESSIONS}/${IDS.classNote}.md`, noteText({
    id: `session-${IDS.classNote}`, session_id: IDS.classNote, repo: BB2DASH, branch: 'main', cwd: checkout, tags: ['docs'],
  }));

  // Out of scope: another repo's note elsewhere is never read into the report.
  writeNote(sandbox, `projects/agentic-harness/sessions/${IDS.harness}.md`, noteText({
    id: `session-${IDS.harness}`, session_id: IDS.harness, collection: 'agentic-harness', repo: 'emstacho-su/agentic-harness',
    branch: 'feat/containers', cwd: `${sandbox.root}/repos/agentic-harness`, phase: 'phase-14', tags: ['phase-14'],
  }));
  return { workflowCwd, sixTranscript };
}

function encode(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

const PR_ROWS = [{ number: 21, title: 'fix: page pass 12b', headRefName: 'fix/page-pass-12b', createdAt: '2026-09-10T10:30:00Z', mergedAt: null, closedAt: null }];

function options(sandbox, extra = {}) {
  return {
    vaultRoot: sandbox.vault,
    backupDir: sandbox.backup,
    checkout: sandbox.checkout,
    home: sandbox.home,
    projectsRoot: `${sandbox.home}/.claude/projects`,
    machine: 'stack-laptop',
    runGit: () => ({ ok: false, stdout: '', error: 'no git in the fixture' }),
    runGh: () => ({ ok: true, stdout: JSON.stringify(PR_ROWS) }),
    ...extra,
  };
}

function fieldsOf(sandbox, relative) {
  const parsed = parseFrontmatter(fs.readFileSync(path.join(sandbox.vault, relative), 'utf8'));
  assert.equal(parsed.ok, true, parsed.error);
  return parsed;
}

function hashTree(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full).replace(/\\/g, '/')] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function withSandbox(fn) {
  const sandbox = createSandbox();
  try {
    return fn(sandbox);
  } finally {
    sandbox.cleanup();
  }
}

// --------------------------------------------------------------------- cases

test('--dry-run prints one line per change and leaves every file hash unchanged', () => {
  withSandbox((sandbox) => {
    buildVault(sandbox);
    const before = hashTree(sandbox.vault);
    const result = runBackfill(options(sandbox, { dryRun: true }));
    assert.deepEqual(hashTree(sandbox.vault), before);
    assert.equal(fs.existsSync(sandbox.backup), false, 'a dry run backs nothing up');
    assert.ok(result.lines.length > 0);
    for (const line of result.lines) assert.match(line, /^\S+ [a-z_]+: .* -> .* \(.+\)$/, line);
    assert.ok(result.lines.includes(`${IDS.mcp} phase: "phase-7" -> "" (branch feat/retrieval-mcp)`), result.lines.join('\n'));
    assert.equal(result.report.changes, result.lines.length);
  });
});

test('apply, then a second run reports changes: 0', () => {
  withSandbox((sandbox) => {
    buildVault(sandbox);
    const first = runBackfill(options(sandbox, { dryRun: false }));
    assert.ok(first.report.changes > 0);
    assert.deepEqual(first.refused, []);
    const second = runBackfill(options(sandbox, { dryRun: true }));
    assert.deepEqual(second.lines, []);
    assert.equal(second.report.changes, 0);
  });
});

test('a feat/retrieval-mcp note tagged phase-7 ends phase: ""', () => {
  withSandbox((sandbox) => {
    buildVault(sandbox);
    runBackfill(options(sandbox, { dryRun: false }));
    assert.equal(fieldsOf(sandbox, `${SESSIONS}/${IDS.mcp}.md`).fields.phase, '');
  });
});

test('an underivable field stays empty, never guessed', () => {
  withSandbox((sandbox) => {
    buildVault(sandbox);
    runBackfill(options(sandbox, { dryRun: false }));
    const { fields } = fieldsOf(sandbox, `${SESSIONS}/${IDS.bare}.md`);
    assert.equal(fields.repo, '');
    assert.equal(fields.phase, '');
    assert.equal(fields.machine, '', 'no transcript here: the machine is not derivable (B-54)');
    assert.equal(fields.origin, '');
    assert.deepEqual(fields.hook_tags, []);
  });
});

test('the backup holds every changed original, byte for byte, and nothing else', () => {
  withSandbox((sandbox) => {
    buildVault(sandbox);
    const before = hashTree(sandbox.vault);
    const result = runBackfill(options(sandbox, { dryRun: false }));
    const after = hashTree(sandbox.vault);
    const changed = Object.keys(before).filter((file) => after[file] !== before[file]);
    assert.ok(changed.length > 0);
    const backedUp = hashTree(sandbox.backup);
    for (const file of changed) assert.equal(backedUp[file], before[file], `${file} is not backed up as it was`);
    assert.deepEqual(Object.keys(backedUp).sort(), [...changed].sort());
    assert.deepEqual(result.written.length, changed.length);
  });
});

test('a six-tag note with its transcript ends with at most five hook_tags and its hand tag kept', () => {
  withSandbox((sandbox) => {
    buildVault(sandbox);
    runBackfill(options(sandbox, { dryRun: false }));
    const { fields } = fieldsOf(sandbox, `${SESSIONS}/${IDS.sixReplay}.md`);
    assert.deepEqual(fields.hook_tags, ['phase-10a', 'db', 'gui', 'validation']);
    assert.ok(fields.tags.includes('stack-favourite'), 'the hand tag is kept');
    assert.ok(!fields.tags.includes('pr') && !fields.tags.includes('planning'), 'vocabulary tags the replay did not raise go');
    assert.equal(fields.phase, 'phase-10a');
    assert.equal(fields.machine, 'stack-laptop', 'the transcript is on this machine (B-54)');
    assert.equal(fields.origin, 'cli');
    assert.deepEqual(fields.files_modified, ['web/src/app/grades/page.tsx', 'db/migrations/041_grades.sql']);
  });
});

test('a six-tag note with no transcript ends unchanged, with hook_tags: []', () => {
  withSandbox((sandbox) => {
    buildVault(sandbox);
    const relative = `${SESSIONS}/${IDS.sixNoTranscript}.md`;
    const before = fieldsOf(sandbox, relative).fields;
    runBackfill(options(sandbox, { dryRun: false }));
    const { fields } = fieldsOf(sandbox, relative);
    assert.deepEqual(fields.tags, before.tags);
    assert.deepEqual(fields.hook_tags, []);
    assert.equal(fields.phase, 'phase-15');
    assert.equal(fields.machine, '');
  });
});

test("a workflow-subagent note with repo '' ends with its parent note's repo and phase", () => {
  withSandbox((sandbox) => {
    buildVault(sandbox);
    runBackfill(options(sandbox, { dryRun: false }));
    const { fields } = fieldsOf(sandbox, `${SESSIONS}/${IDS.parent}--${WORKFLOW_AGENT}.md`);
    assert.equal(fields.repo, BB2DASH);
    assert.equal(fields.phase, 'phase-12b');
    const worker = fieldsOf(sandbox, `${SESSIONS}/${IDS.parent}--${PHASE_WORKER}.md`).fields;
    assert.equal(worker.phase, 'phase-12b', 'a worker on main takes its parent note’s phase');
  });
});

test('a workflow-subagent note whose parent note is missing takes the repo of the parent transcript cwd', () => {
  withSandbox((sandbox) => {
    const { workflowCwd } = buildVault(sandbox);
    fs.rmSync(path.join(sandbox.vault, SESSIONS, `${IDS.parent}.md`));
    const projectDir = path.dirname(path.dirname(path.dirname(path.dirname(workflowCwd))));
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${IDS.parent}.jsonl`), `${JSON.stringify({ type: 'user', cwd: sandbox.checkout, timestamp: '2026-09-10T10:00:00.000Z' })}\n`);
    runBackfill(options(sandbox, { dryRun: false }));
    assert.equal(fieldsOf(sandbox, `${SESSIONS}/${IDS.parent}--${WORKFLOW_AGENT}.md`).fields.repo, BB2DASH);
  });
});

test('a note whose cwd is the pre-move OneDrive checkout ends repo: emstacho-su/bb2dash', () => {
  withSandbox((sandbox) => {
    buildVault(sandbox);
    runBackfill(options(sandbox, { dryRun: false }));
    assert.equal(fieldsOf(sandbox, `${SESSIONS}/${IDS.onedrive}.md`).fields.repo, BB2DASH);
  });
});

test('a bb2dash-wt-* cwd takes the main checkout origin, its branch segment names the phase, and paths go repo-relative', () => {
  withSandbox((sandbox) => {
    buildVault(sandbox);
    runBackfill(options(sandbox, { dryRun: false }));
    const { fields } = fieldsOf(sandbox, `${SESSIONS}/${IDS.worktree}.md`);
    assert.equal(fields.repo, BB2DASH);
    assert.equal(fields.phase, 'phase-17');
    assert.deepEqual(fields.files_modified, ['web/src/app/page.tsx']);
  });
});

test('prs come from gh inside the session window, and --no-network leaves them empty', () => {
  withSandbox((sandbox) => {
    buildVault(sandbox);
    const offline = runBackfill(options(sandbox, { dryRun: true, network: false, runGh: () => assert.fail('gh must not run offline') }));
    assert.ok(!offline.lines.some((line) => line.includes(' prs: ')));
    runBackfill(options(sandbox, { dryRun: false }));
    assert.deepEqual(fieldsOf(sandbox, `${SESSIONS}/${IDS.parent}.md`).fields.prs, [21]);
  });
});

test('the Session facts rows equal the frontmatter on every note after the run', () => {
  withSandbox((sandbox) => {
    buildVault(sandbox);
    runBackfill(options(sandbox, { dryRun: false }));
    for (const name of fs.readdirSync(path.join(sandbox.vault, SESSIONS))) {
      const { fields, body } = fieldsOf(sandbox, `${SESSIONS}/${name}`);
      const row = (label) => body.match(new RegExp(`\\n\\| ${label} \\| (.*) \\|\\n`))?.[1];
      assert.equal(row('Repo'), fields.repo || '—', `${name}: Repo`);
      assert.equal(row('Phase'), fields.phase || '—', `${name}: Phase`);
      const tags = fields.tags.length ? fields.tags.map((tag) => `\`${tag}\``).join(', ') : '—';
      assert.equal(row('Tags'), tags, `${name}: Tags`);
    }
  });
});

test('the transcript row and anything written below the generated marker survive the re-render', () => {
  withSandbox((sandbox) => {
    const { sixTranscript } = buildVault(sandbox);
    const relative = `${SESSIONS}/${IDS.mcp}.md`;
    const text = fs.readFileSync(path.join(sandbox.vault, relative), 'utf8');
    fs.writeFileSync(path.join(sandbox.vault, relative), `${text}\nStack's own paragraph.\n`, 'utf8');
    runBackfill(options(sandbox, { dryRun: false }));
    const after = fs.readFileSync(path.join(sandbox.vault, relative), 'utf8');
    assert.match(after, /Stack's own paragraph\.\n$/);
    const six = fs.readFileSync(path.join(sandbox.vault, `${SESSIONS}/${IDS.sixReplay}.md`), 'utf8');
    assert.ok(six.includes(`| Transcript | \`${sixTranscript}\` |`));
  });
});

test('every derived string is redacted', () => {
  withSandbox((sandbox) => {
    buildVault(sandbox);
    const leaked = `${sandbox.checkout}-wt-polish/web/sb_secret_9aQZ1kLmNOPqrstuvwxyz0123456789ab.ts`;
    const relative = `${SESSIONS}/${IDS.worktree}.md`;
    const text = fs.readFileSync(path.join(sandbox.vault, relative), 'utf8');
    fs.writeFileSync(path.join(sandbox.vault, relative), text.replace(`files_modified:\n`, `files_modified:\n  - '${leaked}'\n`), 'utf8');
    runBackfill(options(sandbox, { dryRun: false }));
    const after = fs.readFileSync(path.join(sandbox.vault, relative), 'utf8');
    assert.ok(!after.includes('sb_secret_9aQZ1kLmNOPqrstuvwxyz0123456789ab'));
  });
});

test('--relocate writes the note into the class folder and moves the original into the backup', () => {
  withSandbox((sandbox) => {
    buildVault(sandbox);
    const original = path.join(sandbox.vault, SESSIONS, `${IDS.classNote}.md`);
    const originalText = fs.readFileSync(original, 'utf8');
    const result = runBackfill(options(sandbox, { dryRun: false, relocations: [parseRelocation('ca25962a=classes/ist466')] }));
    assert.deepEqual(result.refused, []);
    assert.equal(fs.existsSync(original), false, 'the original left the projects realm');
    const moved = fieldsOf(sandbox, `classes/ist466/sessions/${IDS.classNote}.md`).fields;
    assert.equal(moved.collection, 'ist466');
    assert.equal(moved.collection_source, 'folder');
    assert.equal(moved.up, '[[classes/ist466/ist466|ist466]]');
    assert.equal(fs.readFileSync(path.join(sandbox.backup, SESSIONS, `${IDS.classNote}.md`), 'utf8'), originalText, 'moved, never deleted');
    assert.ok(result.lines.includes(`${IDS.classNote} path: "${SESSIONS}/${IDS.classNote}.md" -> "classes/ist466/sessions/${IDS.classNote}.md" (--relocate ca25962a=classes/ist466)`));
    assert.equal(runBackfill(options(sandbox, { dryRun: true, relocations: [parseRelocation('ca25962a=classes/ist466')] })).report.changes, 0);
  });
});

test('--relocate refuses a target that already exists and leaves both notes alone', () => {
  withSandbox((sandbox) => {
    buildVault(sandbox);
    const target = writeNote(sandbox, `classes/ist466/sessions/${IDS.classNote}.md`, 'already here\n');
    const result = runBackfill(options(sandbox, { dryRun: false, relocations: [parseRelocation('ca25962a=classes/ist466')] }));
    assert.equal(result.refused.length, 1);
    assert.match(result.refused[0].error, /target exists/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'already here\n');
    assert.ok(fs.existsSync(path.join(sandbox.vault, SESSIONS, `${IDS.classNote}.md`)));
  });
});

test('parseRelocation takes <prefix>=<realm>/<collection> and refuses anything else', () => {
  assert.deepEqual(parseRelocation('ca25962a=classes/ist466'), { prefix: 'ca25962a', realm: 'classes', collection: 'ist466', spec: 'ca25962a=classes/ist466' });
  for (const bad of ['ca25962a', '=classes/ist466', 'ca25962a=classes', 'ca25962a=nowhere/ist466', 'ca/25=classes/ist466', 'ca25962a=classes/../x']) {
    assert.throws(() => parseRelocation(bad), /--relocate/, bad);
  }
});

test('--report counts the projected state: every key, and the over-cap and indexed figures', () => {
  withSandbox((sandbox) => {
    buildVault(sandbox);
    // An SDK note and an `ingest: false` note are not in the indexed set.
    writeNote(sandbox, `${SESSIONS}/77777777-7777-4777-8777-777777777777.md`, noteText({
      id: 'session-77777777-7777-4777-8777-777777777777', session_id: '77777777-7777-4777-8777-777777777777',
      repo: BB2DASH, origin: 'sdk-ts', cwd: sandbox.checkout, tags: ['unclassified'],
    }));
    const { report } = runBackfill(options(sandbox, { dryRun: true }));
    assert.deepEqual(Object.keys(report), [...REPORT_KEYS]);
    assert.equal(report.bb2dash_notes, 11);
    assert.equal(report.top_level_notes, 9);
    assert.equal(report.distinct_top_level_session_ids, 9);
    assert.equal(report.hook_tags_over_cap, 0);
    assert.equal(report.unknown_hook_tags, 0);
    assert.equal(report.absolute_files_modified, 0);
    assert.equal(report.phase_body_mismatch, 0);
    assert.equal(report.repo_empty_underivable, 1, 'only the bare note');
    assert.equal(report.phase_underivable, report.bb2dash_notes - report.phase_set);
    assert.equal(report.phase_underivable_indexed, report.phase_underivable - 1, 'the SDK note is not indexed');
    assert.ok(report.repo_empty >= 4, 'repo_empty counts the vault as it is, before the run');
  });
});

// ------------------------------------------------------ former home (estac)

/**
 * A sandbox shaped like the real machines: the checkout under the current
 * home, and notes captured on the old laptop whose user folder differs
 * (`C:/Users/estac` there, `C:/Users/stack` here; bb2dash DECISIONS
 * 2026-09-29). Nothing under the former home exists on disk, as on this laptop.
 */
function createHomesSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-homes-')).replace(/\\/g, '/');
  const home = `${root}/Users/stack`;
  const former = `${root}/Users/estac`;
  const checkout = `${home}/projects/bb2dash`;
  fs.mkdirSync(`${checkout}/.git`, { recursive: true });
  fs.writeFileSync(`${checkout}/.git/config`, `[remote "origin"]\n\turl = https://github.com/${BB2DASH}.git\n`, 'utf8');
  fs.writeFileSync(`${checkout}/.git/HEAD`, 'ref: refs/heads/main\n', 'utf8');
  fs.mkdirSync(`${root}/vault/${SESSIONS}`, { recursive: true });
  return {
    root, home, former, checkout,
    vault: `${root}/vault`,
    backup: `${root}/archive/backfill`,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const FORMER = Object.freeze({
  worktree: 'a0000001-0000-4000-8000-000000000001',
  parent: 'a0000002-0000-4000-8000-000000000002',
  memory: 'a0000003-0000-4000-8000-000000000003',
  onedrive: 'a0000004-0000-4000-8000-000000000004',
  onedriveBelow: 'a0000005-0000-4000-8000-000000000005',
  absolute: 'a0000006-0000-4000-8000-000000000006',
  otherRepo: 'a0000007-0000-4000-8000-000000000007',
  otherMemory: 'a0000008-0000-4000-8000-000000000008',
  orphanParent: 'a0000009-0000-4000-8000-000000000009',
  orphanWorktreeParent: 'a000000a-0000-4000-8000-00000000000a',
  retrieval: 'a000000b-0000-4000-8000-00000000000b',
});

function buildFormerHomeVault(sandbox) {
  const { former, home } = sandbox;
  const oldCheckout = `${former}/projects/bb2dash`;
  const oldProject = `${former}/.claude/projects/${encode(oldCheckout)}`;
  const oldOneDrive = `${former}/OneDrive - Syracuse University/.fall2026/.projects2026/bb2dash`;
  const put = (id, fields, name = `${id}.md`) => writeNote(sandbox, `${SESSIONS}/${name}`, noteText({ id: `session-${id}`, session_id: id, repo: '', branch: '', tags: ['unclassified'], ...fields }));

  put(FORMER.worktree, { cwd: `${former}/projects/bb2dash-wt-p11`, branch: 'feat/planner-11' });
  put(FORMER.parent, { cwd: `${former}/projects/bb2dash-wt-12b`, branch: 'fix/page-pass-12b', child_sessions: [`session-${FORMER.parent}--${WORKFLOW_AGENT}`] });
  put(FORMER.parent, { parent_session: FORMER.parent, cwd: `${oldProject}/${FORMER.parent}/subagents/workflows/wf-1`, agent_type: 'workflow' }, `${FORMER.parent}--${WORKFLOW_AGENT}.md`);
  put(FORMER.memory, { cwd: `${oldProject}/memory` });
  put(FORMER.onedrive, { cwd: oldOneDrive });
  put(FORMER.onedriveBelow, { cwd: `${oldOneDrive}/course context/IST.466` });
  put(FORMER.absolute, {
    repo: BB2DASH, cwd: `${former}/projects/bb2dash-wt-p11`,
    files_modified: [
      `${former}/projects/bb2dash-wt-p11`,
      `${former}/projects/bb2dash-wt-p11/web/src/app/planner/page.tsx`,
      `${oldCheckout}/db/migrations/050_planner.sql`,
      oldCheckout,
      `${home}/projects/bb2dash`,
      `${oldOneDrive}/ingest/bb_crawler.js`,
    ],
  });
  // Never guessed: another repo under the former home, and another project's memory folder.
  put(FORMER.otherRepo, { cwd: `${former}/projects/some-other-repo` });
  put(FORMER.otherMemory, { cwd: `${former}/.claude/projects/${encode(`${former}/projects/some-other-repo`)}/memory` });
  // Workflow agents whose parent note is gone and whose parent transcript is not on this machine.
  put(FORMER.orphanParent, { parent_session: FORMER.orphanParent, cwd: `${oldProject}/${FORMER.orphanParent}/subagents/workflows/wf-2`, agent_type: 'workflow' }, `${FORMER.orphanParent}--${WORKFLOW_AGENT}.md`);
  put(FORMER.orphanWorktreeParent, { parent_session: FORMER.orphanWorktreeParent, cwd: `${oldProject}-wt-p11/${FORMER.orphanWorktreeParent}/subagents/workflows/wf-3`, agent_type: 'workflow' }, `${FORMER.orphanWorktreeParent}--${WORKFLOW_AGENT}.md`);
  // bb2dash-retrieval, the worktree brief 66 G1 names, beside the old checkout.
  put(FORMER.retrieval, { cwd: `${former}/projects/bb2dash-retrieval`, files_modified: [`${former}/projects/bb2dash-retrieval/mcp-server/src/index.ts`] });
}

function formerOptions(sandbox, extra = {}) {
  return {
    vaultRoot: sandbox.vault,
    backupDir: sandbox.backup,
    checkout: sandbox.checkout,
    home: sandbox.home,
    formerHomes: [sandbox.former],
    projectsRoot: `${sandbox.home}/.claude/projects`,
    machine: 'stack-laptop',
    runGit: () => ({ ok: false, stdout: '', error: 'no git in the fixture' }),
    runGh: () => ({ ok: true, stdout: '[]' }),
    ...extra,
  };
}

function withFormerHome(fn) {
  const sandbox = createHomesSandbox();
  try {
    buildFormerHomeVault(sandbox);
    runBackfill(formerOptions(sandbox, { dryRun: false }));
    return fn(sandbox, (name) => fieldsOf(sandbox, `${SESSIONS}/${name}`).fields);
  } finally {
    sandbox.cleanup();
  }
}

test('FORMER_HOMES names the old laptop user folder', () => {
  assert.deepEqual([...(backfillFields.FORMER_HOMES ?? [])], ['C:/Users/estac']);
});

test('a bb2dash-wt-* cwd under a former home takes the main checkout origin', () => {
  withFormerHome((sandbox, fields) => {
    const note = fields(`${FORMER.worktree}.md`);
    assert.equal(note.repo, BB2DASH);
    assert.equal(note.phase, 'phase-11');
  });
});

test("a workflow agent under a former home's bb2dash project folder takes its parent note's repo", () => {
  withFormerHome((sandbox, fields) => {
    assert.equal(fields(`${FORMER.parent}.md`).repo, BB2DASH);
    assert.equal(fields(`${FORMER.parent}--${WORKFLOW_AGENT}.md`).repo, BB2DASH);
  });
});

test("a cwd in bb2dash's own Claude project memory folder under a former home is bb2dash", () => {
  withFormerHome((sandbox, fields) => {
    assert.equal(fields(`${FORMER.memory}.md`).repo, BB2DASH);
  });
});

test('the OneDrive checkout under a former home, and a path below it, are bb2dash', () => {
  withFormerHome((sandbox, fields) => {
    assert.equal(fields(`${FORMER.onedrive}.md`).repo, BB2DASH);
    assert.equal(fields(`${FORMER.onedriveBelow}.md`).repo, BB2DASH);
  });
});

test('absolute files_modified under a former home go repo-relative, a checkout or worktree root to "."', () => {
  withFormerHome((sandbox, fields) => {
    assert.deepEqual(fields(`${FORMER.absolute}.md`).files_modified, [
      '.',
      'web/src/app/planner/page.tsx',
      'db/migrations/050_planner.sql',
      'ingest/bb_crawler.js',
    ]);
  });
});

test('a former-home cwd that is not bb2dash stays repo: "" (never guessed)', () => {
  withFormerHome((sandbox, fields) => {
    assert.equal(fields(`${FORMER.otherRepo}.md`).repo, '');
    assert.equal(fields(`${FORMER.otherMemory}.md`).repo, '');
  });
});

test("a workflow agent with no parent note or transcript takes bb2dash from the exact project folder, a -wt- folder never", () => {
  withFormerHome((sandbox, fields) => {
    assert.equal(fields(`${FORMER.orphanParent}--${WORKFLOW_AGENT}.md`).repo, BB2DASH);
    assert.equal(fields(`${FORMER.orphanWorktreeParent}--${WORKFLOW_AGENT}.md`).repo, '');
  });
});

test('bb2dash-retrieval under a former home is a bb2dash worktree (brief 66 G1)', () => {
  withFormerHome((sandbox, fields) => {
    const note = fields(`${FORMER.retrieval}.md`);
    assert.equal(note.repo, BB2DASH);
    assert.deepEqual(note.files_modified, ['mcp-server/src/index.ts']);
  });
});

test("a sibling repo's Claude project folder (bb2dash-notes) is out of scope under every home, on a dry run and a real run", () => {
  const sandbox = createHomesSandbox();
  try {
    buildFormerHomeVault(sandbox);
    const siblings = [sandbox.home, sandbox.former].map((home, index) => {
      const id = `b000000${index + 1}-0000-4000-8000-00000000000${index + 1}`;
      const folder = `${home}/.claude/projects/${encode(`${home}/projects/bb2dash-notes`)}`;
      const relative = `projects/bb2dash-notes/sessions/${id}--${WORKFLOW_AGENT}.md`;
      writeNote(sandbox, relative, noteText({
        id: `session-${id}--${WORKFLOW_AGENT}`, session_id: id, parent_session: id, collection: 'bb2dash-notes',
        repo: '', branch: '', cwd: `${folder}/${id}/subagents/workflows/wf-9`, agent_type: 'workflow', tags: ['unclassified'],
        files_modified: [`${home}/projects/bb2dash-notes/notes.md`],
      }));
      return { id, relative };
    });
    const before = hashTree(sandbox.vault);
    const dry = runBackfill(formerOptions(sandbox, { dryRun: true }));
    const real = runBackfill(formerOptions(sandbox, { dryRun: false }));
    const after = hashTree(sandbox.vault);
    for (const { id, relative } of siblings) {
      for (const run of [dry, real]) assert.ok(!run.lines.some((line) => line.startsWith(`${id}--`)), `${id}: no change line`);
      assert.equal(after[relative], before[relative], `${relative} is unchanged`);
    }
  } finally {
    sandbox.cleanup();
  }
});

test('the former-home report projects no underivable bb2dash repo and no absolute path', () => {
  const sandbox = createHomesSandbox();
  try {
    buildFormerHomeVault(sandbox);
    const { report } = runBackfill(formerOptions(sandbox, { dryRun: true }));
    assert.equal(report.repo_empty_underivable, 3, 'only the two notes that are not bb2dash and the -wt- orphan');
    assert.equal(report.absolute_files_modified, 0);
  } finally {
    sandbox.cleanup();
  }
});

test('the CLI: --dry-run --report --json --no-network prints the report and writes nothing', () => {
  withSandbox((sandbox) => {
    buildVault(sandbox);
    const before = hashTree(sandbox.vault);
    const run = spawnSync(process.execPath, [
      CLI, '--vault', sandbox.vault, '--backup', sandbox.backup, '--dry-run', '--report', '--json', '--no-network',
      '--repo', `bb2dash=${sandbox.checkout}`,
    ], { encoding: 'utf8', env: { ...process.env, HOME: sandbox.home, USERPROFILE: sandbox.home, HARNESS_REDACT_EXTRA: '', HARNESS_MACHINE_ENV: `${sandbox.home}/no-machine.env` } });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.deepEqual(Object.keys(report), [...REPORT_KEYS]);
    assert.ok(report.changes > 0);
    assert.deepEqual(hashTree(sandbox.vault), before);
  });
});

test('the CLI refuses a real run without --backup, and an unknown flag', () => {
  withSandbox((sandbox) => {
    const noBackup = spawnSync(process.execPath, [CLI, '--vault', sandbox.vault], { encoding: 'utf8' });
    assert.equal(noBackup.status, 1);
    assert.match(noBackup.stderr, /--backup/);
    const unknown = spawnSync(process.execPath, [CLI, '--vault', sandbox.vault, '--dry-run', '--frobnicate'], { encoding: 'utf8' });
    assert.equal(unknown.status, 1);
  });
});
