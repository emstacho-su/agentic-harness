/**
 * Read the controlled vocabulary out of `docs/tags.md`.
 *
 * Two tests need it — the parity check against `vocabulary.mjs` and the set
 * difference over the fixtures — and they have to read the *document*, not the
 * module, or the check is circular.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const TAGS_DOC = path.join(HERE, '..', '..', '..', 'docs', 'tags.md');

const SECTIONS = ['areas', 'activities', 'phase', 'sentinel'];

/** @returns {{areas: string[], activities: string[], phase: string[], sentinel: string[]}} */
export function parseTagsDoc(markdown = fs.readFileSync(TAGS_DOC, 'utf8')) {
  const fence = markdown.match(/```text\n([\s\S]*?)```/);
  if (!fence) throw new Error('docs/tags.md has no ```text vocabulary block');

  const sections = Object.fromEntries(SECTIONS.map((name) => [name, []]));
  let current = '';
  for (const line of fence[1].split('\n')) {
    const term = line.trim();
    if (!term) continue;
    if (term.startsWith('#')) {
      current = term.replace(/^#\s*/, '');
      if (!SECTIONS.includes(current)) throw new Error(`unknown section "${current}" in docs/tags.md`);
      continue;
    }
    if (!current) throw new Error(`term "${term}" appears before any section heading`);
    sections[current].push(term);
  }
  return sections;
}
