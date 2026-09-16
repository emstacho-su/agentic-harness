/**
 * The resume chain and the status ratchet (R-27.2).
 *
 * Four behaviours, all of them things the v1 hook got wrong:
 *   - a session that ends is `concluded`, with `concluded_at`;
 *   - replaying a stale `SessionEnd` over a concluded note writes nothing;
 *   - a resume after that starts a *new* note that names what it continues,
 *     and the note it continues becomes `superseded`;
 *   - a tag Stack typed into the note survives all of it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseFrontmatter, serializeFrontmatter } from '../lib/frontmatter.mjs';
import { createSandbox } from './helpers/sandbox.mjs';
import { runScenario } from './helpers/scenarios.mjs';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const SESSIONS_DIR = 'projects/agentic-harness/sessions';
const FIRST_NOTE = `${SESSIONS_DIR}/${SESSION_ID}.md`;
const RESUMED_NOTE = `${SESSIONS_DIR}/${SESSION_ID}-r2.md`;

function scenario(fixture, reason) {
  return {
    fixture,
    sessionId: SESSION_ID,
    cwd: '__SANDBOX__/repos/agentic-harness',
    reason,
    note: FIRST_NOTE,
  };
}

function readFields(sandbox, relativePath) {
  const raw = fs.readFileSync(path.join(sandbox.vaultRoot, relativePath), 'utf8');
  const parsed = parseFrontmatter(raw);
  assert.equal(parsed.ok, true, parsed.error);
  return parsed.fields;
}

/** Stand in for Stack opening the note in Obsidian and typing a tag. */
function addManualTag(sandbox, relativePath, tag) {
  const notePath = path.join(sandbox.vaultRoot, relativePath);
  const parsed = parseFrontmatter(fs.readFileSync(notePath, 'utf8'));
  const fields = { ...parsed.fields, tags: [...parsed.fields.tags, tag], reviewed_by: 'stack' };
  fs.writeFileSync(notePath, `${serializeFrontmatter(fields)}\n${parsed.body}`, 'utf8');
}

test('end, stale replay, resume: one concluded note, one superseded, chain intact', () => {
  const sandbox = createSandbox();
  try {
    // 1. The session ends.
    const first = runScenario(sandbox, scenario('resume-first', 'clear'));
    assert.equal(first.action, 'create');
    const afterFirst = readFields(sandbox, FIRST_NOTE);
    assert.equal(afterFirst.status, 'concluded');
    assert.equal(afterFirst.concluded_at, '2026-09-13T10:30:00.000Z');

    // 2. Stack tags it by hand.
    addManualTag(sandbox, FIRST_NOTE, 'needs-followup');

    // 3. A stale SessionEnd is replayed over it.
    const before = fs.readFileSync(path.join(sandbox.vaultRoot, FIRST_NOTE), 'utf8');
    const replay = runScenario(sandbox, scenario('resume-first', 'other'));
    assert.equal(replay.written, false);
    assert.equal(replay.action, 'noop');
    assert.equal(
      fs.readFileSync(path.join(sandbox.vaultRoot, FIRST_NOTE), 'utf8'),
      before,
      'a stale replay must not touch the note at all',
    );

    // 4. The session is resumed and ends again.
    const resumed = runScenario(sandbox, scenario('resume-second', 'logout'));
    assert.equal(resumed.action, 'resume');
    assert.ok(resumed.notePath.endsWith(`${SESSION_ID}-r2.md`), resumed.notePath);

    const successor = readFields(sandbox, RESUMED_NOTE);
    const predecessor = readFields(sandbox, FIRST_NOTE);

    assert.equal(successor.id, `session-${SESSION_ID}-r2`);
    assert.equal(successor.session_id, SESSION_ID);
    assert.equal(successor.status, 'concluded');
    assert.equal(successor.resumed_from, `session-${SESSION_ID}`);
    assert.deepEqual(successor.supersedes, [`session-${SESSION_ID}`]);
    assert.equal(predecessor.status, 'superseded');

    // The chain walks both ways: back by `resumed_from`, forward by filtering
    // for the note whose `resumed_from` names this one.
    assert.equal(successor.resumed_from, predecessor.id);

    // 5. The manual tag and the manual field are still there.
    assert.ok(predecessor.tags.includes('needs-followup'));
    assert.equal(predecessor.reviewed_by, 'stack');
  } finally {
    sandbox.cleanup();
  }
});

test('a resume hands the ingest both notes: the successor and the one it superseded', () => {
  const sandbox = createSandbox();
  try {
    const first = runScenario(sandbox, scenario('resume-first', 'clear'));
    assert.deepEqual(
      first.touchedPaths,
      [path.join(sandbox.vaultRoot, FIRST_NOTE)],
      'a plain capture touches the one note it wrote',
    );

    const resumed = runScenario(sandbox, scenario('resume-second', 'logout'));

    // `status: superseded` on the predecessor is a frontmatter-only change, so
    // nothing else would ever carry it into the store: the body hash is the
    // same, and only the metadata path notices. Leaving it out of the enqueue
    // left the old note reading `concluded` in search forever.
    assert.deepEqual(resumed.touchedPaths, [
      path.join(sandbox.vaultRoot, RESUMED_NOTE),
      path.join(sandbox.vaultRoot, FIRST_NOTE),
    ]);
  } finally {
    sandbox.cleanup();
  }
});

