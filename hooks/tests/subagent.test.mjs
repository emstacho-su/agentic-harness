/**
 * Subagent capture, and the parent/child linkage.
 *
 * A worker launched with the Agent tool shares its parent's `session_id` and
 * never fires `SessionEnd`, so its work used to vanish into the parent's note
 * as a handful of file paths. `SubagentStop` gives it a note of its own.
 *
 * The linkage has to hold in both event orders, because both really happen: a
 * worker usually stops long before the session that spawned it, but a session
 * captured earlier can already have a note when a later worker stops.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseFrontmatter } from '../lib/frontmatter.mjs';
import { looksRedacted } from '../lib/redact.mjs';
import { parentPlacement } from '../lib/subagent.mjs';
import { collectionsHolding, createSandbox, installTranscript, readNote, toPosix } from './helpers/sandbox.mjs';
import { SCENARIOS, runScenario, runSubagentStop } from './helpers/scenarios.mjs';

const PARENT = SCENARIOS.find((scenario) => scenario.name === 'subagent-parent');
const SESSION_ID = '88888888-8888-4888-8888-888888888888';
const SESSIONS = 'projects/bb2dash/sessions';
const PARENT_NOTE = `${SESSIONS}/${SESSION_ID}.md`;
const WORKER_ONE = `${SESSIONS}/${SESSION_ID}--c0ffee01.md`;
const WORKER_TWO = `${SESSIONS}/${SESSION_ID}--c0ffee02.md`;

function fieldsAt(sandbox, relativePath) {
  const parsed = parseFrontmatter(fs.readFileSync(path.join(sandbox.vaultRoot, relativePath), 'utf8'));
  assert.equal(parsed.ok, true, parsed.error);
  return parsed.fields;
}

function installParent(sandbox) {
  return installTranscript(sandbox, PARENT.fixture, SESSION_ID);
}

function stop(sandbox, transcriptPath, agentId, agentType) {
  return runSubagentStop(sandbox, {
    sessionId: SESSION_ID,
    agentId,
    agentType,
    cwd: PARENT.cwd,
    transcriptPath,
  });
}

test('a worker gets its own note, named and identified by session and agent', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    const outcome = stop(sandbox, transcriptPath, 'c0ffee01', 'general-purpose');
    assert.equal(outcome.written, true, `${outcome.action}: ${outcome.skip}`);

    const child = fieldsAt(sandbox, WORKER_ONE);
    assert.equal(child.id, `session-${SESSION_ID}--c0ffee01`);
    assert.equal(child.session_id, SESSION_ID);
    assert.equal(child.parent_session, SESSION_ID);
    assert.equal(child.agent, 'claude-code');
    assert.equal(child.agent_type, 'general-purpose');
    assert.equal(child.status, 'concluded');
    assert.equal(child.schema_version, 2);

    // Derived exactly as a session is: same repo, same branch, same rules.
    assert.equal(child.collection, 'bb2dash');
    assert.equal(child.collection_source, 'git');
    assert.equal(child.repo, 'emstacho-su/bb2dash');
    assert.equal(child.branch, 'feat/phase7-retrieval');
    assert.ok(child.files_modified.includes('web/src/lib/retrieval/filter.ts'));
    assert.ok(child.tags.length > 0);
  } finally {
    sandbox.cleanup();
  }
});

test('the agent id is normalised, so both spellings name one note', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    stop(sandbox, transcriptPath, 'c0ffee01', 'general-purpose');
    const outcome = stop(sandbox, transcriptPath, 'agent-c0ffee01', 'general-purpose');

    assert.equal(outcome.action, 'merge', 'the prefixed form must find the same note');
    const notes = fs.readdirSync(path.join(sandbox.vaultRoot, SESSIONS));
    assert.equal(notes.filter((name) => name.includes('c0ffee01')).length, 1);
  } finally {
    sandbox.cleanup();
  }
});

test('the parent back-fills child_sessions when it is captured last', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);

    // Both workers stop first — the ordinary case.
    stop(sandbox, transcriptPath, 'c0ffee01', 'general-purpose');
    stop(sandbox, transcriptPath, 'c0ffee02', 'feature-dev:code-reviewer');
    assert.equal(fs.existsSync(path.join(sandbox.vaultRoot, PARENT_NOTE)), false);

    runScenario(sandbox, PARENT);

    const parent = fieldsAt(sandbox, PARENT_NOTE);
    const one = fieldsAt(sandbox, WORKER_ONE);
    const two = fieldsAt(sandbox, WORKER_TWO);

    assert.deepEqual(parent.child_sessions, [one.id, two.id]);
    assert.equal(one.parent_session, parent.session_id);
    assert.equal(two.parent_session, parent.session_id);
  } finally {
    sandbox.cleanup();
  }
});

test('a worker that stops after its parent is linked into the existing note', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);

    // The parent is captured first, and its back-fill already lists both
    // workers from the subagents directory.
    runScenario(sandbox, PARENT);
    const before = fieldsAt(sandbox, PARENT_NOTE);
    assert.equal(before.child_sessions.length, 2);

    const outcome = stop(sandbox, transcriptPath, 'c0ffee01', 'general-purpose');
    assert.match(outcome.detail, /parent=already linked/);

    // And a worker the back-fill could not have seen is appended, not lost.
    fs.writeFileSync(
      path.join(sandbox.transcriptsDir, SESSION_ID, 'subagents', 'agent-c0ffee03.jsonl'),
      fs.readFileSync(path.join(sandbox.transcriptsDir, SESSION_ID, 'subagents', 'agent-c0ffee01.jsonl'), 'utf8'),
      'utf8',
    );
    const late = stop(sandbox, transcriptPath, 'c0ffee03', 'general-purpose');
    assert.match(late.detail, /parent=linked/);

    const after = fieldsAt(sandbox, PARENT_NOTE);
    assert.equal(after.child_sessions.length, 3);
    assert.ok(after.child_sessions.includes(`session-${SESSION_ID}--c0ffee03`));
    // The two the back-fill found are still there: lists grow, they do not swap.
    for (const id of before.child_sessions) assert.ok(after.child_sessions.includes(id));
  } finally {
    sandbox.cleanup();
  }
});

test('a worker with no prompt of its own is captured from the parent Agent call', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    // agent-c0ffee02's transcript has tool use and no user turn at all.
    const outcome = stop(sandbox, transcriptPath, 'c0ffee02', 'feature-dev:code-reviewer');
    assert.equal(outcome.written, true, `${outcome.action}: ${outcome.skip}`);

    const note = readNote(sandbox, WORKER_TWO);
    assert.match(note, /## What I asked for/);
    assert.match(note, /Review the migration/, 'the task came from the meta file beside the transcript');
    assert.equal(fieldsAt(sandbox, WORKER_TWO).agent_type, 'feature-dev:code-reviewer');
  } finally {
    sandbox.cleanup();
  }
});

test("a worker's note is redacted like any other", () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    stop(sandbox, transcriptPath, 'c0ffee01', 'general-purpose');

    const note = readNote(sandbox, WORKER_ONE);
    assert.ok(looksRedacted(note), 'a credential shape survived into the worker note');
    assert.ok(!note.includes('sb_secret_9aQZ1kLmNOPqrstuvwxyz0123456789ab'));
    assert.match(note, /\[REDACTED-KEY\]/);
  } finally {
    sandbox.cleanup();
  }
});

test('an unknown agent, or one that did nothing, is a logged skip', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);

    const missing = stop(sandbox, transcriptPath, 'deadbeef', 'general-purpose');
    assert.equal(missing.written, false);
    assert.match(missing.skip, /no subagent transcript/);

    const noId = stop(sandbox, transcriptPath, '', 'general-purpose');
    assert.equal(noId.written, false);
    assert.match(noId.skip, /no agent_id/);

    fs.writeFileSync(
      path.join(sandbox.transcriptsDir, SESSION_ID, 'subagents', 'agent-c0ffee09.jsonl'),
      '',
      'utf8',
    );
    const empty = stop(sandbox, transcriptPath, 'c0ffee09', 'general-purpose');
    assert.equal(empty.written, false);
    assert.match(empty.skip, /unreadable or empty/);
  } finally {
    sandbox.cleanup();
  }
});

test('a worker hands the ingest its own note, and the parent when it linked one', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);

    // No parent note yet: there is nothing to link into, so one note.
    const alone = stop(sandbox, transcriptPath, 'c0ffee01', 'general-purpose');
    assert.deepEqual(alone.touchedPaths, [path.join(sandbox.vaultRoot, WORKER_ONE)]);

    // With the parent note present, the link edits it — and `child_sessions` is
    // frontmatter, so the ingest has to be told about the parent as well.
    runScenario(sandbox, PARENT);
    fs.writeFileSync(
      path.join(sandbox.transcriptsDir, SESSION_ID, 'subagents', 'agent-c0ffee03.jsonl'),
      fs.readFileSync(
        path.join(sandbox.transcriptsDir, SESSION_ID, 'subagents', 'agent-c0ffee01.jsonl'),
        'utf8',
      ),
      'utf8',
    );
    const late = stop(sandbox, transcriptPath, 'c0ffee03', 'general-purpose');

    assert.deepEqual(late.touchedPaths, [
      path.join(sandbox.vaultRoot, `${SESSIONS}/${SESSION_ID}--c0ffee03.md`),
      path.join(sandbox.vaultRoot, PARENT_NOTE),
    ]);
  } finally {
    sandbox.cleanup();
  }
});

test('the same worker stopping twice with nothing new to say enqueues nothing', () => {
  // SubagentStop fires at every stop point of a multi-turn worker, not once at
  // the end. When the transcript has not grown, the note re-renders to exactly
  // the bytes already on disk, and a second ingest would start a process and
  // load a 130 MB model to re-confirm a hash it already knows.
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);

    const first = stop(sandbox, transcriptPath, 'c0ffee01', 'general-purpose');
    assert.equal(first.touchedPaths.length, 1);
    const before = fs.readFileSync(path.join(sandbox.vaultRoot, WORKER_ONE), 'utf8');

    const second = stop(sandbox, transcriptPath, 'c0ffee01', 'general-purpose');

    assert.equal(second.written, true);
    assert.equal(second.action, 'merge');
    assert.deepEqual(second.touchedPaths, []);
    assert.match(second.detail, /identical on disk/);
    assert.equal(fs.readFileSync(path.join(sandbox.vaultRoot, WORKER_ONE), 'utf8'), before);
  } finally {
    sandbox.cleanup();
  }
});

// ------------------------------------------------ where a worker is filed
//
// 2026-09-24: eight worker notes on the live vault were filed twice. The hook
// placed a worker by the directory it had `cd`'d to when it stopped (the vault,
// the home folder, another repo); the sweep placed the same worker beside its
// parent. A worker belongs to its session, so it files where the session does.

const VAULT_SESSIONS = 'projects/vault/sessions';
const VAULT_CWD = '__SANDBOX__/vault';

function stopIn(sandbox, transcriptPath, agentId, cwd, log = undefined) {
  return runSubagentStop(sandbox, { sessionId: SESSION_ID, agentId, agentType: 'general-purpose', cwd, transcriptPath, log });
}

/** A worker note as an older hook filed it: under the folder the worker stopped in. */
function writeStray(sandbox, agentId, text) {
  const notePath = path.join(sandbox.vaultRoot, VAULT_SESSIONS, `${SESSION_ID}--${agentId}.md`);
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(notePath, text, 'utf8');
  return notePath;
}

