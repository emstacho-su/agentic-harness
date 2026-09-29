/**
 * P-55: the five-tag cap holds per note, not per render (H-3, R-102).
 *
 * A worker note is re-merged at every `SubagentStop`, and the old merge took
 * the union of every render's tags, so a worker re-captured often enough grew
 * past the cap. `hook_tags` records which tags the hook put there on the latest
 * render; a merge replaces those and keeps everything else in `tags` as hand
 * tags, which are never removed or capped.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { MAX_HOOK_TAGS } from '../lib/constants.mjs';
import { FIELD_SPEC, parseFrontmatter, serializeFrontmatter } from '../lib/frontmatter.mjs';
import { mergeFields } from '../lib/merge.mjs';
import { buildFields } from '../lib/note.mjs';
import { FIELD_SPEC as CHECKPOINT_FIELD_SPEC, buildNote } from '../../skills/checkpoint/build-note.mjs';
import { createSandbox, installTranscript } from './helpers/sandbox.mjs';
import { SCENARIOS, runSubagentStop } from './helpers/scenarios.mjs';

const HAND_TAG = 'needs-followup';

/** Nine renders whose classifier output differs each time: 12 distinct tags in all. */
const RENDERS = Object.freeze([
  ['phase-7', 'db', 'ingest', 'pr', 'validation'],
  ['phase-7', 'gui', 'retrieval', 'integration'],
  ['phase-7', 'mcp', 'harness', 'hotfix'],
  ['phase-7', 'docs', 'review', 'phase-brief'],
  ['phase-7', 'planning', 'db'],
  ['phase-7', 'gui', 'ingest', 'pr', 'hotfix'],
  ['phase-7', 'retrieval', 'mcp'],
  ['phase-7', 'harness', 'docs', 'validation'],
  ['phase-7', 'db', 'gui'],
]);

function render(hookTags) {
  return { id: 'session-x--a1', status: 'active', tags: [...hookTags], hook_tags: [...hookTags] };
}

test('hook_tags is a list field, appended after the last contract field', () => {
  const names = FIELD_SPEC.map(([name]) => name);
  assert.equal(names.at(-1), 'hook_tags');
  assert.deepEqual(FIELD_SPEC.at(-1), ['hook_tags', 'list']);
  assert.ok(names.indexOf('hook_tags') > names.indexOf('machine'));
  assert.deepEqual(CHECKPOINT_FIELD_SPEC, FIELD_SPEC, 'the /checkpoint copy carries the same entry');
});

test('buildFields writes the classifier output for this render as hook_tags', () => {
  const fields = buildFields(minimalContext({ tags: ['phase-7', 'db'] }));
  assert.deepEqual(fields.hook_tags, ['phase-7', 'db']);
  assert.deepEqual(fields.tags, ['phase-7', 'db']);
});

test('a worker re-captured nine times still carries at most five hook tags', () => {
  let note = { ...render(RENDERS[0]), tags: [...RENDERS[0], HAND_TAG] };
  for (const tags of RENDERS.slice(1)) {
    note = mergeFields(note, render(tags));
    assert.ok(note.hook_tags.length <= MAX_HOOK_TAGS, `hook_tags ${note.hook_tags}`);
  }
  assert.deepEqual(note.hook_tags, RENDERS.at(-1));
  assert.deepEqual(note.tags, [HAND_TAG, ...RENDERS.at(-1)], 'the hand tag survives, stale hook tags do not');
});

test('tags = (old tags - old hook_tags) + new hook_tags', () => {
  const existing = { tags: ['db', 'mine', 'ingest', 'also-mine'], hook_tags: ['db', 'ingest'] };
  const merged = mergeFields(existing, { tags: ['gui'], hook_tags: ['gui'] });
  assert.deepEqual(merged.tags, ['mine', 'also-mine', 'gui']);
  assert.deepEqual(merged.hook_tags, ['gui']);
});

test('a hand tag that is also a vocabulary term survives when the hook stops raising it', () => {
  // `db` was typed by hand before the hook raised it; it is in tags but not in
  // the old hook_tags, so it is a hand tag and stays.
  const existing = { tags: ['db', 'gui'], hook_tags: ['gui'] };
  const merged = mergeFields(existing, { tags: ['docs'], hook_tags: ['docs'] });
  assert.deepEqual(merged.tags, ['db', 'docs']);
});

test('a note without hook_tags treats every tag as hand, so nothing is dropped', () => {
  const six = ['phase-7', 'db', 'ingest', 'gui', 'retrieval', 'pr'];
  const merged = mergeFields({ tags: six }, { tags: ['docs'], hook_tags: ['docs'] });
  assert.deepEqual(merged.tags, [...six, 'docs']);
  assert.deepEqual(merged.hook_tags, ['docs']);
});

