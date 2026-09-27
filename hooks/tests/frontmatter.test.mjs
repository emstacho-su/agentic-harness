/**
 * The frontmatter parser and serializer.
 *
 * This is the merge's foundation: if the parser mis-reads a hand-edited note,
 * the merge writes back something Stack did not type. So the round trip is
 * exact, the hand-typed shapes are covered, and anything outside the subset is
 * a reported failure rather than a best guess.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { FIELD_ORDER, normalizeRecord, parseFrontmatter, serializeFrontmatter } from '../lib/frontmatter.mjs';

test('a note with no frontmatter is new, not broken', () => {
  const result = parseFrontmatter('# just a heading\n');
  assert.equal(result.ok, true);
  assert.deepEqual(result.fields, {});
  assert.equal(result.body, '# just a heading\n');
});

test('the shapes the hook emits round-trip exactly', () => {
  const fields = {
    id: 'session-abc',
    type: 'session',
    schema_version: 2,
    status: 'concluded',
    concluded_at: '',
    tags: ['phase-7', 'db'],
    prs: [6, 12],
    repos_touched: [],
    cwd: 'C:/Users/estac/projects/bb2dash',
    tools_used: { Edit: 5, Bash: 2 },
  };
  const parsed = parseFrontmatter(`${serializeFrontmatter(fields)}\n\nbody\n`);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.fields, fields);
  assert.equal(parsed.body, '\nbody\n');
});

test('a Windows path keeps its backslashes through a round trip', () => {
  const round = parseFrontmatter(serializeFrontmatter({ cwd: 'C:\\Users\\estac\\projects' }));
  assert.equal(round.fields.cwd, 'C:\\Users\\estac\\projects');
});

test('an apostrophe in a title survives quoting', () => {
  const round = parseFrontmatter(serializeFrontmatter({ title: "Stack's session" }));
  assert.equal(round.fields.title, "Stack's session");
});

test('the hand-typed shapes a person actually writes are read correctly', () => {
  const raw = [
    '---',
    '# a comment Stack left',
    'id: session-abc',
    'tags: [needs-followup, "quoted one", phase-7]',
    'reviewed: true',
    'count: 12',
    'note_for_me: remember the pooler port  # inline comment',
    'empty_scalar:',
    'block_list:',
    '  - one',
    '  - two',
    'nested:',
    '  Edit: 3',
    '---',
    '',
    'body',
  ].join('\n');

  const parsed = parseFrontmatter(raw);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.fields, {
    id: 'session-abc',
    tags: ['needs-followup', 'quoted one', 'phase-7'],
    reviewed: true,
    count: 12,
    note_for_me: 'remember the pooler port',
    empty_scalar: '',
    block_list: ['one', 'two'],
    nested: { Edit: 3 },
  });
});

test('CRLF is handled, because the vault lives on OneDrive', () => {
  const parsed = parseFrontmatter('---\r\nid: abc\r\ntags: []\r\n---\r\n\r\nbody\r\n');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.id, 'abc');
  assert.deepEqual(parsed.fields.tags, []);
});

test('unparseable frontmatter is reported, never guessed at', () => {
  const broken = [
    '---\nid: abc\n', // no closing delimiter
    "---\ntags: [unterminated\n---\n", // unterminated flow sequence
    "---\nid: 'unterminated\n---\n", // unterminated quote
    '---\n  stray_indent: 1\n---\n', // indentation with no parent key
    '---\nnot a key at all\n---\n',
  ];
  for (const raw of broken) {
    const parsed = parseFrontmatter(raw);
    assert.equal(parsed.ok, false, `accepted: ${JSON.stringify(raw)}`);
    assert.ok(parsed.error.length > 0);
  }
});

test('a number-looking scalar only becomes a number when it round-trips', () => {
  // The merge writes these values back into the user's note, so a value that
  // changes shape on the way through is a value the hook edited by accident.
  const { fields } = parseFrontmatter(
    ['---', 'count: 12', 'ticket: 0012', 'signed: +5', 'sha: 0e3b3d00', 'ver: 1.2.3', 'ratio: 1.50', '---', ''].join('\n'),
  );
  assert.equal(fields.count, 12);
  assert.equal(fields.ticket, '0012');
  assert.equal(fields.signed, '+5');
  assert.equal(fields.sha, '0e3b3d00');
  assert.equal(fields.ver, '1.2.3');
  assert.equal(fields.ratio, '1.50');

  const round = parseFrontmatter(serializeFrontmatter(fields));
  assert.deepEqual(round.fields, fields, 'a second pass must not change anything again');
});

test('a key that could move a prototype is refused, not parsed', () => {
  // These files are hand-edited and their parsed shape is spread into new
  // objects. `__proto__` as a mapping key is the classic way that turns into a
  // changed prototype; the parser refuses it, which makes the note unreadable,
  // which makes the hook leave it alone.
  for (const raw of [
    '---\n__proto__:\n  polluted: 1\n---\n\nbody\n',
    '---\nconstructor:\n  prototype: 1\n---\n\nbody\n',
    '---\ntools_used:\n  __proto__: 1\n---\n\nbody\n',
  ]) {
    const parsed = parseFrontmatter(raw);
    assert.equal(parsed.ok, false, `accepted: ${JSON.stringify(raw)}`);
    assert.match(parsed.error, /reserved key/);
  }
  assert.equal({}.polluted, undefined, 'Object.prototype is untouched');
});

test('serialization drops a reserved key even if one reaches it', () => {
  const output = serializeFrontmatter({ id: 'session-abc', __proto__: { x: 1 }, tags: [] });
  assert.ok(!output.includes('__proto__'));
  assert.ok(output.includes("id: 'session-abc'"));
});

test('keys the hook does not know about are kept, and kept last', () => {
  const output = serializeFrontmatter({
    reviewed_by: 'stack',
    id: 'session-abc',
    tags: ['x'],
    my_own_list: ['a', 'b'],
  });
  const lines = output.split('\n');
  assert.ok(lines.indexOf('id: \'session-abc\'') < lines.indexOf("reviewed_by: 'stack'"));
  assert.ok(output.includes("  - 'a'"));

  const round = parseFrontmatter(output);
  assert.equal(round.fields.reviewed_by, 'stack');
  assert.deepEqual(round.fields.my_own_list, ['a', 'b']);
});

test('an empty map is still emitted, so absent and empty stay different', () => {
  // A chat-only session used no tools. Dropping the key would make "no tools"
  // and "field missing" the same thing to a metadata filter.
  assert.ok(serializeFrontmatter({ tools_used: {} }).includes('tools_used: {}'));
  assert.ok(serializeFrontmatter({ tags: [] }).includes('tags: []'));
  assert.deepEqual(parseFrontmatter(serializeFrontmatter({ tools_used: {} })).fields.tools_used, {});
});

test('a tool name that would break out of the frontmatter is dropped', () => {
  // Confirmed exploitable before the fix: the map branch was the one field
  // whose keys were not escaped, and its keys are tool names from a transcript.
  const output = serializeFrontmatter({
    tools_used: {
      Bash: 3,
      ["Evil: 1\nsession_id: 'FORGED'\nstatus: 'superseded'\nzz"]: 1,
      ['__proto__']: 1,
      'has space': 2,
    },
  });
  assert.ok(output.includes('  Bash: 3'));
  assert.ok(!output.includes('FORGED'));
  assert.ok(!output.includes('__proto__'));
  assert.ok(!output.includes('has space'));

  const round = parseFrontmatter(output);
  assert.equal(round.ok, true, round.error);
  assert.deepEqual(round.fields.tools_used, { Bash: 3 });
  assert.equal(round.fields.session_id, undefined, 'no forged key survived');
});

test('a map count that is not a number becomes one', () => {
  const output = serializeFrontmatter({ tools_used: { Bash: "1\nid: 'forged'" } });
  assert.ok(!output.includes('forged'));
  assert.ok(output.includes('  Bash: 0'));
});

test('the field order is the frozen contract W-H2 builds against', () => {
  // Renaming or reordering these breaks `filter_metadata` on the other side of
  // the seam, so the list is asserted verbatim.
  assert.deepEqual(FIELD_ORDER, [
    'id', 'title', 'type', 'schema_version', 'collection', 'collection_source',
    'session_id', 'date', 'started_at', 'ended_at', 'duration_minutes', 'status',
    'concluded_at', 'end_reason', 'repo', 'branch', 'worktree', 'repos_touched',
    'cwd', 'cwds_seen', 'phase', 'tags', 'supersedes', 'resumed_from',
    'parent_session', 'child_sessions', 'commits', 'prs', 'memory_files',
    'plan_file', 'docs_touched', 'artifacts', 'files_modified', 'prompt_count',
    'command_count', 'agent', 'agent_type', 'origin', 'captured_by', 'generator',
    'tools_used', 'up', 'related', 'machine', 'retrievals', 'retrieved',
  ]);
});

// ------------------------------------------------ retrieval records (SC-1)

const RETRIEVAL_TEXT = [
  '---',
  "id: 'session-abc'",
  'retrievals:',
  "  - at: '2026-09-24T14:03:11Z'",
  '    channel: tool',
  '    tool: search_context',
  "    query: 'redacted query text'",
  '    filters: {collection: agentic-harness, limit: 10, tags: [ingest, db]}',
  "    results: ['obsidian:session-1a2b@0.8123', 'claude-mem:461@0.8540']",
  "    chunks: ['1849/4752@0.016393', '581/783@0.016393']",
  "  - at: '2026-09-24T14:05:00Z'",
  '    channel: session-start',
  '    tool: session-start',
  "    query: ''",
  '    filters: {}',
  '    results: []',
  '    chunks: []',
  'retrieved:',
  "  - '[[projects/agentic-harness/sessions/1a2b|Session 2026-09-20 — agentic-harness]]'",
  '---',
].join('\n');

const RETRIEVAL_FIELDS = {
  id: 'session-abc',
  retrievals: [
    {
      at: '2026-09-24T14:03:11Z',
      channel: 'tool',
      tool: 'search_context',
      query: 'redacted query text',
      filters: { collection: 'agentic-harness', limit: 10, tags: ['ingest', 'db'] },
      results: ['obsidian:session-1a2b@0.8123', 'claude-mem:461@0.8540'],
      chunks: ['1849/4752@0.016393', '581/783@0.016393'],
    },
    {
      at: '2026-09-24T14:05:00Z',
      channel: 'session-start',
      tool: 'session-start',
      query: '',
      filters: {},
      results: [],
      chunks: [],
    },
  ],
  retrieved: ['[[projects/agentic-harness/sessions/1a2b|Session 2026-09-20 — agentic-harness]]'],
};

test('a retrieval record round-trips: parse, serialize, parse is deep-equal and byte-identical', () => {
  const first = parseFrontmatter(RETRIEVAL_TEXT);
  assert.equal(first.ok, true, first.error);
  assert.deepEqual(first.fields, RETRIEVAL_FIELDS);

  const text = serializeFrontmatter(first.fields);
  assert.equal(text, RETRIEVAL_TEXT, 'the emitted form is exactly the SC-1 shape');
  const second = parseFrontmatter(text);
  assert.equal(second.ok, true, second.error);
  assert.deepEqual(second.fields, first.fields);
  assert.equal(serializeFrontmatter(second.fields), text, 'the second pass is byte-identical');
});

test('retrieval fields built in code serialize to the SC-1 shape whatever their key order', () => {
  const shuffled = {
    retrieved: RETRIEVAL_FIELDS.retrieved,
    retrievals: RETRIEVAL_FIELDS.retrievals.map((record) => Object.fromEntries(Object.entries(record).reverse())),
    id: 'session-abc',
  };
  assert.equal(serializeFrontmatter(shuffled), RETRIEVAL_TEXT);
});

test('empty retrieval fields are emitted as [] and read back as []', () => {
  const text = serializeFrontmatter({ retrievals: [], retrieved: [] });
  assert.ok(text.includes('retrievals: []'));
  assert.ok(text.includes('retrieved: []'));
  const round = parseFrontmatter(text);
  assert.equal(round.ok, true, round.error);
  assert.deepEqual(round.fields, { retrievals: [], retrieved: [] });
});

test('retrieved is also accepted in flow form', () => {
  const round = parseFrontmatter("---\nretrieved: ['[[a/b|B, with comma]]', '[[c/d]]']\n---\n");
  assert.equal(round.ok, true, round.error);
  assert.deepEqual(round.fields.retrieved, ['[[a/b|B, with comma]]', '[[c/d]]']);
});

test('a nested flow list inside a flow map parses, commas and brackets inside quotes respected', () => {
  const round = parseFrontmatter(
    [
      '---',
      'retrievals:',
      "  - query: 'a, b [c] {d}'",
      "    filters: {tags: [x, 'y, z'], note: 'it''s {fine}', on: true, limit: 5}",
      '---',
    ].join('\n'),
  );
  assert.equal(round.ok, true, round.error);
  assert.deepEqual(round.fields.retrievals, [
    { query: 'a, b [c] {d}', filters: { tags: ['x', 'y, z'], note: "it's {fine}", on: true, limit: 5 } },
  ]);
});

test('a malformed flow value inside a record is refused, never guessed at', () => {
  const bad = [
    'filters: {collection: agentic-harness, limit: 10',
    "filters: {collection: 'unterminated}",
    'filters: {tags: [a, b}',
    'filters: {deep: {nested: 1}}',
    'results: [a, [b]]',
    'results: [a, {b: 1}]',
    "results: ['unterminated]",
    'filters: {a: 1,, b: 2}',
    'filters: {__proto__: 1}',
    'filters: {constructor: 1}',
    'filters: {bad key: 1}',
    'results: [a]]',
  ];
  for (const line of bad) {
    const raw = ['---', 'retrievals:', "  - at: '2026-09-24T14:03:11Z'", `    ${line}`, '---'].join('\n');
    const result = parseFrontmatter(raw);
    assert.equal(result.ok, false, `should refuse: ${line}`);
  }
});

test('a record block that is not a list of mappings is refused', () => {
  const bad = [
    ['retrievals:', "  - 'just a string'"],
    ['retrievals:', '    channel: tool'],
    ['retrievals:', '  - at: x', '  channel: tool'],
    ['retrievals:', '  - at: x', '    at: y'],
    ['retrievals:', '  - at: x', '    __proto__: y'],
    ['retrievals:', '  - at: x', '      - nested'],
    ["retrievals: ['a', 'b']"],
  ];
  for (const lines of bad) {
    const result = parseFrontmatter(['---', ...lines, '---'].join('\n'));
    assert.equal(result.ok, false, `should refuse: ${lines.join(' / ')}`);
  }
});

test('an unknown key inside a record is kept, after the known ones', () => {
  const raw = [
    '---',
    'retrievals:',
    '  - reviewed_by: stack',
    "    at: '2026-09-24T14:03:11Z'",
    '    used: true',
    '    results: []',
    '---',
  ].join('\n');
  const first = parseFrontmatter(raw);
  assert.equal(first.ok, true, first.error);
  assert.deepEqual(first.fields.retrievals, [
    { reviewed_by: 'stack', at: '2026-09-24T14:03:11Z', used: true, results: [] },
  ]);
  const text = serializeFrontmatter(first.fields);
  assert.equal(
    text,
    [
      '---',
      'retrievals:',
      "  - at: '2026-09-24T14:03:11Z'",
      '    results: []',
      '    reviewed_by: stack',
      '    used: true',
      '---',
    ].join('\n'),
  );
  assert.deepEqual(parseFrontmatter(text).fields, first.fields);
});

test('record values that could break out of the block are quoted or dropped', () => {
  const text = serializeFrontmatter({
    retrievals: [
      {
        at: '2026-09-24T14:03:11Z',
        channel: "tool\nstatus: 'superseded'",
        query: "line one\nid: 'forged'",
        filters: { collection: 'x, y', 'bad key\n': 1, limit: 10 },
        results: ["a']\nid: 'forged"],
        'bad key': 'dropped',
      },
      'not a record',
      {},
    ],
  });
  const round = parseFrontmatter(text);
  assert.equal(round.ok, true, round.error);
  assert.equal(round.fields.id, undefined, 'no forged key survived');
  assert.equal(round.fields.status, undefined);
  assert.equal(round.fields.retrievals.length, 1, 'non-records and empty records are not emitted');
  const [record] = round.fields.retrievals;
  assert.equal(record.channel, "tool status: 'superseded'");
  assert.equal(record.query, "line one id: 'forged'");
  assert.deepEqual(record.filters, { collection: 'x, y', limit: 10 });
  assert.deepEqual(record.results, ["a'] id: 'forged"]);
  assert.equal('bad key' in record, false);
});

test('normalizeRecord returns what a record reads back as after a write', () => {
  assert.deepEqual(normalizeRecord({ query: 'a\nb', limit: 3 }), { query: 'a b', limit: 3 });
  assert.equal(normalizeRecord('not a record'), null);
  assert.equal(normalizeRecord({}), null);
});

test('an apostrophe inside a bare list item is text, and a stray bracket is refused', () => {
  const round = parseFrontmatter("---\ntags: [don't, x, 'quoted, one']\n---\n");
  assert.equal(round.ok, true, round.error);
  assert.deepEqual(round.fields.tags, ["don't", 'x', 'quoted, one']);
  assert.equal(parseFrontmatter('---\ntags: [a]]\n---\n').ok, false);
  assert.equal(parseFrontmatter('---\ntags: [a, [b]\n---\n').ok, false);
});

test('an unknown key holding a flow map keeps its old string meaning', () => {
  // The flow-map parser is for retrieval records. A hand-typed `{...}` under an
  // unknown key stays the string it always was, so the MAP emitter (which
  // writes counts) never gets the chance to turn its values into zeros.
  const round = parseFrontmatter('---\nmeta: {owner: stack}\n---\n');
  assert.equal(round.ok, true, round.error);
  assert.equal(round.fields.meta, '{owner: stack}');
});

test('words YAML 1.1 reads as booleans or null are quoted inside a record, so ingest reads strings too', () => {
  const text = serializeFrontmatter({
    retrievals: [
      {
        at: '2026-09-24T14:03:11Z',
        channel: 'tool',
        tool: 'search_context',
        query: 'q',
        filters: { collection: 'no', phase: 'Yes', tags: ['on', 'OFF', 'Null', 'plain'] },
        results: [],
      },
    ],
  });
  assert.match(text, /collection: 'no'/);
  assert.match(text, /phase: 'Yes'/);
  assert.match(text, /tags: \['on', 'OFF', 'Null', plain\]/);
  const round = parseFrontmatter(text);
  assert.deepEqual(round.fields.retrievals[0].filters, { collection: 'no', phase: 'Yes', tags: ['on', 'OFF', 'Null', 'plain'] });
});