const STRAY_NOTE = [
  '---',
  `id: "session-${SESSION_ID}--c0ffee01"`,
  'collection: "vault"',
  'collection_source: "folder"',
  `session_id: "${SESSION_ID}"`,
  'status: "concluded"',
  `parent_session: "${SESSION_ID}"`,
  '---',
  '',
  '# Earlier note',
  '',
].join('\n');

/** Frontmatter the parser refuses: a note somebody hand-edited into a shape it does not know. */
const BROKEN_NOTE = '---\ntags: [unterminated\n---\n\n# hand-edited\n';

test("a worker that cd'd into the vault is filed under its parent's collection, by the parent transcript's cwd", () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    const outcome = stopIn(sandbox, transcriptPath, 'c0ffee01', VAULT_CWD);
    assert.equal(outcome.written, true, `${outcome.action}: ${outcome.skip}`);

    const child = fieldsAt(sandbox, WORKER_ONE);
    assert.equal(child.collection, 'bb2dash');
    assert.equal(child.collection_source, 'git');
    // The repository follows the worker's declared cwd, never the vault it stopped in.
    assert.equal(child.repo, 'emstacho-su/bb2dash');
    assert.equal(child.branch, 'feat/phase7-retrieval');
    // Where the worker actually was stays on the note: that is provenance.
    assert.equal(child.cwd, `${sandbox.root}/vault`);
    assert.deepEqual(collectionsHolding(sandbox.vaultRoot, `${SESSION_ID}--c0ffee01.md`), ['projects/bb2dash']);
    assert.equal(fs.existsSync(path.join(sandbox.vaultRoot, 'projects', 'vault')), false, 'no folder-named collection was grown');
  } finally {
    sandbox.cleanup();
  }
});