test('a render with no hook_tags keeps the old ones and the old tags', () => {
  const existing = { tags: ['db', 'mine'], hook_tags: ['db'] };
  const merged = mergeFields(existing, { tags: [] });
  assert.deepEqual(merged.hook_tags, ['db']);
  assert.deepEqual(merged.tags, ['db', 'mine']);
});

test('the unclassified rule still applies after the replace', () => {
  const toReal = mergeFields({ tags: ['unclassified'], hook_tags: ['unclassified'] }, render(['db']));
  assert.deepEqual(toReal.tags, ['db']);

  const handOnly = mergeFields({ tags: ['db', 'mine'], hook_tags: ['db'] }, render(['unclassified']));
  assert.deepEqual(handOnly.tags, ['mine'], 'unclassified yields to a hand tag');
  assert.deepEqual(handOnly.hook_tags, ['unclassified']);

  const nothing = mergeFields({ tags: ['db'], hook_tags: ['db'] }, render(['unclassified']));
  assert.deepEqual(nothing.tags, ['unclassified']);
});

test('the merge leaves both inputs alone', () => {
  const existing = { tags: ['db', 'mine'], hook_tags: ['db'] };
  const next = render(['gui']);
  mergeFields(existing, next);
  assert.deepEqual(existing, { tags: ['db', 'mine'], hook_tags: ['db'] });
  assert.deepEqual(next, render(['gui']));
});

test('SubagentStop replaces stale hook tags on disk and keeps the hand tag', () => {
  const parent = SCENARIOS.find((scenario) => scenario.name === 'subagent-parent');
  const sessionId = '88888888-8888-4888-8888-888888888888';
  const note = `projects/bb2dash/sessions/${sessionId}--c0ffee01.md`;
  const sandbox = createSandbox();
  try {
    const transcriptPath = installTranscript(sandbox, parent.fixture, sessionId);
    const stop = () =>
      runSubagentStop(sandbox, { sessionId, agentId: 'c0ffee01', agentType: 'general-purpose', cwd: parent.cwd, transcriptPath });

    assert.equal(stop().written, true);
    const notePath = path.join(sandbox.vaultRoot, note);
    const first = readFields(notePath);
    assert.ok(first.fields.hook_tags.length > 0 && first.fields.hook_tags.length <= MAX_HOOK_TAGS);
    assert.deepEqual(first.fields.hook_tags, first.fields.tags);

    // An earlier render raised five other terms, and Stack added one of his own.
    const stale = ['db', 'ingest', 'mcp', 'harness', 'docs'];
    const seeded = { ...first.fields, tags: [...stale, HAND_TAG], hook_tags: stale };
    fs.writeFileSync(notePath, `${serializeFrontmatter(seeded)}\n${first.body}`, 'utf8');

    assert.equal(stop().written, true);
    const second = readFields(notePath).fields;
    assert.deepEqual(second.hook_tags, first.fields.hook_tags);
    assert.deepEqual(second.tags, [HAND_TAG, ...first.fields.hook_tags]);
  } finally {
    sandbox.cleanup();
  }
});

test('a /checkpoint note writes hook_tags: []', () => {
  const body = [
    '## What I asked for', '1. Save the session.', '',
    '## What was done', '- Built the note.', '',
    '## Decisions', '- none', '',
    '## Open questions / next steps', '- none', '',
  ].join('\n');
  const note = buildNote({ repo: process.cwd(), body, sessionId: 'hook-tags-test', now: new Date('2026-09-29T12:00:00Z') });
  assert.equal(note.ok, true, note.error);
  assert.deepEqual(note.fields.hook_tags, []);
  assert.match(note.text, /^hook_tags: \[\]$/m);
});

function readFields(notePath) {
  const parsed = parseFrontmatter(fs.readFileSync(notePath, 'utf8'));
  assert.equal(parsed.ok, true, parsed.error);
  return parsed;
}

function minimalContext(overrides) {
  return {
    noteId: 'session-x',
    title: 'x',
    collection: 'c',
    collectionSource: 'git',
    sessionId: 'x',
    date: '2026-09-29',
    startedAt: '',
    endedAt: '',
    durationMs: 0,
    status: 'active',
    concludedAt: '',
    endReason: 'other',
    repo: '',
    branch: '',
    worktree: '',
    reposTouched: [],
    cwd: '',
    cwdsSeen: [],
    phase: '',
    tags: [],
    parentSession: '',
    childSessions: [],
    commits: [],
    prs: [],
    memoryFiles: [],
    planFile: '',
    docsTouched: [],
    artifacts: [],
    files: [],
    prompts: [],
    commandCount: 0,
    toolCounts: new Map(),
    ...overrides,
  };
}
