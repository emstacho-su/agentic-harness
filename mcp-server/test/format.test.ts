import { describe, expect, it } from 'vitest';
import type { SearchContext } from '../src/format.js';
import {
  formatDocument,
  formatDocumentNotFound,
  formatEmptyResults,
  formatSearchResults,
  truncate,
} from '../src/format.js';
import { makeDocument, makeRow } from './helpers.js';

const context = (overrides: Partial<SearchContext> = {}): SearchContext => ({
  query: 'ledger invariants',
  source: null,
  collection: null,
  matchCount: 10,
  minSimilarity: 0.7,
  ...overrides,
});

describe('formatSearchResults', () => {
  it('renders numbered results with source, collection, external_id and both scores', () => {
    const output = formatSearchResults(context(), [
      makeRow(),
      makeRow({
        chunk_id: 2,
        doc_source: 'obsidian',
        doc_collection: 'agentic-harness',
        doc_external: 'notes/a.md',
        fused_score: 0.016,
        vector_similarity: 0.7712,
      }),
    ]);

    expect(output).toContain('2 results for "ledger invariants" (all sources and collections, top 10)');
    expect(output).toContain('### 1. Ledger event types');
    expect(output).toContain('- source: claude-mem');
    expect(output).toContain('- collection: quant-edge-tracker');
    expect(output).toContain('- external_id: 4821');
    expect(output).toContain('- similarity: 0.8123');
    expect(output).toContain('- rrf: 0.032786 (ordering only)');
    expect(output).toContain('- ids: doc 10, chunk 1');
    expect(output).toContain('### 2.');
    expect(output).toContain('- collection: agentic-harness');
    expect(output).toContain('cash must never exceed zero');
    expect(output).toContain('call get_document');
  });

  it('tells the reader to judge by similarity, not by the RRF score', () => {
    const output = formatSearchResults(context(), [makeRow()]);
    expect(output).toContain('Judge relevance by `similarity`');
    expect(output).toContain('is not a percentage');
  });

  it('flags a sub-floor row as a literal keyword match rather than hiding it', () => {
    // min_similarity gates the vector arm only, so a full-text hit can sit below it.
    const output = formatSearchResults(context({ minSimilarity: 0.7 }), [
      makeRow({ vector_similarity: 0.5412 }),
    ]);

    expect(output).toContain('0.5412');
    expect(output).toContain('below the 0.7 floor');
    expect(output).toContain('literal keyword match');
  });

  it('does not flag rows when the floor is disabled', () => {
    const output = formatSearchResults(context({ minSimilarity: null }), [
      makeRow({ vector_similarity: 0.5412 }),
    ]);
    expect(output).toContain('- similarity: 0.5412');
    expect(output).not.toContain('below the');
  });

  it('renders a null similarity as n/a', () => {
    const output = formatSearchResults(context(), [makeRow({ vector_similarity: null })]);
    expect(output).toContain('- similarity: n/a');
  });

  it('names both active filters in the header', () => {
    const output = formatSearchResults(
      context({ source: 'obsidian', collection: 'ist335', matchCount: 5 }),
      [makeRow({ doc_source: 'obsidian', doc_collection: 'ist335' })],
    );
    expect(output).toContain('source "obsidian", collection "ist335"');
  });

  it('omits the collection line for an untagged document', () => {
    const output = formatSearchResults(context(), [makeRow({ doc_collection: null })]);
    expect(output).not.toContain('- collection:');
  });

  it('uses singular wording for one result', () => {
    expect(formatSearchResults(context(), [makeRow()])).toContain('1 result for');
  });

  it('falls back to (untitled) when the document has no title', () => {
    expect(formatSearchResults(context(), [makeRow({ doc_title: null })])).toContain(
      '### 1. (untitled)',
    );
  });

  it('omits the metadata line when metadata is empty', () => {
    expect(formatSearchResults(context(), [makeRow({ doc_metadata: {} })])).not.toContain('- metadata:');
    expect(formatSearchResults(context(), [makeRow({ doc_metadata: null })])).not.toContain('- metadata:');
  });

  it('truncates an oversized chunk rather than flooding the context', () => {
    const output = formatSearchResults(context(), [makeRow({ chunk_content: 'x'.repeat(9_000) })]);
    expect(output).toContain('[truncated, 5000 more characters]');
    expect(output.length).toBeLessThan(6_000);
  });

  it('delegates to the empty-result message when there are no rows', () => {
    expect(formatSearchResults(context({ query: 'nothing' }), [])).toBe(
      formatEmptyResults(context({ query: 'nothing' })),
    );
  });
});

