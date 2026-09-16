import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '../src/config.js';
import { DatabaseError } from '../src/errors.js';
import { handleSearchContext, type ToolDeps } from '../src/tools/search-context.js';
import {
  FakeEmbedder,
  FakeRagClient,
  makeConfig,
  makeRow,
  textOf,
  ThrowingEmbedder,
} from './helpers.js';

function deps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    embedder: new FakeEmbedder(),
    rag: new FakeRagClient([makeRow()]),
    config: makeConfig(),
    ...overrides,
  };
}

describe('search_context — input validation', () => {
  it('rejects a missing query', async () => {
    const result = await handleSearchContext(deps(), {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid arguments for search_context');
    expect(textOf(result)).toContain('query');
  });

  it('rejects an empty or whitespace-only query', async () => {
    const result = await handleSearchContext(deps(), { query: '   ' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('query must not be empty');
  });

  it('rejects a non-string query', async () => {
    const result = await handleSearchContext(deps(), { query: 42 });
    expect(result.isError).toBe(true);
  });

  it('rejects a limit above the maximum', async () => {
    const result = await handleSearchContext(deps(), { query: 'x', limit: 500 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('limit must be at most 50');
  });

  it('rejects a fractional limit', async () => {
    const result = await handleSearchContext(deps(), { query: 'x', limit: 2.5 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('limit must be a whole number');
  });

  it('rejects an unknown source', async () => {
    const result = await handleSearchContext(deps(), { query: 'x', source: 'notion' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('source');
  });

  it('rejects an empty collection', async () => {
    const result = await handleSearchContext(deps(), { query: 'x', collection: '  ' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('collection must not be empty');
  });

  it('rejects a min_similarity outside 0..1', async () => {
    const high = await handleSearchContext(deps(), { query: 'x', min_similarity: 1.4 });
    expect(high.isError).toBe(true);
    expect(textOf(high)).toContain('min_similarity must be at most 1');

    const low = await handleSearchContext(deps(), { query: 'x', min_similarity: -0.2 });
    expect(low.isError).toBe(true);
  });

  it('accepts each known source', async () => {
    for (const source of ['obsidian', 'claude-mem', 'hermes']) {
      const result = await handleSearchContext(deps(), { query: 'x', source });
      expect(result.isError).toBeUndefined();
    }
  });
});

describe('search_context — retrieval', () => {
  it('embeds the query and passes both the vector and the raw text to rag.search', async () => {
    const embedder = new FakeEmbedder();
    const rag = new FakeRagClient([makeRow()]);
    await handleSearchContext(deps({ embedder, rag }), { query: 'ledger invariants' });

    expect(embedder.calls).toEqual(['ledger invariants']);
    const call = rag.searchCalls[0];
    expect(call?.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(call?.queryText).toBe('ledger invariants');
    expect(call?.rrfK).toBe(60);
  });

  it('defaults match_count to the configured default', async () => {
    const rag = new FakeRagClient([makeRow()]);
    await handleSearchContext(deps({ rag }), { query: 'x' });
    expect(rag.searchCalls[0]?.matchCount).toBe(10);
  });

  it('honours an explicit limit', async () => {
    const rag = new FakeRagClient([makeRow()]);
    await handleSearchContext(deps({ rag }), { query: 'x', limit: 3 });
    expect(rag.searchCalls[0]?.matchCount).toBe(3);
  });

  it('clamps a limit above the configured maximum', async () => {
    const rag = new FakeRagClient([makeRow()]);
    const config = makeConfig({
      search: {
        defaultMatchCount: 10,
        maxMatchCount: 5,
        rrfK: 60,
        maxPerDocument: 3,
        minSimilarity: 0.7,
      },
    });
    await handleSearchContext(deps({ rag, config }), { query: 'x', limit: 40 });
    expect(rag.searchCalls[0]?.matchCount).toBe(5);
  });

  it('passes null filters when none are given', async () => {
    const rag = new FakeRagClient([makeRow()]);
    await handleSearchContext(deps({ rag }), { query: 'x' });
    expect(rag.searchCalls[0]?.filterSource).toBeNull();
    expect(rag.searchCalls[0]?.filterCollection).toBeNull();
  });

  it('narrows to one source and returns only that source', async () => {
    const rag = new FakeRagClient([
      makeRow({ doc_source: 'claude-mem' }),
      makeRow({ chunk_id: 2, doc_source: 'obsidian', doc_external: 'notes/a.md' }),
    ]);

    const result = await handleSearchContext(deps({ rag }), { query: 'x', source: 'obsidian' });

    expect(rag.searchCalls[0]?.filterSource).toBe('obsidian');
    expect(textOf(result)).toContain('source "obsidian"');
    expect(textOf(result)).toContain('notes/a.md');
    expect(textOf(result)).not.toContain('- source: claude-mem');
  });

  it('narrows to one collection and returns only that collection', async () => {
    const rag = new FakeRagClient([
      makeRow({ doc_collection: 'quant-edge-tracker' }),
      makeRow({ chunk_id: 2, doc_collection: 'ist335', doc_external: 'wa2.md' }),
    ]);

    const result = await handleSearchContext(deps({ rag }), { query: 'x', collection: 'ist335' });

    expect(rag.searchCalls[0]?.filterCollection).toBe('ist335');
    expect(textOf(result)).toContain('collection "ist335"');
    expect(textOf(result)).toContain('wa2.md');
    expect(textOf(result)).not.toContain('- collection: quant-edge-tracker');
  });

  it('combines the source and collection filters', async () => {
    const rag = new FakeRagClient([makeRow({ doc_source: 'obsidian', doc_collection: 'ce2' })]);
    await handleSearchContext(deps({ rag }), { query: 'x', source: 'obsidian', collection: 'ce2' });

    expect(rag.searchCalls[0]?.filterSource).toBe('obsidian');
    expect(rag.searchCalls[0]?.filterCollection).toBe('ce2');
  });

  it('passes the configured similarity floor and per-document cap', async () => {
    const rag = new FakeRagClient([makeRow()]);
    await handleSearchContext(deps({ rag }), { query: 'x' });

    expect(rag.searchCalls[0]?.minSimilarity).toBe(0.7);
    expect(rag.searchCalls[0]?.maxPerDocument).toBe(3);
  });

  it('lets a caller widen the net with min_similarity', async () => {
    const rag = new FakeRagClient([makeRow()]);
    await handleSearchContext(deps({ rag }), { query: 'x', min_similarity: 0.4 });
    expect(rag.searchCalls[0]?.minSimilarity).toBe(0.4);
  });

  it('accepts min_similarity 0 without falling back to the default', async () => {
    const rag = new FakeRagClient([makeRow()]);
    await handleSearchContext(deps({ rag }), { query: 'x', min_similarity: 0 });
    expect(rag.searchCalls[0]?.minSimilarity).toBe(0);
  });

  it('formats results for a reader rather than dumping JSON', async () => {
    const result = await handleSearchContext(deps(), { query: 'ledger' });
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(text).toContain('### 1. Ledger event types');
    expect(text).not.toContain('"chunk_id"');
  });
});

describe('search_context — session frontmatter filters', () => {
  const sessionRow = (overrides: Record<string, unknown> = {}, row: Partial<typeof makeRow> = {}) =>
    makeRow({
      doc_source: 'obsidian',
      doc_collection: 'bb2dash',
      doc_metadata: {
        type: 'session',
        repo: 'emstacho-su/bb2dash',
        phase: 'phase-7',
        status: 'concluded',
        tags: ['retrieval', 'review'],
        ...overrides,
      },
      ...(row as object),
    });

  it('sends no metadata filter when none of the three is given', async () => {
    const rag = new FakeRagClient([makeRow()]);
    await handleSearchContext(deps({ rag }), { query: 'x' });
    expect(rag.searchCalls[0]?.filterMetadata).toBeNull();
  });

  it('builds a contains-match from repo', async () => {
    const rag = new FakeRagClient([sessionRow()]);
    await handleSearchContext(deps({ rag }), { query: 'x', repo: 'emstacho-su/bb2dash' });
    expect(rag.searchCalls[0]?.filterMetadata).toEqual({ repo: 'emstacho-su/bb2dash' });
  });

  it('builds a contains-match from phase', async () => {
    const rag = new FakeRagClient([sessionRow()]);
    await handleSearchContext(deps({ rag }), { query: 'x', phase: 'phase-7' });
    expect(rag.searchCalls[0]?.filterMetadata).toEqual({ phase: 'phase-7' });
  });

  it('builds a contains-match from tags', async () => {
    const rag = new FakeRagClient([sessionRow()]);
    await handleSearchContext(deps({ rag }), { query: 'x', tags: ['review'] });
    expect(rag.searchCalls[0]?.filterMetadata).toEqual({ tags: ['review'] });
  });

  it('merges repo, phase and tags into one object', async () => {
    const rag = new FakeRagClient([sessionRow()]);
    await handleSearchContext(deps({ rag }), {
      query: 'x',
      repo: 'emstacho-su/bb2dash',
      phase: 'phase-7',
      tags: ['review', 'retrieval'],
    });

    expect(rag.searchCalls[0]?.filterMetadata).toEqual({
      repo: 'emstacho-su/bb2dash',
      phase: 'phase-7',
      tags: ['review', 'retrieval'],
    });
  });

  it('returns the matching session and drops the rest', async () => {
    const rag = new FakeRagClient([
      sessionRow({}, { chunk_id: 1, doc_external: 'session-pm', doc_title: 'PM session' }),
      sessionRow(
        { repo: 'emstacho-su/agentic-harness', phase: 'phase-10' },
        { chunk_id: 2, doc_external: 'session-other', doc_title: 'Other repo' },
      ),
    ]);

    const result = await handleSearchContext(deps({ rag }), {
      query: 'matched passage snippets',
      repo: 'emstacho-su/bb2dash',
      phase: 'phase-7',
    });

    const text = textOf(result);
    expect(text).toContain('session-pm');
    expect(text).not.toContain('session-other');
    expect(text).toContain('repo "emstacho-su/bb2dash"');
    expect(text).toContain('phase "phase-7"');
  });

  it('carries parent_session through to the caller — the acceptance query shape', async () => {
    const rag = new FakeRagClient([
      sessionRow({ parent_session: null }, { chunk_id: 1, doc_external: 'session-pm' }),
      sessionRow(
        { parent_session: 'session-pm' },
        { chunk_id: 2, doc_external: 'session-w1' },
      ),
      sessionRow(
        { parent_session: 'session-pm' },
        { chunk_id: 3, doc_external: 'session-w2' },
      ),
    ]);

    const result = await handleSearchContext(deps({ rag }), {
      query: 'matched passage snippets',
      repo: 'emstacho-su/bb2dash',
      phase: 'phase-7',
    });

    const text = textOf(result);
    expect(text).toContain('3 results');
    for (const id of ['session-pm', 'session-w1', 'session-w2']) expect(text).toContain(id);
    expect(text).toContain('parent_session');
  });

  it('ANDs the tags: a document missing one of them does not match', async () => {
    const rag = new FakeRagClient([sessionRow({ tags: ['retrieval'] })]);
    const result = await handleSearchContext(deps({ rag }), {
      query: 'x',
      tags: ['retrieval', 'review'],
    });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('Nothing relevant found');
  });

  it('explains the frontmatter filters when they emptied the result', async () => {
    const rag = new FakeRagClient([]);
    const result = await handleSearchContext(deps({ rag }), { query: 'x', repo: 'owner/nope' });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('ANDed');
    expect(textOf(result)).toContain('Drop the filters');
  });

  for (const [label, args] of [
    ['an empty repo', { repo: '   ' }],
    ['an empty phase', { phase: '' }],
    ['an empty tag', { tags: [''] }],
    ['an empty tags array', { tags: [] }],
    ['a non-array tags value', { tags: 'review' }],
    ['a numeric tag', { tags: [6] }],
    ['a numeric repo', { repo: 6 }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`rejects ${label}`, async () => {
      const result = await handleSearchContext(deps(), { query: 'x', ...args });
      expect(result.isError).toBe(true);
    });
  }

  it('rejects more tags than the cap', async () => {
    const tags = Array.from({ length: 11 }, (_unused, index) => `tag-${index}`);
    const result = await handleSearchContext(deps(), { query: 'x', tags });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('at most 10');
  });

  it('rejects a repo longer than the cap', async () => {
    const result = await handleSearchContext(deps(), { query: 'x', repo: 'a'.repeat(257) });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('repo must be at most 256 characters');
  });
});

describe('search_context — superseded notes', () => {
  const concluded = makeRow({
    chunk_id: 1,
    doc_external: 'session-current',
    doc_metadata: { type: 'session', repo: 'emstacho-su/bb2dash', status: 'concluded' },
  });
  const superseded = makeRow({
    chunk_id: 2,
    doc_external: 'session-earlier',
    doc_metadata: { type: 'session', repo: 'emstacho-su/bb2dash', status: 'superseded' },
  });

  it('excludes superseded documents by default', async () => {
    const rag = new FakeRagClient([concluded, superseded]);
    const result = await handleSearchContext(deps({ rag }), { query: 'x' });

    expect(rag.searchCalls[0]?.includeSuperseded).toBe(false);
    expect(textOf(result)).toContain('session-current');
    expect(textOf(result)).not.toContain('session-earlier');
  });

  it('two calls differing only in include_superseded return different counts', async () => {
    const rows = [concluded, superseded];

    const excluded = new FakeRagClient([...rows]);
    const withoutFlag = await handleSearchContext(deps({ rag: excluded }), { query: 'resume' });

    const included = new FakeRagClient([...rows]);
    const withFlag = await handleSearchContext(deps({ rag: included }), {
      query: 'resume',
      include_superseded: true,
    });

    expect(textOf(withoutFlag)).toContain('1 result for');
    expect(textOf(withFlag)).toContain('2 results for');
    expect(excluded.searchCalls[0]?.includeSuperseded).toBe(false);
    expect(included.searchCalls[0]?.includeSuperseded).toBe(true);
  });

  it('says so when superseded notes were held back from an empty result', async () => {
    const result = await handleSearchContext(deps({ rag: new FakeRagClient([]) }), { query: 'x' });
    expect(textOf(result)).toContain('include_superseded: true');
  });

  it('labels the scope when superseded notes were included', async () => {
    const rag = new FakeRagClient([concluded]);
    const result = await handleSearchContext(deps({ rag }), {
      query: 'x',
      include_superseded: true,
    });
    expect(textOf(result)).toContain('superseded notes included');
  });

  it('rejects a non-boolean include_superseded', async () => {
    const result = await handleSearchContext(deps(), { query: 'x', include_superseded: 'yes' });
    expect(result.isError).toBe(true);
  });
});

describe('search_context — empty results are a valid answer', () => {
  it('returns a non-error explanation when the floor excludes everything', async () => {
    const result = await handleSearchContext(deps({ rag: new FakeRagClient([]) }), {
      query: 'banana bread recipe with walnuts',
    });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('Nothing relevant found');
    expect(textOf(result)).toContain('a real answer, not a failure');
  });

  it('does not look up collections when no collection filter was used', async () => {
    const rag = new FakeRagClient([]);
    await handleSearchContext(deps({ rag }), { query: 'unrelated' });
    expect(rag.collectionCalls).toBe(0);
  });

  it('lists the real collections when a collection filter came up empty', async () => {
    const rag = new FakeRagClient([]);
    const result = await handleSearchContext(deps({ rag }), { query: 'x', collection: 'IST335' });

    expect(result.isError).toBeUndefined();
    expect(rag.collectionCalls).toBe(1);
    expect(textOf(result)).toContain('ist335 (14)');
    expect(textOf(result)).toContain('case-sensitive');
  });

  it('still answers usefully if the collection lookup itself fails', async () => {
    const rag = new FakeRagClient([]);
    rag.collectionsFailure = new Error('pool exhausted');
    const result = await handleSearchContext(deps({ rag }), { query: 'x', collection: 'nope' });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('Nothing relevant found');
  });

  it('suggests dropping the filter when a source filter emptied the results', async () => {
    const rag = new FakeRagClient([makeRow({ doc_source: 'claude-mem' })]);
    const result = await handleSearchContext(deps({ rag }), { query: 'x', source: 'hermes' });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('Drop the filters');
  });
});

describe('search_context — failure paths', () => {
  it('reports a dimension mismatch instead of querying with a bad vector', async () => {
    // Claims 384 dims but emits 768 — the silent-garbage failure mode.
    const embedder = new FakeEmbedder('BAAI/bge-small-en-v1.5', EMBEDDING_DIMENSIONS, 768);
    const rag = new FakeRagClient([makeRow()]);

    const result = await handleSearchContext(deps({ embedder, rag }), { query: 'x' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('DimensionMismatch error');
    expect(textOf(result)).toContain('768-dimension');
    expect(textOf(result)).toContain('vector(384)');
    expect(rag.searchCalls).toHaveLength(0);
  });

  it('refuses when the embedder model does not match the ingestion model', async () => {
    const embedder = new FakeEmbedder('sentence-transformers/all-MiniLM-L6-v2', 384, 384);
    const rag = new FakeRagClient([makeRow()]);

    const result = await handleSearchContext(deps({ embedder, rag }), { query: 'x' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('does not match the ingestion model');
    expect(rag.searchCalls).toHaveLength(0);
  });

  it('surfaces a database error with its hint', async () => {
    const rag = new FakeRagClient(
      [],
      null,
      new DatabaseError('rag.search() failed: connection refused', 'Check DATABASE_URL.'),
    );

    const result = await handleSearchContext(deps({ rag }), { query: 'x' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('search_context failed');
    expect(textOf(result)).toContain('Fix: Check DATABASE_URL.');
  });

  it('surfaces an embedding failure', async () => {
    const embedder = new ThrowingEmbedder(new Error('onnx session crashed'));
    const result = await handleSearchContext(deps({ embedder }), { query: 'x' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('onnx session crashed');
  });
});