/** Rewrite a worker transcript with every record's `cwd` removed. */
function stripCwd(transcriptPath) {
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  const stripped = lines.map((line) => {
    const { cwd: _dropped, ...rest } = JSON.parse(line);
    return JSON.stringify(rest);
  });
  fs.writeFileSync(transcriptPath, `${stripped.join('\n')}\n`, 'utf8');
}

test("a worker whose parent transcript says nothing files by its own transcript's cwd, then by its stdin cwd", () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);

    // No parent transcript at all: the worker's own transcript declares bb2dash.
    fs.rmSync(transcriptPath);
    const gone = stopIn(sandbox, transcriptPath, 'c0ffee01', VAULT_CWD);
    assert.equal(gone.written, true, `${gone.action}: ${gone.skip}`);
    const orphan = fieldsAt(sandbox, WORKER_ONE);
    assert.equal(orphan.collection, 'bb2dash');
    assert.equal(orphan.collection_source, 'git');
    assert.equal(orphan.cwd, `${sandbox.root}/vault`, 'the stdin cwd stays on the note as provenance');

    // A parent head with no cwd, and a worker transcript that declares none
    // either: only then does the worker's stdin cwd decide.
    fs.writeFileSync(transcriptPath, '{"type":"user","message":{"role":"user","content":"hi"}}\n', 'utf8');
    stripCwd(path.join(sandbox.transcriptsDir, SESSION_ID, 'subagents', 'agent-c0ffee02.jsonl'));
    stopIn(sandbox, transcriptPath, 'c0ffee02', '__SANDBOX__/repos/agentic-harness');
    const fallback = fieldsAt(sandbox, `projects/agentic-harness/sessions/${SESSION_ID}--c0ffee02.md`);
    assert.equal(fallback.collection, 'agentic-harness');
    assert.equal(fallback.collection_source, 'git');
  } finally {
    sandbox.cleanup();
  }
});

