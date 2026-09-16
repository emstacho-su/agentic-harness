/**
 * Input validation at the one boundary that exists.
 *
 * `session_id` becomes a filename under the vault, so a payload that slipped a
 * separator or a `..` through would let anything that can write to the hook's
 * stdin write anywhere OneDrive can reach. It is validated against an
 * allow-list, not sanitised.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseHookInput } from '../lib/stdin.mjs';

const VALID = JSON.stringify({
  session_id: '11111111-1111-4111-8111-111111111111',
  transcript_path: 'C:/Users/estac/.claude/projects/x/11111111.jsonl',
  cwd: 'C:\\Users\\estac\\projects\\bb2dash',
  hook_event_name: 'SessionEnd',
  reason: 'clear',
});

test('a well-formed payload normalises to POSIX paths and a known reason', () => {
  const result = parseHookInput(VALID, {});
  assert.equal(result.ok, true);
  assert.equal(result.value.sessionId, '11111111-1111-4111-8111-111111111111');
  assert.equal(result.value.cwd, 'C:/Users/estac/projects/bb2dash');
  assert.equal(result.value.endReason, 'clear');
  assert.equal(result.value.parentSession, '');
});

test('an unknown reason becomes other rather than reaching the note verbatim', () => {
  const result = parseHookInput(JSON.stringify({ session_id: 'abc', reason: 'something-new' }), {});
  assert.equal(result.ok, true);
  assert.equal(result.value.endReason, 'other');
});

test('a session id that is not a safe filename is refused', () => {
  const rejected = [
    '../../../../Windows/System32/config',
    'a/b',
    'a\\b',
    '..',
    '.hidden',
    'con\u0000x',
    `${'x'.repeat(129)}`,
    '',
  ];
  for (const sessionId of rejected) {
    const result = parseHookInput(JSON.stringify({ session_id: sessionId, reason: 'clear' }), {});
    assert.equal(result.ok, false, `accepted a dangerous session_id: ${JSON.stringify(sessionId)}`);
  }
});

test('malformed stdin is a reason, never a throw', () => {
  for (const raw of ['', 'not json', '[]', 'null', '"a string"', '{']) {
    const result = parseHookInput(raw, {});
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
  }
});

test('the parent session comes from the payload first, then the environment', () => {
  const fromPayload = parseHookInput(
    JSON.stringify({ session_id: 'abc', parent_session_id: 'parent-1' }),
    { HARNESS_PARENT_SESSION: 'parent-env' },
  );
  assert.equal(fromPayload.value.parentSession, 'parent-1');

  const fromEnv = parseHookInput(JSON.stringify({ session_id: 'abc' }), {
    HARNESS_PARENT_SESSION: 'parent-env',
  });
  assert.equal(fromEnv.value.parentSession, 'parent-env');

  // A parent id is a filename-shaped identifier too, and is held to the same rule.
  const unsafe = parseHookInput(JSON.stringify({ session_id: 'abc' }), {
    HARNESS_PARENT_SESSION: '../elsewhere',
  });
  assert.equal(unsafe.value.parentSession, '');
});
