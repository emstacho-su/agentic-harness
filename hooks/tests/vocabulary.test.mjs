/**
 * `docs/tags.md` and `hooks/lib/vocabulary.mjs` say the same thing.
 *
 * Two copies of a controlled vocabulary drift the moment nobody is checking.
 * The doc is the one a person reads and the module is the one the classifier
 * reads, so the only safe arrangement is a test that fails when they disagree.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  ACTIVITY_TAGS,
  AREA_TAGS,
  PHASE_TAG_TEMPLATE,
  UNCLASSIFIED,
  isKnownTag,
  phaseTag,
} from '../lib/vocabulary.mjs';
import { TAGS_DOC, parseTagsDoc } from './helpers/tags-doc.mjs';

test('the documented vocabulary is exactly the one the classifier can emit', () => {
  const doc = parseTagsDoc();
  assert.deepEqual(doc.areas, [...AREA_TAGS]);
  assert.deepEqual(doc.activities, [...ACTIVITY_TAGS]);
  assert.deepEqual(doc.phase, [PHASE_TAG_TEMPLATE]);
  assert.deepEqual(doc.sentinel, [UNCLASSIFIED]);
});

test('every documented term has a row explaining what raises it', () => {
  const markdown = fs.readFileSync(TAGS_DOC, 'utf8');
  for (const term of [...AREA_TAGS, ...ACTIVITY_TAGS]) {
    assert.ok(
      markdown.includes(`| \`${term}\` |`),
      `docs/tags.md documents no signal for "${term}"`,
    );
  }
});

test('isKnownTag accepts the phase family and rejects near misses', () => {
  assert.equal(isKnownTag('retrieval'), true);
  assert.equal(isKnownTag('phase-7'), true);
  assert.equal(isKnownTag('phase-11'), true);
  assert.equal(isKnownTag(UNCLASSIFIED), true);

  assert.equal(isKnownTag('phase-0'), false);
  assert.equal(isKnownTag('phase-100'), false);
  assert.equal(isKnownTag('phase'), false);
  assert.equal(isKnownTag('Retrieval'), false, 'the vocabulary is lowercase; casing is a different term');
  assert.equal(isKnownTag(''), false);
  assert.equal(isKnownTag(null), false);
});

test('phaseTag refuses numbers outside the documented range', () => {
  assert.equal(phaseTag(7), 'phase-7');
  assert.equal(phaseTag('11'), 'phase-11');
  assert.equal(phaseTag(0), '');
  assert.equal(phaseTag(100), '');
  assert.equal(phaseTag('seven'), '');
});