test('a note already filed for this worker in another collection is merged there, never copied', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    // What an older hook left: the worker filed under the folder it stopped in.
    const earlier = path.join(sandbox.vaultRoot, VAULT_SESSIONS, `${SESSION_ID}--c0ffee01.md`);
    fs.mkdirSync(path.dirname(earlier), { recursive: true });
    fs.writeFileSync(
      earlier,
      [
        '---',
        `id: "session-${SESSION_ID}--c0ffee01"`,
        'collection: "vault"',
        'collection_source: "folder"',
        `session_id: "${SESSION_ID}"`,
        'status: "concluded"',
        `cwd: "${sandbox.root}/vault"`,
        'tags:',
        '  - "kept-by-hand"',
        `parent_session: "${SESSION_ID}"`,
        '---',
        '',
        '# Earlier note',
        '',
      ].join('\n'),
      'utf8',
    );

    const outcome = stopIn(sandbox, transcriptPath, 'c0ffee01', '__SANDBOX__/repos/bb2dash');
    assert.equal(outcome.action, 'merge', `${outcome.action}: ${outcome.skip}`);
    assert.equal(outcome.notePath, earlier);
    assert.deepEqual(collectionsHolding(sandbox.vaultRoot, `${SESSION_ID}--c0ffee01.md`), ['projects/vault']);

    const merged = fieldsAt(sandbox, `${VAULT_SESSIONS}/${SESSION_ID}--c0ffee01.md`);
    // The note keeps describing the folder it sits in.
    assert.equal(merged.collection, 'vault');
    assert.equal(merged.collection_source, 'folder');
    assert.ok(merged.tags.includes('kept-by-hand'), 'a merge, not a rewrite');
    assert.ok(merged.files_modified.includes('web/src/lib/retrieval/filter.ts'));
    // Its link still points where the parent files, not at the folder it sits in.
    assert.equal(merged.up, `[[projects/bb2dash/sessions/${SESSION_ID}|2026-09-16 · bb2dash]]`);
  } finally {
    sandbox.cleanup();
  }
});

