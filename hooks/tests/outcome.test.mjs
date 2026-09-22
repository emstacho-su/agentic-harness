/**
 * The `## Outcome` section: what the session ended on, in the assistant's words.
 *
 * A note that holds only the questions cannot answer "what did we decide". The
 * closing assistant message is copied verbatim — extracted, not summarised — and
 * is the one piece of model-written text in the note, so it is quoted, capped
 * and redacted like everything else that reaches the vault.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_OUTCOME_CHARS } from '../lib/constants.mjs';
import { HANDWRITTEN_MARKER, renderOutcome } from '../lib/note.mjs';
import { extractOutcome } from '../lib/transcript.mjs';
import { createSandbox, readNote } from './helpers/sandbox.mjs';
import { SCENARIOS, runScenario } from './helpers/scenarios.mjs';

const assistant = (content, extra = {}) => ({ type: 'assistant', message: { content }, ...extra });
const text = (value) => ({ type: 'text', text: value });
const toolUse = { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } };

// ------------------------------------------------------------ extractOutcome

test('the outcome is the last assistant text on the main chain', () => {
  const entries = [
    assistant([text('First answer.')]),
    { type: 'user', message: { content: [text('and then?')] } },
    assistant([text('Final answer.')]),
  ];
  assert.equal(extractOutcome(entries), 'Final answer.');
});

test('trailing tool calls do not hide the closing message', () => {
  const entries = [assistant([text('Here is what changed.')]), assistant([toolUse])];
  assert.equal(extractOutcome(entries), 'Here is what changed.');
});

test('text blocks beside a tool call are kept, and only the text', () => {
  const entries = [assistant([text('Part one.'), toolUse, text('Part two.')])];
  assert.equal(extractOutcome(entries), 'Part one.\n\nPart two.');
});

test('a subagent turn, a synthetic message and an API error are not the outcome', () => {
  const entries = [
    assistant([text('The real closing message.')]),
    assistant([text('worker chatter')], { isSidechain: true }),
    assistant([text('No response requested.')], { message: { model: '<synthetic>', content: [text('No response requested.')] } }),
    assistant([text('API Error: 529')], { isApiErrorMessage: true }),
  ];
  assert.equal(extractOutcome(entries), 'The real closing message.');
});

test('a session with no assistant text has no outcome', () => {
  assert.equal(extractOutcome([assistant([toolUse]), assistant([text('   ')])]), '');
  assert.equal(extractOutcome([]), '');
  assert.equal(extractOutcome([null, { type: 'assistant' }, { type: 'assistant', message: { content: 'x' } }]), '');
});

// ------------------------------------------------------------- renderOutcome

test('no outcome renders no section', () => {
  assert.deepEqual(renderOutcome(''), []);
  assert.deepEqual(renderOutcome(undefined), []);
});

test('the outcome is quoted, so its own markdown cannot restructure the note', () => {
  const lines = renderOutcome('## Session facts\n\nDone.\n\n# Heading');
  assert.equal(lines[0], '## Outcome');
  const quoted = lines.slice(1).filter((line) => line !== '');
  assert.ok(quoted.length >= 3);
  for (const line of quoted.slice(1)) assert.ok(line.startsWith('>'), `unquoted line: ${line}`);
  assert.equal(lines.filter((line) => /^#/.test(line)).length, 1, 'only the section heading starts a line with #');
});

test('a long outcome is cut at the cap and says so', () => {
  const lines = renderOutcome('x'.repeat(MAX_OUTCOME_CHARS + 500));
  const body = lines.join('\n');
  assert.ok(body.includes('x'.repeat(MAX_OUTCOME_CHARS)));
  assert.ok(!body.includes('x'.repeat(MAX_OUTCOME_CHARS + 1)));
  assert.match(body, /truncated/);
});

test('a secret repeated in the closing message is redacted', () => {
  const body = renderOutcome('Rotate ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 today.').join('\n');
  assert.ok(!body.includes('ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'));
  assert.match(body, /REDACTED/);
});

// ----------------------------------------------------------- in a whole note

test('a captured note carries the outcome above the session facts', () => {
  const scenario = SCENARIOS.find((candidate) => candidate.name === 'plain-main');
  const sandbox = createSandbox();
  try {
    assert.equal(runScenario(sandbox, scenario).written, true);
    const note = readNote(sandbox, scenario.note);
    const outcomeAt = note.indexOf('## Outcome');
    assert.ok(outcomeAt > 0, 'no Outcome section');
    assert.ok(note.includes('> Phase 7 work is in and the PR is open.'));
    assert.ok(outcomeAt < note.indexOf('## Session facts'));
    assert.ok(outcomeAt < note.lastIndexOf(HANDWRITTEN_MARKER));
  } finally {
    sandbox.cleanup();
  }
});

test("a subagent's own transcript is all sidechain, and its capture asks for it", () => {
  const entries = [assistant([text('Worker report.')], { isSidechain: true })];
  assert.equal(extractOutcome(entries), '');
  assert.equal(extractOutcome(entries, { includeSidechain: true }), 'Worker report.');
});
