/**
 * Review #5: a transcript bigger than the capture's read budget is read from
 * its tail, so `prompts[0]` is a prompt from the middle. The title keeps its
 * first value for good, so it is built from the transcript's real first prompt.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { extractPrompts, firstPromptText, readEntries } from '../lib/transcript.mjs';

const userTurn = (text, n) =>
  JSON.stringify({ type: 'user', origin: { kind: 'human' }, timestamp: `2026-09-24T10:00:0${n}Z`, message: { content: text } });
const filler = (i) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(200) }] }, i });

function transcript(t, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-prompt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

test('a transcript read whole: the first prompt is the first of the prompts already extracted', (t) => {
  const file = transcript(t, [userTurn('first ask here', 1), filler(1), userTurn('later ask', 2)]);
  const prompts = extractPrompts(readEntries(file, 1 << 20));
  assert.equal(firstPromptText(file, prompts, 1 << 20), 'first ask here');
});

test('a transcript read from its tail: the first prompt comes from its head', (t) => {
  const lines = [userTurn('first ask here', 1), ...Array.from({ length: 40 }, (_, i) => filler(i)), userTurn('later ask', 2)];
  const file = transcript(t, lines);
  const maxBytes = 2000;
  const prompts = extractPrompts(readEntries(file, maxBytes));
  assert.equal(prompts[0].text, 'later ask', 'the fixture really is tail-read');
  assert.equal(firstPromptText(file, prompts, maxBytes), 'first ask here');
});

test('a head with no complete prompt gives no words rather than a later prompt', (t) => {
  const huge = userTurn('y'.repeat(70 * 1024), 1);
  const file = transcript(t, [huge, ...Array.from({ length: 40 }, (_, i) => filler(i)), userTurn('later ask', 2)]);
  const prompts = extractPrompts(readEntries(file, 2000));
  assert.equal(firstPromptText(file, prompts, 2000), '');
});
