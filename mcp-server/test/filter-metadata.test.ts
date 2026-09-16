import { describe, expect, it } from 'vitest';
import {
  buildFilterMetadata,
  describeFilterMetadata,
  METADATA_KEYS,
} from '../src/tools/filter-metadata.js';

describe('buildFilterMetadata', () => {
  it('returns null when nothing narrows the search', () => {
    expect(buildFilterMetadata({})).toBeNull();
  });

  it('builds a single-key object for repo', () => {
    expect(buildFilterMetadata({ repo: 'emstacho-su/bb2dash' })).toEqual({
      repo: 'emstacho-su/bb2dash',
    });
  });

  it('builds a single-key object for phase', () => {
    expect(buildFilterMetadata({ phase: 'phase-7' })).toEqual({ phase: 'phase-7' });
  });

  it('builds an array value for tags', () => {
    expect(buildFilterMetadata({ tags: ['retrieval', 'review'] })).toEqual({
      tags: ['retrieval', 'review'],
    });
  });

  it('merges all three into one contains-match object', () => {
    expect(
      buildFilterMetadata({ repo: 'emstacho-su/bb2dash', phase: 'phase-7', tags: ['review'] }),
    ).toEqual({ repo: 'emstacho-su/bb2dash', phase: 'phase-7', tags: ['review'] });
  });

  it('uses the frozen frontmatter key names', () => {
    const filter = buildFilterMetadata({ repo: 'r', phase: 'p', tags: ['t'] }) ?? {};
    expect(Object.keys(filter).sort()).toEqual(
      [METADATA_KEYS.phase, METADATA_KEYS.repo, METADATA_KEYS.tags].sort(),
    );
  });

  it('keeps tags a string array — the type is frozen by the seam', () => {
    const filter = buildFilterMetadata({ tags: ['6'] }) ?? {};
    expect(filter['tags']).toEqual(['6']);
    expect(typeof (filter['tags'] as string[])[0]).toBe('string');
  });

  it('trims surrounding whitespace', () => {
    expect(buildFilterMetadata({ repo: '  owner/name  ', tags: [' review '] })).toEqual({
      repo: 'owner/name',
      tags: ['review'],
    });
  });

  it('drops a blank value rather than filtering on the empty string', () => {
    expect(buildFilterMetadata({ repo: '   ' })).toBeNull();
    expect(buildFilterMetadata({ tags: ['  ', ''] })).toBeNull();
  });

  it('de-duplicates tags while keeping the caller order', () => {
    expect(buildFilterMetadata({ tags: ['review', 'ingest', 'review'] })).toEqual({
      tags: ['review', 'ingest'],
    });
  });

  it('never mutates the input', () => {
    const tags = ['review', 'review'];
    const input = { repo: ' owner/name ', tags };
    buildFilterMetadata(input);

    expect(tags).toEqual(['review', 'review']);
    expect(input.repo).toBe(' owner/name ');
  });

  it('returns a fresh object on every call', () => {
    const first = buildFilterMetadata({ repo: 'r' });
    const second = buildFilterMetadata({ repo: 'r' });
    expect(first).not.toBe(second);
  });

  it('ignores a non-array tags value instead of throwing', () => {
    expect(buildFilterMetadata({ tags: 'review' as unknown as string[] })).toBeNull();
  });
});

describe('describeFilterMetadata', () => {
  it('says nothing when there is no filter', () => {
    expect(describeFilterMetadata(null)).toEqual([]);
  });

  it('quotes scalars and brackets arrays', () => {
    expect(
      describeFilterMetadata({ repo: 'emstacho-su/bb2dash', tags: ['review', 'db'] }),
    ).toEqual(['repo "emstacho-su/bb2dash"', 'tags [review, db]']);
  });
});
