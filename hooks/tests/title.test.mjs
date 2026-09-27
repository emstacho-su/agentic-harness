/**
 * R-N3: a new note's title says something — `<date> · <collection> · <first
 * six words of the first prompt>`, and for a worker the agent type before the
 * words. The graph shows it through the Front Matter Title plugin, so it has to
 * read well on one line and carry nothing a note must not.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeFields } from '../lib/merge.mjs';
import { promptWords, sessionTitle, workerTitle } from '../lib/title.mjs';

test('a session title is date · collection · the first six words', () => {
  assert.equal(
    sessionTitle({
      date: '2026-09-24',
      collection: 'agentic-harness',
      prompt: 'ultracode. You are the orchestrator for unit N of the memory sprint',
    }),
    '2026-09-24 · agentic-harness · ultracode. You are the orchestrator for',
  );
});

test('a prompt shorter than six words is used whole', () => {
  assert.equal(promptWords('fix the sweep'), 'fix the sweep');
});

test('line breaks and runs of whitespace fold to single spaces', () => {
  assert.equal(promptWords('  I had a session\r\n\n stopped\tearly on this branch'), 'I had a session stopped early');
});

test('a slash command keeps its name and arguments', () => {
  assert.equal(promptWords('/code-review high --fix'), '/code-review high --fix');
});

test('a pasted block is dropped in favour of the words around it', () => {
  const prompt = [
    '<pasted_content id="a1b2">',
    'Error: ENOENT at C:\\c\\Users\\estac\\x.json',
    'stack line one',
    '</pasted_content>',
    'why does node fail to read this path on windows',
  ].join('\n');
  assert.equal(promptWords(prompt), 'why does node fail to read');
});

test('a fenced code block and paste or image placeholders are not words', () => {
  assert.equal(
    promptWords('```js\nconst x = 1;\n```\n[Pasted text #1 +20 lines] [Image #2] explain this output please'),
    'explain this output please',
  );
});

test('a prompt that is nothing but a paste still says so', () => {
  assert.equal(promptWords('<pasted_content id="z">only this</pasted_content>'), 'pasted text');
});

test('tokens with no letter or digit in them do not count as words', () => {
  assert.equal(promptWords('# Plan — - one two three four five six'), 'Plan one two three four five');
});

test('non-ASCII words are kept and counted as words', () => {
  assert.equal(promptWords('Ünïcödé naïve café résumé 東京 日本 extra'), 'Ünïcödé naïve café résumé 東京 日本');
});

test('a long unspaced prompt is capped without splitting a character', () => {
  const words = promptWords('😀'.repeat(200));
  assert.ok([...words].length <= 60, `capped, got ${[...words].length} code points`);
  assert.ok(!/[\uD800-\uDBFF]$/.test(words), 'no lone high surrogate at the cut');
  assert.equal(words.replace(/😀/g, ''), '', 'only whole emoji remain');
});

test('a secret in the first words is redacted, never copied into the title', () => {
  const title = sessionTitle({
    date: '2026-09-24',
    collection: 'misc',
    prompt: 'use token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa to push',
  });
  assert.doesNotMatch(title, /ghp_a{10}/);
});

test('a secret the session showed elsewhere is removed literally', () => {
  const title = sessionTitle({
    date: '2026-09-24',
    collection: 'misc',
    prompt: 'rotate hunter2hunter2hunter2 today',
    knownSecrets: ['hunter2hunter2hunter2'],
  });
  assert.doesNotMatch(title, /hunter2/);
});

test('control characters never reach the title', () => {
  assert.equal(promptWords('a\u0000b\u0007 c\u001b[31m d'), 'a b c 31m d');
});

test('no prompt at all leaves date · collection', () => {
  assert.equal(sessionTitle({ date: '2026-09-24', collection: 'misc', prompt: '' }), '2026-09-24 · misc');
});

test('a worker title puts the agent type before the task words', () => {
  assert.equal(
    workerTitle({
      date: '2026-09-24',
      collection: 'agentic-harness',
      agentType: 'phase-worker',
      prompt: 'Implement R-N3 titles test-first in the hooks package',
    }),
    '2026-09-24 · agentic-harness · phase-worker · Implement R-N3 titles test-first in the',
  );
});

test('a worker with no task words ends at the agent type', () => {
  assert.equal(
    workerTitle({ date: '2026-09-24', collection: 'misc', agentType: 'Explore', prompt: '' }),
    '2026-09-24 · misc · Explore',
  );
});

test('a title already on the note survives a merge: old notes and hand edits are left alone', () => {
  const merged = mergeFields(
    { title: 'Session 2026-09-20 — agentic-harness', status: 'active', tags: [] },
    { title: '2026-09-20 · agentic-harness · something else', status: 'active', tags: [] },
  );
  assert.equal(merged.title, 'Session 2026-09-20 — agentic-harness');
});

test('an empty title on the note is filled by the derived one', () => {
  const merged = mergeFields({ title: '', status: 'active', tags: [] }, { title: '2026-09-20 · misc · hi', status: 'active', tags: [] });
  assert.equal(merged.title, '2026-09-20 · misc · hi');
});

test('a secret longer than the scanned head is still redacted whole (review #1)', () => {
  const key = `-----BEGIN RSA PRIVATE KEY-----\n${'MIIJKAIBAAKCAgEAr7c3xYzQpLmN\n'.repeat(240)}-----END RSA PRIVATE KEY-----`;
  const words = promptWords(`${key}\nwhat is wrong with this key`);
  assert.doesNotMatch(words, /MIIJ|BEGIN RSA/);
});

test('the question after a paste longer than the scanned head is kept (review #7)', () => {
  const prompt = `<pasted_content id="p">${'log line\n'.repeat(700)}</pasted_content>\nwhy does this fail`;
  assert.equal(promptWords(prompt), 'why does this fail');
});

test('a wikilink or tag in the prompt does not become a link or tag in the title (review #2)', () => {
  assert.equal(promptWords('see [[projects/x/x|x]] and #urgent fix it now'), 'see projects/x/x x and urgent fix');
});
