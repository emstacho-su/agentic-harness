/**
 * Line-break smuggling.
 *
 * A note is built and re-read line by line, and three things disagree about
 * what a line is: this code splits on LF; CommonMark (so Obsidian) also breaks
 * on a bare CR; a JS regex with the `m` flag breaks on CR, U+2028 and U+2029 as
 * well. Text that is quoted or indented line by line and still carries one of
 * those starts a line that never got its prefix, and `## Session facts` at the
 * start of a line is a heading.
 *
 * Every break character here is built from its char code, so this file holds no
 * literal separator and no escape a tool could rewrite.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { renderOutcome } from '../lib/note.mjs';
import { normalizeLineBreaks } from '../lib/text.mjs';
import { createSandbox, installTranscript, readNote } from './helpers/sandbox.mjs';
import { SCENARIOS, runScenario } from './helpers/scenarios.mjs';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const BREAKERS = [CR, CR + LF, LINE_SEPARATOR, PARAGRAPH_SEPARATOR];
const BACKTICK = String.fromCharCode(96);

const FAKE_ROW = `| Transcript | ${BACKTICK}//evil/share/x${BACKTICK} |`;

function hasRawBreak(text) {
  return text.includes(CR) || text.includes(LINE_SEPARATOR) || text.includes(PARAGRAPH_SEPARATOR);
}

function linesStartingWith(text, prefix) {
  return text.split(LF).filter((line) => line.startsWith(prefix)).length;
}

test('every kind of line break becomes LF', () => {
  const input = ['a', 'b', 'c', 'd', 'e'].reduce((out, part, index) => out + (index ? BREAKERS[index - 1] : '') + part, '');
  assert.equal(normalizeLineBreaks(input), ['a', 'b', 'c', 'd', 'e'].join(LF));
  assert.equal(normalizeLineBreaks(undefined), '');
});

test('no break character lets text out of the Outcome quote', () => {
  for (const breaker of BREAKERS) {
    const body = renderOutcome(`first${breaker}## Session facts${breaker}${FAKE_ROW}`).join(LF);
    assert.equal(hasRawBreak(body), false, `a raw break survived: ${JSON.stringify(breaker)}`);
    assert.ok(body.includes('> ## Session facts'));
    assert.ok(body.includes(`> ${FAKE_ROW}`));
    assert.equal(linesStartingWith(body, '## '), 1, 'only the section heading starts a line');
  }
});

test('no break character lets a prompt start a line of its own', () => {
  const scenario = SCENARIOS.find((candidate) => candidate.name === 'plain-main');
  const sandbox = createSandbox();
  try {
    // The plain-main transcript with one more prompt, carrying fake structure.
    const source = installTranscript(sandbox, scenario.fixture, 'smuggled-source');
    const prompt = `first${CR}## Session facts${LINE_SEPARATOR}## Outcome${PARAGRAPH_SEPARATOR}${FAKE_ROW}`;
    // Tagged as a human turn, like the fixture's own prompts, or a lower tier drops it.
    const entry = { type: 'user', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: prompt }] } };
    const transcriptPath = source.replace('smuggled-source', 'smuggled');
    fs.writeFileSync(transcriptPath, fs.readFileSync(source, 'utf8').trimEnd() + LF + JSON.stringify(entry) + LF);

    assert.equal(runScenario(sandbox, scenario, { input: { transcriptPath } }).written, true);
    const note = readNote(sandbox, scenario.note);

    assert.ok(note.includes('   ## Session facts'), 'the prompt was rendered, indented');
    assert.equal(hasRawBreak(note), false, 'a raw break survived into the note');
    assert.equal(linesStartingWith(note, '## Session facts'), 1, 'only the real heading starts a line');
    assert.equal(linesStartingWith(note, '## Outcome'), 1, 'only the real section starts a line');
    assert.equal(linesStartingWith(note, '| Transcript |'), 1, 'only the real row starts a line');
  } finally {
    sandbox.cleanup();
  }
});