test('a stray copy beside the home copy is logged by name, and only the home copy is merged', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    assert.equal(stopIn(sandbox, transcriptPath, 'c0ffee01', VAULT_CWD).action, 'create');
    const stray = writeStray(sandbox, 'c0ffee01', STRAY_NOTE);

    const lines = [];
    const outcome = stopIn(sandbox, transcriptPath, 'c0ffee01', VAULT_CWD, (line) => lines.push(line));

    assert.equal(outcome.action, 'merge', `${outcome.action}: ${outcome.skip}`);
    assert.equal(outcome.notePath, path.join(sandbox.vaultRoot, WORKER_ONE));
    const name = `${SESSION_ID}--c0ffee01.md`;
    assert.deepEqual(lines, [`duplicate worker note left at ${VAULT_SESSIONS}/${name}; merged into ${WORKER_ONE}`]);
    assert.equal(fs.readFileSync(stray, 'utf8'), STRAY_NOTE, 'a stray is reported, never deleted or rewritten');
  } finally {
    sandbox.cleanup();
  }
});

test('an unreadable stray does not block capture: the worker is written beside its parent', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    const stray = writeStray(sandbox, 'c0ffee01', BROKEN_NOTE);

    const lines = [];
    const outcome = stopIn(sandbox, transcriptPath, 'c0ffee01', VAULT_CWD, (line) => lines.push(line));

    assert.equal(outcome.written, true, `${outcome.action}: ${outcome.skip}`);
    assert.equal(outcome.action, 'create');
    assert.equal(outcome.notePath, path.join(sandbox.vaultRoot, WORKER_ONE));
    const name = `${SESSION_ID}--c0ffee01.md`;
    assert.deepEqual(lines, [`existing note unreadable at ${VAULT_SESSIONS}/${name}; writing beside the parent`]);
    assert.equal(fs.readFileSync(stray, 'utf8'), BROKEN_NOTE, 'the hand-edited note is left alone');
  } finally {
    sandbox.cleanup();
  }
});

test('an unreadable note at the home path is never overwritten, as for a session note', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    const home = path.join(sandbox.vaultRoot, WORKER_TWO);
    fs.writeFileSync(home, BROKEN_NOTE, 'utf8');

    const outcome = stopIn(sandbox, transcriptPath, 'c0ffee02', VAULT_CWD);
    assert.equal(outcome.written, false);
    assert.match(outcome.skip, /existing note unreadable/);
    assert.equal(fs.readFileSync(home, 'utf8'), BROKEN_NOTE);
  } finally {
    sandbox.cleanup();
  }
});

test("a worker is linked into the head of its parent's resume chain, never the superseded base", () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    const note = (suffix, status) =>
      ['---', `id: "session-${SESSION_ID}${suffix}"`, `session_id: "${SESSION_ID}"`, `status: "${status}"`, '---', '', `# ${status}`, ''].join('\n');
    const basePath = path.join(sandbox.vaultRoot, PARENT_NOTE);
    const headPath = path.join(sandbox.vaultRoot, `${SESSIONS}/${SESSION_ID}-r2.md`);
    fs.writeFileSync(basePath, note('', 'superseded'), 'utf8');
    fs.writeFileSync(headPath, note('-r2', 'active'), 'utf8');

    const outcome = stop(sandbox, transcriptPath, 'c0ffee01', 'general-purpose');

    assert.match(outcome.detail, /parent=linked/);
    assert.deepEqual(fieldsAt(sandbox, `${SESSIONS}/${SESSION_ID}-r2.md`).child_sessions, [`session-${SESSION_ID}--c0ffee01`]);
    assert.equal(fs.readFileSync(basePath, 'utf8'), note('', 'superseded'), 'the superseded base is untouched');
    assert.ok(outcome.touchedPaths.includes(headPath));
    assert.ok(!outcome.touchedPaths.includes(basePath));
  } finally {
    sandbox.cleanup();
  }
});

