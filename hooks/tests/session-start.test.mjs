/**
 * SC-2 -> SC-1: the SessionStart hook's state file becomes one retrieval
 * entry of channel `session-start`. The reader fails open, never throws,
 * never builds a path from an unchecked session id, and deletes nothing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import {
  MAX_EXTERNAL_ID_CHARS,
  MAX_EXTERNAL_IDS,
  STATE_DIR_ENV_VAR,
  defaultStateDir,
  readSessionStartRecord,
  toResultRef,
} from '../lib/session-start.mjs';

const SESSION = '1a2b3c4d-0000-4111-8111-222233334444';
const OTHER = '9f8e7d6c-0000-4111-8111-222233334444';
const AT = '2026-09-24T14:03:11Z';

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state', 'session-start');
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, stateDir };
}

function baseRecord(overrides = {}) {
  return {
    at: AT,
    session_id: SESSION,
    cwd: 'C:/Users/estac/agentic-harness',
    realm: 'harness',
    collection: 'agentic-harness',
    source: 'status',
    external_ids: ['harness/agentic-harness/status.md', 'claude-mem:461'],
    tokens: 812,
    ...overrides,
  };
}

function writeRecord(stateDir, record, sessionId = SESSION) {
  const file = path.join(stateDir, `${sessionId}.json`);
  fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record));
  return file;
}

function read(stateDir, sessionId = SESSION) {
  return readSessionStartRecord({ sessionId, stateDir, env: {} });
}

test('happy path: one SC-1 entry of channel session-start', (t) => {
  const { stateDir } = tempDir(t);
  const file = writeRecord(stateDir, baseRecord());

  const { record, reason } = read(stateDir);

  assert.equal(reason, 'ok');
  assert.deepEqual(record, {
    at: AT,
    channel: 'session-start',
    tool: 'session-start',
    query: '',
    filters: { source: 'status', collection: 'agentic-harness', realm: 'harness', tokens: 812 },
    results: ['obsidian:harness/agentic-harness/status.md', 'claude-mem:461'],
    chunks: [],
  });
  assert.ok(fs.existsSync(file), 'the reader deletes nothing (SC-2)');
});

test('a missing file is no record, not an error', (t) => {
  const { stateDir } = tempDir(t);
  assert.deepEqual(read(stateDir), { record: null, reason: 'no record' });
});

test('a missing state directory is no record', (t) => {
  const { root } = tempDir(t);
  assert.deepEqual(read(path.join(root, 'nowhere')), { record: null, reason: 'no record' });
});

test('a bad session id is refused before any path is built or touched', (t) => {
  const { root, stateDir } = tempDir(t);
  // A file that a traversal from stateDir would reach.
  const planted = path.join(root, 'state', 'planted.json');
  fs.writeFileSync(planted, JSON.stringify(baseRecord({ session_id: '../planted' })));

  const lstat = mock.method(fs, 'lstatSync');
  const readFile = mock.method(fs, 'readFileSync');
  const open = mock.method(fs, 'openSync');
  t.after(() => mock.restoreAll());

  for (const bad of ['../planted', '..\\planted', SESSION.toUpperCase(), `${SESSION}.json`, '', null, undefined, 42, `${SESSION}/../x`]) {
    // Called directly: the read() helper would default an undefined id to SESSION.
    const result = readSessionStartRecord({ sessionId: bad, stateDir, env: {} });
    assert.deepEqual(result, { record: null, reason: 'bad session id' }, String(bad));
  }
  assert.equal(lstat.mock.callCount(), 0);
  assert.equal(readFile.mock.callCount(), 0);
  assert.equal(open.mock.callCount(), 0);
  assert.ok(fs.existsSync(planted));
});

test('a session_id inside the file that differs from the one asked for is refused', (t) => {
  const { stateDir } = tempDir(t);
  writeRecord(stateDir, baseRecord({ session_id: OTHER }));
  assert.deepEqual(read(stateDir), { record: null, reason: 'session id mismatch' });
});

test('a non-ISO at is refused', (t) => {
  const { stateDir } = tempDir(t);
  for (const at of ['yesterday', '2026-09-24', 1727186591000, '2026-13-45T99:99:99Z', null]) {
    writeRecord(stateDir, baseRecord({ at }));
    assert.deepEqual(read(stateDir), { record: null, reason: 'bad at' }, String(at));
  }
});

test('an ISO at with milliseconds or an offset is kept as written', (t) => {
  const { stateDir } = tempDir(t);
  for (const at of ['2026-09-24T14:03:11.123Z', '2026-09-24T10:03:11-04:00']) {
    writeRecord(stateDir, baseRecord({ at }));
    assert.equal(read(stateDir).record.at, at);
  }
});

test('unparseable JSON is refused and its contents never reach the reason', (t) => {
  const { stateDir } = tempDir(t);
  writeRecord(stateDir, '{"at": "SECRET-TOKEN-abc123", oops');
  const { record, reason } = read(stateDir);
  assert.equal(record, null);
  assert.equal(reason, 'bad json');
});

test('a JSON value that is not an object is refused', (t) => {
  const { stateDir } = tempDir(t);
  for (const text of ['[]', '"x"', 'null', '7']) {
    writeRecord(stateDir, text);
    assert.deepEqual(read(stateDir), { record: null, reason: 'not an object' }, text);
  }
});

test('external_ids must be an array of strings', (t) => {
  const { stateDir } = tempDir(t);
  for (const external_ids of ['a', null, undefined, [1], ['ok', { id: 'x' }]]) {
    writeRecord(stateDir, baseRecord({ external_ids }));
    assert.deepEqual(read(stateDir), { record: null, reason: 'bad external_ids' }, JSON.stringify(external_ids));
  }
});

test('an empty external_ids list is a valid record with no results', (t) => {
  const { stateDir } = tempDir(t);
  writeRecord(stateDir, baseRecord({ source: 'none', external_ids: [] }));
  const { record } = read(stateDir);
  assert.deepEqual(record.results, []);
  assert.equal(record.filters.source, 'none');
});

test('ids keep a known source prefix and get obsidian: otherwise', () => {
  assert.equal(toResultRef('obsidian:session-1a2b'), 'obsidian:session-1a2b');
  assert.equal(toResultRef('claude-mem:461'), 'claude-mem:461');
  assert.equal(toResultRef('hermes:abc'), 'hermes:abc');
  assert.equal(toResultRef('harness/agentic-harness/status.md'), 'obsidian:harness/agentic-harness/status.md');
  assert.equal(toResultRef('mystery:42'), 'obsidian:mystery:42');
  assert.equal(toResultRef('claude-mem461'), 'obsidian:claude-mem461');
  assert.equal(toResultRef('461@0.85'), 'obsidian:461@0.85', 'no similarity is added or parsed');
});

test('empty ids are dropped', (t) => {
  const { stateDir } = tempDir(t);
  writeRecord(stateDir, baseRecord({ external_ids: ['', 'a.md', ''] }));
  assert.deepEqual(read(stateDir).record.results, ['obsidian:a.md']);
});

test('external_ids are capped in count and in length', (t) => {
  const { stateDir } = tempDir(t);
  const many = Array.from({ length: MAX_EXTERNAL_IDS + 25 }, (_, i) => `note-${i}.md`);
  writeRecord(stateDir, baseRecord({ external_ids: many }));
  const { record } = read(stateDir);
  assert.equal(record.results.length, MAX_EXTERNAL_IDS);
  assert.equal(record.results[0], 'obsidian:note-0.md');
  assert.equal(record.results.at(-1), `obsidian:note-${MAX_EXTERNAL_IDS - 1}.md`);

  const long = `claude-mem:${'x'.repeat(MAX_EXTERNAL_ID_CHARS * 2)}`;
  writeRecord(stateDir, baseRecord({ external_ids: [long] }));
  const [ref] = read(stateDir).record.results;
  assert.equal(ref, long.slice(0, MAX_EXTERNAL_ID_CHARS));
  assert.ok(ref.startsWith('claude-mem:'));
});

test('tokens is kept only as a finite non-negative integer', (t) => {
  const { stateDir } = tempDir(t);
  for (const [tokens, kept] of [[0, true], [812, true], [-1, false], [1.5, false], ['812', false], [null, false], [Infinity, false]]) {
    writeRecord(stateDir, baseRecord({ tokens }));
    const { filters } = read(stateDir).record;
    assert.equal('tokens' in filters, kept, String(tokens));
    if (kept) assert.equal(filters.tokens, tokens);
  }
});

test('source is kept only when it is status, outcomes or none', (t) => {
  const { stateDir } = tempDir(t);
  for (const [source, kept] of [['status', true], ['outcomes', true], ['none', true], ['STATUS', false], ['vault', false], [3, false]]) {
    writeRecord(stateDir, baseRecord({ source }));
    const { filters } = read(stateDir).record;
    assert.equal('source' in filters, kept, String(source));
  }
});

test('collection and realm are omitted when they are not non-empty strings', (t) => {
  const { stateDir } = tempDir(t);
  writeRecord(stateDir, baseRecord({ collection: '', realm: 7 }));
  assert.deepEqual(read(stateDir).record.filters, { source: 'status', tokens: 812 });
});

test('a directory in place of the file is refused without throwing', (t) => {
  const { stateDir } = tempDir(t);
  fs.mkdirSync(path.join(stateDir, `${SESSION}.json`));
  assert.deepEqual(read(stateDir), { record: null, reason: 'not a file' });
});

test('an oversized file is refused without being parsed', (t) => {
  const { stateDir } = tempDir(t);
  writeRecord(stateDir, JSON.stringify(baseRecord({ cwd: 'x'.repeat(300 * 1024) })));
  assert.deepEqual(read(stateDir), { record: null, reason: 'record too large' });
});

test('defaultStateDir honours HARNESS_STATE_DIR and falls back to ~/.harness/state', () => {
  assert.equal(STATE_DIR_ENV_VAR, 'HARNESS_STATE_DIR');
  assert.equal(defaultStateDir({ HARNESS_STATE_DIR: '/tmp/st' }), path.join('/tmp/st', 'session-start'));
  assert.equal(defaultStateDir({}, '/home/x'), path.join('/home/x', '.harness', 'state', 'session-start'));
});

test('the default stateDir follows the env it is given', (t) => {
  const { root } = tempDir(t);
  const stateRoot = path.join(root, 'custom');
  fs.mkdirSync(path.join(stateRoot, 'session-start'), { recursive: true });
  writeRecord(path.join(stateRoot, 'session-start'), baseRecord());
  const { reason } = readSessionStartRecord({ sessionId: SESSION, env: { HARNESS_STATE_DIR: stateRoot } });
  assert.equal(reason, 'ok');
});

test('the reader never throws, even on a bad argument object', () => {
  assert.deepEqual(readSessionStartRecord(), { record: null, reason: 'bad session id' });
  assert.deepEqual(readSessionStartRecord({ sessionId: SESSION, stateDir: 42, env: {} }), { record: null, reason: 'bad state dir' });
});