test('a capture that re-renders a note byte for byte hands the ingest nothing', () => {
  const sandbox = createSandbox();
  try {
    const first = runScenario(sandbox, scenario('resume-first', 'resume'));
    assert.equal(first.touchedPaths.length, 1);

    const before = fs.readFileSync(path.join(sandbox.vaultRoot, FIRST_NOTE), 'utf8');

    // The same transcript, the same reason: the merge produces exactly the file
    // that is already there. Re-ingesting it would start a process and load a
    // 130 MB model to re-confirm a hash.
    const again = runScenario(sandbox, scenario('resume-first', 'resume'));

    assert.equal(again.written, true);
    assert.deepEqual(again.touchedPaths, []);
    assert.match(again.detail, /identical on disk/);
    assert.equal(fs.readFileSync(path.join(sandbox.vaultRoot, FIRST_NOTE), 'utf8'), before);
  } finally {
    sandbox.cleanup();
  }
});

test('a resume before the note settles merges into it, and status never regresses', () => {
  const sandbox = createSandbox();
  try {
    // `reason: resume` means the session has not finished, so the note is active.
    const first = runScenario(sandbox, scenario('resume-first', 'resume'));
    assert.equal(first.action, 'create');
    assert.equal(readFields(sandbox, FIRST_NOTE).status, 'active');
    assert.equal(readFields(sandbox, FIRST_NOTE).concluded_at, '');

    addManualTag(sandbox, FIRST_NOTE, 'needs-followup');

    // The continuation ends for real: same note, now concluded.
    const second = runScenario(sandbox, scenario('resume-second', 'clear'));
    assert.equal(second.action, 'merge');
    assert.ok(second.notePath.endsWith(`${SESSION_ID}.md`));
    assert.equal(fs.existsSync(path.join(sandbox.vaultRoot, RESUMED_NOTE)), false);

    const merged = readFields(sandbox, FIRST_NOTE);
    assert.equal(merged.status, 'concluded');
    assert.equal(merged.prompt_count, 2);
    assert.ok(merged.tags.includes('needs-followup'), 'the manual tag survived the rewrite');
    assert.ok(merged.files_modified.includes('docs/tags.md'));

    // A later `resume` must not pull the note back to active.
    const third = runScenario(sandbox, scenario('resume-second', 'resume'));
    assert.equal(third.action, 'noop');
    assert.equal(readFields(sandbox, FIRST_NOTE).status, 'concluded');
  } finally {
    sandbox.cleanup();
  }
});

test('a paragraph written below the generated marker survives a rewrite', () => {
  const sandbox = createSandbox();
  try {
    runScenario(sandbox, scenario('resume-first', 'resume'));

    const notePath = path.join(sandbox.vaultRoot, FIRST_NOTE);
    const handwritten = [
      '',
      '## Why this mattered',
      '',
      'The pooler port cost an hour. Do not forget again.',
      '',
    ].join('\n');
    fs.appendFileSync(notePath, handwritten, 'utf8');

    const outcome = runScenario(sandbox, scenario('resume-second', 'clear'));
    assert.equal(outcome.action, 'merge');

    const after = fs.readFileSync(notePath, 'utf8');
    assert.match(after, /## Why this mattered/);
    assert.match(after, /The pooler port cost an hour/);
    // The machine sections were still regenerated around it.
    assert.match(after, /^status: 'concluded'$/m);
    assert.match(after, /docs\/tags\.md/);
    // And it is not duplicated on a second pass.
    runScenario(sandbox, scenario('resume-second', 'resume'));
    const twice = fs.readFileSync(notePath, 'utf8');
    assert.equal(twice.split('## Why this mattered').length - 1, 1);
  } finally {
    sandbox.cleanup();
  }
});

test('a note whose frontmatter cannot be parsed is never overwritten', () => {
  const sandbox = createSandbox();
  try {
    runScenario(sandbox, scenario('resume-first', 'clear'));

    const notePath = path.join(sandbox.vaultRoot, FIRST_NOTE);
    const broken = '---\ntags: [unterminated\n---\n\n# hand-edited\n';
    fs.writeFileSync(notePath, broken, 'utf8');

    const outcome = runScenario(sandbox, scenario('resume-second', 'clear'));
    assert.equal(outcome.written, false);
    assert.match(outcome.skip, /unreadable/);
    assert.equal(fs.readFileSync(notePath, 'utf8'), broken);
  } finally {
    sandbox.cleanup();
  }
});
