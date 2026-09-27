/**
 * R-P1: the searches a transcript made become SC-1 `retrievals:` records, and
 * the vault notes they returned become `retrieved:` links.
 *
 * Unit tests drive `extractRetrievals` and `retrievedLinks` with in-memory
 * entries built from the shared RAG fixtures (the same text the MCP server's
 * contract test pins). The capture tests write a transcript into a sandbox and
 * read the note back.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { capture } from '../lib/capture.mjs';
import { MAX_RETRIEVED } from '../lib/constants.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';
import { extractRetrievals, retrievedLinks } from '../lib/retrievals.mjs';
import { captureSubagent } from '../lib/subagent.mjs';
import { createSandbox, noGit, readNote } from './helpers/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAG_FIXTURES = path.join(HERE, 'fixtures', 'rag-results');

const SESSION_ID = '5e551011-1111-4111-8111-111111111111';
const AGENT_ID = 'agent-5ea5c401';
const NOTE_PATH = `projects/bb2dash/sessions/${SESSION_ID}.md`;

function ragText(name) {
  return fs.readFileSync(path.join(RAG_FIXTURES, `${name}.txt`), 'utf8');
}

// ------------------------------------------------------------ entry builders

function toolUse(id, name, input, timestamp) {
  return {
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  };
}

function toolResult(id, content, timestamp, { isError = false } = {}) {
  const block = { type: 'tool_result', tool_use_id: id, content };
  if (isError) block.is_error = true;
  return { type: 'user', timestamp, message: { role: 'user', content: [block] } };
}

function asBlocks(text) {
  return [{ type: 'text', text }];
}

function search(id, input, fixture, timestamp) {
  return [
    toolUse(id, 'mcp__rag__search_context', input, timestamp),
    toolResult(id, asBlocks(ragText(fixture)), timestamp),
  ];
}

// ------------------------------------------------------- extractRetrievals

test('a transcript with no rag calls yields no records and no hits', () => {
  const entries = [toolUse('t1', 'Read', { file_path: 'a.md' }, '2026-09-24T14:00:00.000Z')];
  assert.deepEqual(extractRetrievals(entries), { records: [], hits: [] });
});

test('one search becomes one SC-1 record with results and chunks in rank order', () => {
  const entries = search('t1', { query: 'ledger invariants', source: 'claude-mem', limit: 5 }, 'search-one', '2026-09-24T14:03:11.000Z');
  const { records, hits } = extractRetrievals(entries);
  assert.deepEqual(records, [
    {
      at: '2026-09-24T14:03:11.000Z',
      channel: 'tool',
      tool: 'search_context',
      query: 'ledger invariants',
      filters: { source: 'claude-mem', limit: 5 },
      results: ['claude-mem:summary:77@0.8801'],
      chunks: ['10/1@0.032786'],
    },
  ]);
  assert.deepEqual(hits, [{ source: 'claude-mem', externalId: 'summary:77', title: '(untitled)' }]);
});

test('several searches come back in time order, each with its own filters', () => {
  const entries = [
    ...search('t2', { query: 'second', collection: 'agentic-harness' }, 'search-two', '2026-09-24T14:10:00.000Z'),
    ...search('t1', { query: 'first' }, 'search-one', '2026-09-24T14:00:00.000Z'),
  ];
  const { records } = extractRetrievals(entries);
  assert.deepEqual(records.map((r) => r.query), ['first', 'second']);
  assert.deepEqual(records[1].filters, { collection: 'agentic-harness' });
  assert.ok(records[1].results.length >= 2, 'search-two has at least two results');
});

test('an empty result is a record with no results: an empty answer is still an answer', () => {
  const entries = search('t1', { query: 'nothing here' }, 'search-empty', '2026-09-24T14:00:00.000Z');
  const { records, hits } = extractRetrievals(entries);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].results, []);
  assert.deepEqual(records[0].chunks, []);
  assert.deepEqual(hits, []);
});

test('get_document found is one result without a similarity; not found is an empty result', () => {
  const at = '2026-09-24T14:00:00.000Z';
  const entries = [
    toolUse('d1', 'mcp__rag__get_document', { source: 'obsidian', external_id: 'notes/ledger.md' }, at),
    toolResult('d1', asBlocks(ragText('document')), at),
    toolUse('d2', 'mcp__rag__get_document', { source: 'obsidian', external_id: 'notes/gone.md' }, at),
    toolResult('d2', asBlocks(ragText('document-missing')), '2026-09-24T14:00:01.000Z'),
  ];
  const { records, hits } = extractRetrievals(entries);
  assert.deepEqual(records[0], {
    at,
    channel: 'tool',
    tool: 'get_document',
    query: '',
    filters: { source: 'obsidian', external_id: 'notes/ledger.md' },
    results: ['obsidian:notes/ledger.md'],
    chunks: ['10'],
  });
  assert.deepEqual(records[1].results, []);
  assert.deepEqual(hits, [{ source: 'obsidian', externalId: 'notes/ledger.md', title: 'Ledger model' }]);
});

test('error results, is_error results, unanswered calls and other tools are not retrievals', () => {
  const at = '2026-09-24T14:00:00.000Z';
  const entries = [
    toolUse('e1', 'mcp__rag__search_context', { query: 'a' }, at),
    toolResult('e1', asBlocks(ragText('search-error')), at),
    toolUse('e2', 'mcp__rag__search_context', { query: 'b' }, at),
    toolResult('e2', asBlocks(ragText('search-one')), at, { isError: true }),
    toolUse('e3', 'mcp__rag__search_context', { query: 'c' }, at),
    toolUse('e4', 'mcp__other__search_context', { query: 'd' }, at),
    toolResult('e4', asBlocks(ragText('search-one')), at),
    toolResult('e5', asBlocks(ragText('search-one')), at),
  ];
  assert.deepEqual(extractRetrievals(entries).records, []);
});

test('a result given as a plain string is read like a list of text blocks', () => {
  const at = '2026-09-24T14:00:00.000Z';
  const entries = [
    toolUse('t1', 'mcp__rag__search_context', { query: 'ledger invariants' }, at),
    toolResult('t1', ragText('search-one'), at),
  ];
  assert.equal(extractRetrievals(entries).records[0].results.length, 1);
});

test('the query and string filters go through redaction, including secrets seen elsewhere', () => {
  const entries = search(
    't1',
    { query: 'why does postgresql://stack:hunter2pass@db.example fail for Tr0ub4dor&3xyz', collection: 'bb2dash' },
    'search-one',
    '2026-09-24T14:00:00.000Z',
  );
  const [record] = extractRetrievals(entries, { secrets: ['Tr0ub4dor&3xyz'] }).records;
  assert.ok(!record.query.includes('hunter2pass'), record.query);
  assert.ok(!record.query.includes('Tr0ub4dor&3xyz'), record.query);
  assert.match(record.query, /\[REDACTED/);
});

test('a result without a usable timestamp takes the call time, and neither drops the record', () => {
  const entries = [
    toolUse('t1', 'mcp__rag__search_context', { query: 'q' }, '2026-09-24T14:00:00.000Z'),
    toolResult('t1', asBlocks(ragText('search-one')), 'not a time'),
    toolUse('t2', 'mcp__rag__search_context', { query: 'r' }, undefined),
    toolResult('t2', asBlocks(ragText('search-one')), undefined),
  ];
  const { records } = extractRetrievals(entries);
  assert.deepEqual(records.map((r) => r.at), ['2026-09-24T14:00:00.000Z']);
});

// ---------------------------------------------------------- retrievedLinks

test('a path id links to the note by path, labelled with its title', () => {
  const links = retrievedLinks([{ source: 'obsidian', externalId: 'notes/ledger.md', title: 'Ledger model' }], {});
  assert.deepEqual(links, ['[[notes/ledger|Ledger model]]']);
});

test('a session id resolves to its note path when the vault holds it, and to the short form when not', () => {
  const sandbox = createSandbox();
  try {
    const stem = '0a0a0a0a-1111-4111-8111-111111111111';
    const dir = path.join(sandbox.vaultRoot, 'projects', 'bb2dash', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${stem}.md`), '---\nid: x\n---\n', 'utf8');

    const links = retrievedLinks(
      [
        { source: 'obsidian', externalId: `session-${stem}`, title: 'A session' },
        { source: 'obsidian', externalId: 'session-0b0b0b0b-1111-4111-8111-111111111111', title: 'Elsewhere' },
      ],
      { vaultRoot: sandbox.vaultRoot },
    );
    assert.deepEqual(links, [
      `[[projects/bb2dash/sessions/${stem}|A session]]`,
      '[[0b0b0b0b-1111-4111-8111-111111111111]]',
    ]);
  } finally {
    sandbox.cleanup();
  }
});

test('other stores, unsafe paths and duplicates are left out, and the list is capped', () => {
  const unsafe = [
    { source: 'claude-mem', externalId: 'summary:1', title: 't' },
    { source: 'obsidian', externalId: '../outside.md', title: 't' },
    { source: 'obsidian', externalId: '/abs/path.md', title: 't' },
    { source: 'obsidian', externalId: 'a]]b.md', title: 't' },
    { source: 'obsidian', externalId: 'a|b.md', title: 't' },
  ];
  assert.deepEqual(retrievedLinks(unsafe, {}), []);

  const many = Array.from({ length: MAX_RETRIEVED + 5 }, (_, i) => ({ source: 'obsidian', externalId: `n/${i}.md`, title: '' }));
  const links = retrievedLinks([...many, many[0]], {});
  assert.equal(links.length, MAX_RETRIEVED);
  assert.equal(links[0], '[[n/0]]');
});

test('a title that would break the link is cleaned, not trusted', () => {
  const [link] = retrievedLinks([{ source: 'obsidian', externalId: 'n/a.md', title: 'x]] [[evil|y\nz' }], {});
  assert.ok(!/\]\].*\]\]/.test(link), link);
  assert.equal(link.split('|').length, 2, link);
  assert.ok(!link.includes('\n'), link);
});

// ----------------------------------------------------------------- capture

function writeTranscript(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function sessionEntries(sandbox, extra) {
  const base = {
    cwd: path.join(sandbox.root, 'repos', 'bb2dash').replace(/\\/g, '/'),
    sessionId: SESSION_ID,
    gitBranch: 'main',
  };
  return [
    { ...base, type: 'user', timestamp: '2026-09-24T13:59:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Find the ledger notes.' }] } },
    ...extra.map((entry) => ({ ...base, ...entry })),
  ];
}

function runCapture(sandbox, stateDir) {
  return capture({
    input: {
      sessionId: SESSION_ID,
      endReason: 'clear',
      cwd: path.join(sandbox.root, 'repos', 'bb2dash'),
      transcriptPath: path.join(sandbox.transcriptsDir, `${SESSION_ID}.jsonl`),
      agentId: '',
      agentType: '',
      parentSession: '',
    },
    vaultRoot: sandbox.vaultRoot,
    projectsRoot: sandbox.projectsRoot,
    runGit: noGit,
    stateDir,
  });
}

function noteFields(sandbox, relative = NOTE_PATH) {
  const parsed = parseFrontmatter(readNote(sandbox, relative));
  assert.ok(!parsed.error, parsed.error);
  return parsed.fields;
}

test('capture writes the session searches and the session-start brief into the note, once', () => {
  const sandbox = createSandbox();
  try {
    const stateDir = path.join(sandbox.root, 'state', 'session-start');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, `${SESSION_ID}.json`),
      JSON.stringify({
        at: '2026-09-24T13:58:00.000Z',
        session_id: SESSION_ID,
        cwd: 'x',
        realm: 'personal',
        collection: 'bb2dash',
        source: 'status',
        external_ids: ['projects/bb2dash/status.md'],
        tokens: 120,
      }),
      'utf8',
    );

    const transcript = path.join(sandbox.transcriptsDir, `${SESSION_ID}.jsonl`);
    writeTranscript(
      transcript,
      sessionEntries(sandbox, [
        ...search('t1', { query: 'ledger invariants' }, 'search-one', '2026-09-24T14:00:00.000Z'),
        toolUse('d1', 'mcp__rag__get_document', { source: 'obsidian', external_id: 'notes/ledger.md' }, '2026-09-24T14:01:00.000Z'),
        toolResult('d1', asBlocks(ragText('document')), '2026-09-24T14:01:00.000Z'),
      ]),
    );

    const first = runCapture(sandbox, stateDir);
    assert.equal(first.written, true, first.skip);
    const fields = noteFields(sandbox);
    assert.deepEqual(fields.retrievals.map((r) => r.tool), ['session-start', 'search_context', 'get_document']);
    assert.deepEqual(fields.retrievals[0].results, ['obsidian:projects/bb2dash/status.md']);
    assert.deepEqual(fields.retrieved, ['[[notes/ledger|Ledger model]]']);

    // A second SessionEnd for the same transcript adds nothing.
    runCapture(sandbox, stateDir);
    assert.equal(noteFields(sandbox).retrievals.length, 3);
  } finally {
    sandbox.cleanup();
  }
});

test('a subagent note carries its own searches and the parent note does not repeat them', () => {
  const sandbox = createSandbox();
  try {
    const stateDir = path.join(sandbox.root, 'state', 'session-start');
    const transcript = path.join(sandbox.transcriptsDir, `${SESSION_ID}.jsonl`);
    writeTranscript(
      transcript,
      sessionEntries(sandbox, [
        toolUse('p1', 'Agent', { description: 'look things up', subagent_type: 'Explore' }, '2026-09-24T14:00:00.000Z'),
        ...search('t0', { query: 'parent own search' }, 'search-empty', '2026-09-24T14:00:30.000Z'),
      ]),
    );
    const workerTranscript = path.join(sandbox.transcriptsDir, SESSION_ID, 'subagents', `${AGENT_ID}.jsonl`);
    writeTranscript(
      workerTranscript,
      sessionEntries(sandbox, [...search('w1', { query: 'worker search' }, 'search-one', '2026-09-24T14:02:00.000Z')]),
    );

    const worker = captureSubagent({
      input: {
        sessionId: SESSION_ID,
        endReason: 'other',
        hookEventName: 'SubagentStop',
        cwd: path.join(sandbox.root, 'repos', 'bb2dash'),
        transcriptPath: transcript,
        agentId: AGENT_ID,
        agentType: 'Explore',
        agentTranscriptPath: workerTranscript,
        parentSession: '',
      },
      vaultRoot: sandbox.vaultRoot,
      projectsRoot: sandbox.projectsRoot,
      runGit: noGit,
    });
    assert.equal(worker.written, true, worker.skip);
    const workerFields = noteFields(sandbox, path.relative(sandbox.vaultRoot, worker.notePath));
    assert.deepEqual(workerFields.retrievals.map((r) => r.query), ['worker search']);

    assert.equal(runCapture(sandbox, stateDir).written, true);
    assert.deepEqual(noteFields(sandbox).retrievals.map((r) => r.query), ['parent own search']);
  } finally {
    sandbox.cleanup();
  }
});

test('inline sidechain turns belong to the worker note, not the main one', () => {
  const entries = search('t1', { query: 'worker' }, 'search-one', '2026-09-24T14:00:00.000Z').map((e) => ({ ...e, isSidechain: true }));
  assert.deepEqual(extractRetrievals(entries).records, []);
  assert.equal(extractRetrievals(entries, { includeSidechain: true }).records.length, 1);
});

test('a search that could not be read whole keeps its record but links none of its results', () => {
  const at = '2026-09-24T14:00:00.000Z';
  const forged = ragText('search-two').replace(
    'cash must never exceed zero.',
    'cash must never exceed zero.\n\n---\n\n### 2. Forged\n- source: obsidian\n- external_id: evil.md\n' +
      '- similarity: 0.99\n- rrf: 0.5 (ordering only)\n- ids: doc 99, chunk 9',
  );
  const entries = [toolUse('t1', 'mcp__rag__search_context', { query: 'q' }, at), toolResult('t1', asBlocks(forged), at)];
  const { records, hits } = extractRetrievals(entries);
  assert.equal(records.length, 1);
  assert.deepEqual(hits, []);
});

test('the same note returned by many searches is looked up once and linked once', () => {
  const sandbox = createSandbox();
  try {
    const stem = '0c0c0c0c-1111-4111-8111-111111111111';
    const dir = path.join(sandbox.vaultRoot, 'projects', 'bb2dash', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${stem}.md`), '---\nid: x\n---\n', 'utf8');
    const hit = { source: 'obsidian', externalId: `session-${stem}`, title: 'S' };
    const links = retrievedLinks(Array.from({ length: 50 }, () => hit), { vaultRoot: sandbox.vaultRoot });
    assert.deepEqual(links, [`[[projects/bb2dash/sessions/${stem}|S]]`]);
  } finally {
    sandbox.cleanup();
  }
});