test('the parent transcript is read once per distinct file, and the worker transcript never', () => {
  const sandbox = createSandbox();
  try {
    const dir = toPosix(sandbox.transcriptsDir);
    const agent = `${dir}/${SESSION_ID}/subagents/agent-c0ffee01.jsonl`;
    const parentFile = `${dir}/${SESSION_ID}.jsonl`;
    const windows = (file) => file.replace(/\//g, '\\');
    const calls = [];
    const readHead = (file) => {
      calls.push(file);
      return { cwd: '', entrypoint: '' };
    };
    const place = (transcriptPath) =>
      parentPlacement({ input: { sessionId: SESSION_ID, transcriptPath }, agentTranscriptPath: agent, vaultRoot: sandbox.vaultRoot, readHead });

    // The payload names the parent transcript in Windows spelling: one file, one read.
    assert.equal(place(windows(parentFile)), null);
    assert.deepEqual(calls, [parentFile]);

    // The payload names the worker's own transcript: it is not a parent candidate.
    calls.length = 0;
    assert.equal(place(windows(agent)), null);
    assert.deepEqual(calls, [parentFile]);
  } finally {
    sandbox.cleanup();
  }
});

// ------------------------------------------------ the link up to the parent
//
// 2026-09-24: a worker's bare `up: [[<parent-uuid>]]`, followed in Obsidian
// before the parent note existed, created an empty note at the vault root.
// The link now carries the parent's path, so a click creates the file where
// the hook will write it, and the hook writes over that empty file.

const PARENT_LINK = `projects/bb2dash/sessions/${SESSION_ID}`;
const SEP = ' · ';

test("a worker whose parent has no note yet links up by path, labelled with the parent's start date and collection", () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    stop(sandbox, transcriptPath, 'c0ffee01', 'general-purpose');
    // The parent transcript's first record is 2026-09-16T09:00:00Z.
    assert.equal(fieldsAt(sandbox, WORKER_ONE).up, `[[${PARENT_LINK}|2026-09-16${SEP}bb2dash]]`);
  } finally {
    sandbox.cleanup();
  }
});

test("a worker whose parent note exists is labelled with the parent's title, made safe for a link", () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    const parent = ['---', `id: "session-${SESSION_ID}"`, `session_id: "${SESSION_ID}"`, 'title: "Parent [draft] | notes"', '---', '', '# parent', ''].join('\n');
    fs.writeFileSync(path.join(sandbox.vaultRoot, PARENT_NOTE), parent, 'utf8');

    const outcome = stop(sandbox, transcriptPath, 'c0ffee01', 'general-purpose');
    assert.match(outcome.detail, /parent=linked/, 'the one read of the parent serves both the title and the link');
    assert.equal(fieldsAt(sandbox, WORKER_ONE).up, `[[${PARENT_LINK}|Parent draft notes]]`);
  } finally {
    sandbox.cleanup();
  }
});

test("a worker with no readable parent transcript is labelled with its own date", () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    fs.rmSync(transcriptPath);
    stopIn(sandbox, transcriptPath, 'c0ffee01', VAULT_CWD);
    const child = fieldsAt(sandbox, WORKER_ONE);
    assert.equal(child.up, `[[${PARENT_LINK}|${child.date}${SEP}bb2dash]]`);
  } finally {
    sandbox.cleanup();
  }
});

test('parentPlacement reports when the parent session started, beside where it files', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    const agent = path.join(sandbox.transcriptsDir, SESSION_ID, 'subagents', 'agent-c0ffee01.jsonl');
    const placed = parentPlacement({ input: { sessionId: SESSION_ID, transcriptPath }, agentTranscriptPath: agent, vaultRoot: sandbox.vaultRoot });
    assert.equal(placed.collection, 'bb2dash');
    assert.equal(placed.timestamp, '2026-09-16T09:00:00.000Z');
  } finally {
    sandbox.cleanup();
  }
});

test('an empty file Obsidian made at the parent path is left for the parent, which then writes over it', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    const parentPath = path.join(sandbox.vaultRoot, PARENT_NOTE);
    fs.writeFileSync(parentPath, '', 'utf8');

    const outcome = stop(sandbox, transcriptPath, 'c0ffee01', 'general-purpose');
    assert.match(outcome.detail, /parent=not yet written/);
    assert.equal(fs.readFileSync(parentPath, 'utf8'), '', 'a worker never writes the parent note');
    assert.equal(fieldsAt(sandbox, WORKER_ONE).up, `[[${PARENT_LINK}|2026-09-16${SEP}bb2dash]]`);

    const parent = runScenario(sandbox, PARENT);
    assert.equal(parent.action, 'create', `${parent.action}: ${parent.skip}`);
    assert.match(parent.detail, /\(replaced stub\)/);
    assert.ok(fieldsAt(sandbox, PARENT_NOTE).child_sessions.includes(`session-${SESSION_ID}--c0ffee01`));
  } finally {
    sandbox.cleanup();
  }
});

