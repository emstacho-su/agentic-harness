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
import { createSandbox, installTranscript, readNote } from './helpers/sandbox.mjs';
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

function stopIn(sandbox, transcriptPath, agentId, cwd) {
  return runSubagentStop(sandbox, { sessionId: SESSION_ID, agentId, agentType: 'general-purpose', cwd, transcriptPath });
}

/** Every copy of a note with this filename, anywhere in the sandbox vault. */
function copiesOf(sandbox, filename) {
  const found = [];
  for (const area of ['projects', 'classes']) {
    const areaDir = path.join(sandbox.vaultRoot, area);
    for (const collection of fs.readdirSync(areaDir)) {
      if (fs.existsSync(path.join(areaDir, collection, 'sessions', filename))) found.push(`${area}/${collection}`);
    }
  }
  return found;
}

test("a worker that cd'd into the vault is filed under its parent's collection, by the parent transcript's cwd", () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);
    const outcome = stopIn(sandbox, transcriptPath, 'c0ffee01', VAULT_CWD);
    assert.equal(outcome.written, true, `${outcome.action}: ${outcome.skip}`);

    const child = fieldsAt(sandbox, WORKER_ONE);
    assert.equal(child.collection, 'bb2dash');
    assert.equal(child.collection_source, 'git');
    // Where the worker actually was stays on the note: that is provenance.
    assert.equal(child.cwd, `${sandbox.root}/vault`);
    assert.deepEqual(copiesOf(sandbox, `${SESSION_ID}--c0ffee01.md`), ['projects/bb2dash']);
    assert.equal(fs.existsSync(path.join(sandbox.vaultRoot, 'projects', 'vault')), false, 'no folder-named collection was grown');
  } finally {
    sandbox.cleanup();
  }
});

test('a worker whose parent transcript cannot be read, or declares no cwd, falls back to its own directory', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installParent(sandbox);

    // No parent transcript at all: today's rule, the worker's own cwd.
    fs.rmSync(transcriptPath);
    const gone = stopIn(sandbox, transcriptPath, 'c0ffee01', VAULT_CWD);
    assert.equal(gone.written, true, `${gone.action}: ${gone.skip}`);
    const orphan = fieldsAt(sandbox, `${VAULT_SESSIONS}/${SESSION_ID}--c0ffee01.md`);
    assert.equal(orphan.collection, 'vault');
    assert.equal(orphan.collection_source, 'folder');

    // A parent transcript whose head carries no cwd: the same fallback.
    fs.writeFileSync(transcriptPath, '{"type":"user","message":{"role":"user","content":"hi"}}\n', 'utf8');
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
    assert.deepEqual(copiesOf(sandbox, `${SESSION_ID}--c0ffee01.md`), ['projects/vault']);

    const merged = fieldsAt(sandbox, `${VAULT_SESSIONS}/${SESSION_ID}--c0ffee01.md`);
    // The note keeps describing the folder it sits in.
    assert.equal(merged.collection, 'vault');
    assert.equal(merged.collection_source, 'folder');
    assert.ok(merged.tags.includes('kept-by-hand'), 'a merge, not a rewrite');
    assert.ok(merged.files_modified.includes('web/src/lib/retrieval/filter.ts'));
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
