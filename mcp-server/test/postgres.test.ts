import { describe, expect, it, vi } from 'vitest';
import { PostgresRagClient, type QueryablePool } from '../src/db/postgres.js';
import { toVectorLiteral } from '../src/db/types.js';
import { DatabaseError } from '../src/errors.js';
import { makeDocument, makeRow } from './helpers.js';

interface Recorded {
  text: string;
  values: unknown[];
}

function mockPool(rows: unknown[] = [], failure?: unknown) {
  const calls: Recorded[] = [];
  const pool: QueryablePool = {
    query: vi.fn(async (config: { text: string; values: unknown[] }) => {
      calls.push(config);
      if (failure) throw failure;
      return { rows: rows as never[] };
    }),
    end: vi.fn(async () => {}),
  };
  return { pool, calls };
}

const client = (pool: QueryablePool, vectorType = 'extensions.vector') =>
  new PostgresRagClient({ pool, vectorType });

const params = {
  embedding: [0.1, 0.2, 0.3],
  queryText: 'ledger invariants',
  matchCount: 7,
  filterSource: null,
  filterCollection: null,
  rrfK: 60,
  maxPerDocument: 3,
  minSimilarity: 0.7,
};

describe('PostgresRagClient.search', () => {
  it('calls rag.search() rather than hand-rolled ranking SQL', async () => {
    const { pool, calls } = mockPool([makeRow()]);
    await client(pool).search(params);

    expect(calls[0]?.text).toContain('from rag.search(');
    expect(calls[0]?.text).not.toMatch(/order by .*<=>/i);
  });

  it('binds every argument BY NAME so a signature change cannot shift them', async () => {
    const { pool, calls } = mockPool([]);
    await client(pool).search(params);
    const sql = calls[0]?.text ?? '';

    // The regression this guards: filter_collection was inserted at position 5,
    // where rrf_k used to be. Positional binding put an int into a text slot and
    // Postgres reported it as 42883 "function does not exist".
    for (const [name, placeholder] of [
      ['query_embedding', '$1'],
      ['query_text', '$2'],
      ['match_count', '$3'],
      ['filter_source', '$4'],
      ['filter_collection', '$5'],
      ['rrf_k', '$6'],
      ['max_per_document', '$7'],
      ['min_similarity', '$8'],
    ] as const) {
      expect(sql).toMatch(new RegExp(`${name}\\s*=>\\s*\\${placeholder}`));
    }
  });

  it('selects both new output columns', async () => {
    const { pool, calls } = mockPool([]);
    await client(pool).search(params);
    expect(calls[0]?.text).toContain('doc_collection');
    expect(calls[0]?.text).toContain('vector_similarity');
  });

  it('sends the vector as a pgvector text literal, not a Postgres array', async () => {
    const { pool, calls } = mockPool([]);
    await client(pool).search(params);

    // `pg` would encode number[] as '{0.1,0.2,0.3}', which does not cast to vector.
    expect(calls[0]?.values[0]).toBe('[0.1,0.2,0.3]');
    expect(calls[0]?.values[0]).toBe(toVectorLiteral(params.embedding));
  });

  it('passes BOTH the embedding and the raw text so RRF has two lists to fuse', async () => {
    const { pool, calls } = mockPool([]);
    await client(pool).search(params);

    expect(calls[0]?.values).toEqual(['[0.1,0.2,0.3]', 'ledger invariants', 7, null, null, 60, 3, 0.7]);
  });

  it('casts using the configured pgvector type', async () => {
    const { pool, calls } = mockPool([]);
    await client(pool, 'public.vector').search(params);
    expect(calls[0]?.text).toContain('$1::public.vector');
  });

  it('forwards the source and collection filters', async () => {
    const { pool, calls } = mockPool([]);
    await client(pool).search({ ...params, filterSource: 'obsidian', filterCollection: 'ist335' });

    expect(calls[0]?.values[3]).toBe('obsidian');
    expect(calls[0]?.values[4]).toBe('ist335');
  });

  it('forwards a null similarity floor as null rather than omitting it', async () => {
    const { pool, calls } = mockPool([]);
    await client(pool).search({ ...params, minSimilarity: null });
    expect(calls[0]?.values[7]).toBeNull();
  });

  it('returns an empty array when nothing matches', async () => {
    const { pool } = mockPool([]);
    await expect(client(pool).search(params)).resolves.toEqual([]);
  });

  it('blames signature drift, not a missing migration, on 42883', async () => {
    const failure = Object.assign(new Error('function rag.search(...) does not exist'), {
      code: '42883',
    });
    const { pool } = mockPool([], failure);

    try {
      await client(pool).search(params);
      throw new Error('expected search to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseError);
      expect((error as DatabaseError).hint).toContain('signature has changed');
    }
  });

  it('passes through the function\'s own message for a raised assertion', async () => {
    const failure = Object.assign(
      new Error('rag.search: match_count must be >= 1, got 0'),
      { code: 'P0001' },
    );
    const { pool } = mockPool([], failure);

    await client(pool)
      .search(params)
      .catch((error: DatabaseError) => {
        expect(error.message).toContain('match_count must be >= 1');
        expect(error.hint).toContain('rejected the arguments');
      });
  });

  it('maps permission denied to the RLS/service-role explanation', async () => {
    const failure = Object.assign(new Error('permission denied for schema rag'), { code: '42501' });
    const { pool } = mockPool([], failure);

    await client(pool)
      .search(params)
      .catch((error: DatabaseError) => {
        expect(error).toBeInstanceOf(DatabaseError);
        expect(error.hint).toContain('service role');
      });
  });

  it('explains a misplaced pgvector type', async () => {
    const { pool } = mockPool([], new Error('type "vector" does not exist'));
    await client(pool)
      .search(params)
      .catch((error: DatabaseError) => {
        expect(error.hint).toContain('RAG_VECTOR_TYPE');
      });
  });

  it('points at the pinned CA on a TLS failure', async () => {
    const { pool } = mockPool([], new Error('self-signed certificate in certificate chain'));
    await client(pool)
      .search(params)
      .catch((error: DatabaseError) => {
        expect(error.hint).toContain('DATABASE_CA_CERT');
      });
  });
});

describe('PostgresRagClient.getDocument', () => {
  it('queries the natural key on rag.documents and selects collection', async () => {
    const { pool, calls } = mockPool([makeDocument()]);
    const document = await client(pool).getDocument('obsidian', 'notes/ledger.md');

    expect(calls[0]?.text).toContain('from rag.documents where source = $1 and external_id = $2');
    expect(calls[0]?.text).toContain('collection');
    expect(calls[0]?.values).toEqual(['obsidian', 'notes/ledger.md']);
    expect(document?.id).toBe(10);
  });

  it('returns null when there is no row', async () => {
    const { pool } = mockPool([]);
    await expect(client(pool).getDocument('obsidian', 'missing.md')).resolves.toBeNull();
  });

  it('wraps driver failures as DatabaseError', async () => {
    const { pool } = mockPool([], Object.assign(new Error('nope'), { code: '28P01' }));
    await client(pool)
      .getDocument('obsidian', 'x')
      .catch((error: DatabaseError) => {
        expect(error).toBeInstanceOf(DatabaseError);
        expect(error.hint).toContain('password');
      });
  });
});

describe('PostgresRagClient.listCollections', () => {
  it('aggregates non-null collections, most populated first', async () => {
    const { pool, calls } = mockPool([{ collection: 'estac', documents: 513 }]);
    const collections = await client(pool).listCollections();

    expect(calls[0]?.text).toContain('where collection is not null');
    expect(calls[0]?.text).toContain('order by documents desc');
    expect(calls[0]?.values).toEqual([50]);
    expect(collections[0]).toEqual({ collection: 'estac', documents: 513 });
  });

  it('honours an explicit limit', async () => {
    const { pool, calls } = mockPool([]);
    await client(pool).listCollections(5);
    expect(calls[0]?.values).toEqual([5]);
  });
});

describe('PostgresRagClient.close', () => {
  it('ends the pool', async () => {
    const { pool } = mockPool([]);
    await client(pool).close();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