test("an empty file at the worker's own path is written over, and the log says so", () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    const home = path.join(sandbox.vaultRoot, WORKER_ONE);
    fs.writeFileSync(home, '', 'utf8');

    const outcome = stop(sandbox, transcriptPath, 'c0ffee01', 'general-purpose');
    assert.equal(outcome.action, 'create', `${outcome.action}: ${outcome.skip}`);
    assert.match(outcome.detail, /\(replaced stub\)$/);
    assert.equal(fieldsAt(sandbox, WORKER_ONE).parent_session, SESSION_ID);
  } finally {
    sandbox.cleanup();
  }
});

test('an empty stray is not claimed: the worker is written beside its parent', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    const stray = writeStray(sandbox, 'c0ffee01', '');

    const lines = [];
    const outcome = stopIn(sandbox, transcriptPath, 'c0ffee01', VAULT_CWD, (line) => lines.push(line));

    assert.equal(outcome.action, 'create', `${outcome.action}: ${outcome.skip}`);
    assert.equal(outcome.notePath, path.join(sandbox.vaultRoot, WORKER_ONE));
    const name = `${SESSION_ID}--c0ffee01.md`;
    assert.deepEqual(lines, [`empty stray left at ${VAULT_SESSIONS}/${name}; writing beside the parent`]);
    assert.equal(fs.readFileSync(stray, 'utf8'), '', 'the stray is reported, never deleted or rewritten');
  } finally {
    sandbox.cleanup();
  }
});

test('an agent id that is not a safe filename never reaches a path', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    const outcome = stop(sandbox, transcriptPath, '../../../../escape', 'general-purpose');
    assert.equal(outcome.written, false);
    // It is refused as a missing transcript, which is the safe end of the same
    // road: no path was ever built from it.
    assert.equal(fs.existsSync(path.join(sandbox.root, 'escape.md')), false);
  } finally {
    sandbox.cleanup();
  }
});

// ------------------------------------- parent phase and repo (brief 101 H-1)
//
// A worker files under its PM's phase and repo. Its own branch speaks first; a
// worker whose own sources yield no phase takes the one the parent
// transcript's checkout branch yields, and one whose own cwd yields no repo
// takes the parent's. The workflow cwd is sandbox-rooted: the live spelling,
// `C:/Users/stack/.claude/projects/…`, would decode against the real disk.

const BB2DASH_REMOTE = 'https://github.com/emstacho-su/bb2dash.git';