describe('formatEmptyResults', () => {
  it('frames zero rows as a real answer, not a failure', () => {
    const output = formatEmptyResults(context({ query: 'banana bread with walnuts' }));

    expect(output).toContain('Nothing relevant found for "banana bread with walnuts"');
    expect(output).toContain('0.7 cosine similarity floor');
    expect(output).toContain('a real answer, not a failure');
    expect(output).not.toMatch(/error|failed/i);
  });

  it('suggests lowering the floor when one is active', () => {
    expect(formatEmptyResults(context())).toContain('Lower `min_similarity`');
  });

  it('does not suggest lowering a floor that is already disabled', () => {
    const output = formatEmptyResults(context({ minSimilarity: null }));
    expect(output).toContain('no similarity floor');
    expect(output).not.toContain('Lower `min_similarity`');
  });

  it('lists the real collections when a collection filter came up empty', () => {
    const output = formatEmptyResults(context({ collection: 'IST335' }), [
      { collection: 'estac', documents: 513 },
      { collection: 'ist335', documents: 14 },
    ]);

    expect(output).toContain('collection "IST335"');
    expect(output).toContain('case-sensitive');
    expect(output).toContain('estac (513)');
    expect(output).toContain('ist335 (14)');
  });

  it('caps the listed collections and says how many were omitted', () => {
    const many = Array.from({ length: 30 }, (_unused, i) => ({
      collection: `c${i}`,
      documents: 30 - i,
    }));
    const output = formatEmptyResults(context({ collection: 'nope' }), many);

    expect(output).toContain('and 10 more');
    expect(output).not.toContain('c25');
  });

  it('suggests dropping the filters when any were applied', () => {
    expect(formatEmptyResults(context({ source: 'hermes' }))).toContain('Drop the filters');
  });
});

describe('formatDocument', () => {
  it('renders the header block, collection and full body', () => {
    const output = formatDocument(makeDocument());

    expect(output).toContain('# Ledger model');
    expect(output).toContain('- source: obsidian');
    expect(output).toContain('- collection: agentic-harness');
    expect(output).toContain('- external_id: notes/ledger.md');
    expect(output).toContain('- agent: claude-code');
    expect(output).toContain('- doc_id: 10');
    expect(output).toContain('Full note body.');
  });

  it('normalises a Date from the pg driver to ISO 8601 rather than a locale string', () => {
    const output = formatDocument(
      makeDocument({ created_at: new Date('2026-09-09T18:35:00.000Z'), updated_at: null }),
    );

    expect(output).toContain('- created_at: 2026-09-09T18:35:00.000Z');
    expect(output).not.toContain('GMT');
    expect(output).not.toContain('- updated_at:');
  });

  it('passes an unparseable timestamp through rather than dropping it', () => {
    expect(formatDocument(makeDocument({ created_at: 'not a date' }))).toContain(
      '- created_at: not a date',
    );
  });

  it('omits optional fields that are null', () => {
    const output = formatDocument(
      makeDocument({
        agent: null,
        collection: null,
        created_at: null,
        updated_at: null,
        metadata: null,
        title: null,
      }),
    );

    expect(output).toContain('# (untitled)');
    expect(output).not.toContain('- agent:');
    expect(output).not.toContain('- collection:');
    expect(output).not.toContain('- created_at:');
    expect(output).not.toContain('- metadata:');
  });

  it('truncates a very large body', () => {
    expect(formatDocument(makeDocument({ body: 'y'.repeat(25_000) }))).toContain(
      '[truncated, 5000 more characters]',
    );
  });
});

describe('formatDocumentNotFound', () => {
  it('echoes the key and explains the likely mistakes', () => {
    const output = formatDocumentNotFound('claude-mem', '999999');
    expect(output).toContain('source="claude-mem"');
    expect(output).toContain('external_id="999999"');
    expect(output).toContain('empty result, not an error');
  });
});

describe('truncate', () => {
  it('leaves short strings alone', () => {
    expect(truncate('abc', 10)).toBe('abc');
  });

  it('reports how much was cut', () => {
    expect(truncate('abcdef', 3)).toBe('abc\n… [truncated, 3 more characters]');
  });
});
