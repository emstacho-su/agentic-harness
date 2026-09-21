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

import { FIELD_ORDER, parseFrontmatter, serializeFrontmatter } from '../lib/frontmatter.mjs';

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
    'tools_used', 'up', 'related',
  ]);
});