/** A fake checkout beside the sandbox's own: `.git/config` and `HEAD` are all the hook reads. */
function addCheckout(sandbox, dir, head, remote = BB2DASH_REMOTE) {
  const gitDir = path.join(sandbox.root, dir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'config'), `[remote "origin"]\n\turl = ${remote}\n`, 'utf8');
  fs.writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${head}\n`, 'utf8');
  return `${sandbox.root}/${dir}`;
}

function checkoutBranch(sandbox, dir, head) {
  fs.writeFileSync(path.join(sandbox.root, dir, '.git', 'HEAD'), `ref: refs/heads/${head}\n`, 'utf8');
}

/** Rewrite a worker transcript as if it ran in `cwd` on `branch` (`''`: no branch recorded). */
function moveWorker(sandbox, agentId, cwd, branch) {
  const file = path.join(sandbox.transcriptsDir, SESSION_ID, 'subagents', `agent-${agentId}.jsonl`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const moved = lines.map((line) => {
    const { gitBranch: _branch, ...rest } = JSON.parse(line);
    return JSON.stringify({ ...rest, cwd, ...(branch ? { gitBranch: branch } : {}) });
  });
  fs.writeFileSync(file, `${moved.join('\n')}\n`, 'utf8');
}

test("a worker on main under a fix/page-pass-12b parent takes the parent's phase-12b", () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    checkoutBranch(sandbox, 'repos/bb2dash', 'fix/page-pass-12b');
    const workerCwd = addCheckout(sandbox, 'repos/bb2dash-main', 'main');
    moveWorker(sandbox, 'c0ffee01', workerCwd, 'main');

    const outcome = stopIn(sandbox, transcriptPath, 'c0ffee01', workerCwd);
    assert.equal(outcome.written, true, `${outcome.action}: ${outcome.skip}`);

    const child = fieldsAt(sandbox, WORKER_ONE);
    assert.equal(child.branch, 'main', 'the branch stays the worker’s own');
    assert.equal(child.phase, 'phase-12b');
    assert.equal(child.tags[0], 'phase-12b', 'the inherited phase takes the first tag slot');
    assert.ok(child.tags.length <= 5);
    assert.match(readNote(sandbox, WORKER_ONE), /\| Phase \| phase-12b \|/);
  } finally {
    sandbox.cleanup();
  }
});

test('a worker on feat/db-hygiene-15-runner keeps its own phase-15 under a parent in another phase', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    checkoutBranch(sandbox, 'repos/bb2dash', 'fix/page-pass-12b');
    const workerCwd = addCheckout(sandbox, 'repos/bb2dash-wt-runner', 'feat/db-hygiene-15-runner');
    moveWorker(sandbox, 'c0ffee01', workerCwd, 'feat/db-hygiene-15-runner');

    const outcome = stopIn(sandbox, transcriptPath, 'c0ffee01', workerCwd);
    assert.equal(outcome.written, true, `${outcome.action}: ${outcome.skip}`);

    const child = fieldsAt(sandbox, WORKER_ONE);
    assert.equal(child.phase, 'phase-15');
    assert.ok(child.tags.includes('phase-15'));
    assert.ok(!child.tags.includes('phase-12b'));
  } finally {
    sandbox.cleanup();
  }
});

test("a workflow worker whose cwd is a Claude Code folder takes the parent transcript's repo", () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    const workflowDir = `home/.claude/projects/C--Users-stack-projects-bb2dash/${SESSION_ID}/subagents/workflows/wf-1`;
    fs.mkdirSync(path.join(sandbox.root, workflowDir), { recursive: true });
    const workerCwd = `${sandbox.root}/${workflowDir}`;
    moveWorker(sandbox, 'c0ffee01', workerCwd, '');

    const outcome = stopIn(sandbox, transcriptPath, 'c0ffee01', workerCwd);
    assert.equal(outcome.written, true, `${outcome.action}: ${outcome.skip}`);

    const child = fieldsAt(sandbox, WORKER_ONE);
    assert.equal(child.cwd, workerCwd, 'where the worker ran stays on the note');
    assert.equal(child.repo, 'emstacho-su/bb2dash');
    assert.equal(child.collection, 'bb2dash');
    // The parent's checkout is on feat/phase7-retrieval, so its phase comes too.
    assert.equal(child.phase, 'phase-7');
    assert.match(readNote(sandbox, WORKER_ONE), /\| Repo \| emstacho-su\/bb2dash \|/);
  } finally {
    sandbox.cleanup();
  }
});

test("a worker with no phase of its own under a parent with none stays phase ''", () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    checkoutBranch(sandbox, 'repos/bb2dash', 'main');
    const workerCwd = addCheckout(sandbox, 'repos/bb2dash-main', 'main');
    moveWorker(sandbox, 'c0ffee01', workerCwd, 'main');

    stopIn(sandbox, transcriptPath, 'c0ffee01', workerCwd);
    const child = fieldsAt(sandbox, WORKER_ONE);
    assert.equal(child.phase, '');
    assert.ok(!child.tags.some((tag) => /^phase-\d/.test(tag)));
  } finally {
    sandbox.cleanup();
  }
});

test('parentPlacement reports the repo and the phase the parent checkout yields', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    checkoutBranch(sandbox, 'repos/bb2dash', 'feat/grades-10a');
    const agent = path.join(sandbox.transcriptsDir, SESSION_ID, 'subagents', 'agent-c0ffee01.jsonl');
    const placed = parentPlacement({ input: { sessionId: SESSION_ID, transcriptPath }, agentTranscriptPath: agent, vaultRoot: sandbox.vaultRoot });
    assert.equal(placed.repo, 'emstacho-su/bb2dash');
    assert.equal(placed.phase, 'phase-10a');
  } finally {
    sandbox.cleanup();
  }
});
