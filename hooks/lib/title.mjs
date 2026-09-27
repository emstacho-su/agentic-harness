/**
 * A note's title (R-N3): `<date> · <collection> · <first six words of the
 * first prompt>`, and for a worker `<date> · <collection> · <agent type> ·
 * <first six words of the task>`.
 *
 * Files are named by UUID, so the title is what a person reads — in a search
 * result, and in the graph once the Front Matter Title plugin is installed. It
 * is built from the prompt, so it goes through the same redaction as the body,
 * and it is one line with nothing a heading or a link alias would trip over.
 */

import { redact, redactLiterals } from './redact.mjs';

/** Between the parts of a title: U+00B7, the spec's separator. */
export const TITLE_SEPARATOR = ' · ';

/** How many words of the prompt the title keeps. */
export const TITLE_WORDS = 6;

/** A cap on the words part, for a prompt with no spaces in it. */
const MAX_WORDS_CODE_POINTS = 60;

/** What a prompt that was only pasted content is called. */
const PASTED_ONLY = 'pasted text';

/** Pasted and quoted material: what was handed over, not what was asked. */
const NOT_WORDS = [
  /<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content>|$)/g,
  /```[\s\S]*?(?:```|$)/g,
  /\[(?:Pasted text|Image) #\d+[^\]]*\]/g,
];

/**
 * C0 and C1 controls. Built from char codes, as in text.mjs, so no raw control
 * byte sits in this file. U+2028 and U+2029 need no entry: the split on
 * whitespace below already breaks on them.
 */
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`,
  'g',
);

/**
 * Link and tag syntax. The title is also the body's H1, where Obsidian reads
 * `[[x]]` as a real link and `#tag` as a real tag.
 */
const LINK_BRACKETS = /[[\]]/g;
const LINK_PIPE = /\|/g;
const LEADING_HASHES = /^#+/;

const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * The first six words of a prompt, one line, redacted; `''` when the prompt
 * has none. A token with no letter or digit (`#`, `—`, `---`) is not a word.
 *
 * The whole prompt is read, as the body does: a cut made before `redact` can
 * split a secret so its rule no longer matches, or a paste so the question
 * after it is lost.
 */
export function promptWords(prompt, knownSecrets = []) {
  const whole = String(prompt ?? '');
  const asked = NOT_WORDS.reduce((text, pattern) => text.replace(pattern, ' '), whole);
  const safe = redact(redactLiterals(asked, knownSecrets) || asked)
    .replace(CONTROL_CHARS, ' ')
    .replace(LINK_BRACKETS, '')
    .replace(LINK_PIPE, ' ');
  const words = safe
    .split(/\s+/)
    .map((token) => token.replace(LEADING_HASHES, ''))
    .filter((token) => HAS_LETTER_OR_DIGIT.test(token))
    .slice(0, TITLE_WORDS);
  if (words.length === 0) return asked.trim() === whole.trim() ? '' : PASTED_ONLY;
  return capCodePoints(words.join(' '), MAX_WORDS_CODE_POINTS);
}

/** `<date> · <collection> · <words>`, the words left off when there are none. */
export function sessionTitle({ date, collection, prompt, knownSecrets = [] }) {
  return joinTitle([date, collection, promptWords(prompt, knownSecrets)]);
}

/** `<date> · <collection> · <agent type> · <words>`, empty parts left off. */
export function workerTitle({ date, collection, agentType, prompt, knownSecrets = [] }) {
  return joinTitle([date, collection, agentType, promptWords(prompt, knownSecrets)]);
}

function joinTitle(parts) {
  return parts
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(TITLE_SEPARATOR);
}

/** Whole graphemes up to `max` code points, so an emoji is never cut in half. */
function capCodePoints(text, max) {
  let out = '';
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = [...segment].length;
    if (used + size > max) break;
    out += segment;
    used += size;
  }
  return out.trimEnd();
}
