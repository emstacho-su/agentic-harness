/** Shared mocks. No test touches a real database or downloads a real model. */

import type { Config } from '../src/config.js';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID } from '../src/config.js';
import type {
  CollectionCount,
  DocumentRow,
  RagClient,
  SearchParams,
  SearchRow,
} from '../src/db/types.js';
import type { Embedder } from '../src/embedder.js';

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    database: {
      kind: 'postgres',
      connectionString: 'postgresql://postgres:pw@localhost:5432/postgres',
      vectorType: 'extensions.vector',
      caCert: null,
      ssl: true,
    },
    embedding: {
      modelId: EMBEDDING_MODEL_ID,
      dimensions: EMBEDDING_DIMENSIONS,
      cacheDir: undefined,
      queryPrefix: '',
    },
    search: {
      defaultMatchCount: 10,
      maxMatchCount: 50,
      rrfK: 60,
      maxPerDocument: 3,
      minSimilarity: 0.7,
    },
    ...overrides,
  };
}

/** Deterministic embedder. `dimensions` controls the length it actually emits. */
export class FakeEmbedder implements Embedder {
  readonly calls: string[] = [];

  constructor(
    readonly modelId: string = EMBEDDING_MODEL_ID,
    readonly dimensions: number = EMBEDDING_DIMENSIONS,
    private readonly emitLength: number = dimensions,
  ) {}

  async embed(text: string): Promise<number[]> {
    this.calls.push(text);
    return Array.from({ length: this.emitLength }, (_unused, i) => (i % 7) / 10);
  }

  async close(): Promise<void> {}
}

export class ThrowingEmbedder implements Embedder {
  readonly modelId = EMBEDDING_MODEL_ID;
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor(private readonly error: Error) {}

  async embed(): Promise<number[]> {
    throw this.error;
  }

  async close(): Promise<void> {}
}

export class FakeRagClient implements RagClient {
  readonly description = 'fake';
  readonly searchCalls: SearchParams[] = [];
  readonly getCalls: Array<{ source: string; externalId: string }> = [];
  collectionCalls = 0;
  collections: CollectionCount[] = [
    { collection: 'estac', documents: 513 },
    { collection: 'ist335', documents: 14 },
  ];
  collectionsFailure: Error | null = null;

  constructor(
    private readonly rows: SearchRow[] = [],
    private readonly document: DocumentRow | null = null,
    private readonly failure: Error | null = null,
  ) {}

  async search(params: SearchParams): Promise<SearchRow[]> {
    this.searchCalls.push(params);
    if (this.failure) throw this.failure;

    let matched = this.rows;
    if (params.filterSource) {
      matched = matched.filter((row) => row.doc_source === params.filterSource);
    }
    if (params.filterCollection) {
      matched = matched.filter((row) => row.doc_collection === params.filterCollection);
    }
    if (params.filterMetadata) {
      matched = matched.filter((row) => contains(row.doc_metadata, params.filterMetadata));
    }
    if (!params.includeSuperseded) {
      matched = matched.filter((row) => statusOf(row) !== 'superseded');
    }
    return matched.slice(0, params.matchCount);
  }

  async getDocument(source: string, externalId: string): Promise<DocumentRow | null> {
    this.getCalls.push({ source, externalId });
    if (this.failure) throw this.failure;
    if (!this.document) return null;
    return this.document.source === source && this.document.external_id === externalId
      ? this.document
      : null;
  }

  async listCollections(): Promise<CollectionCount[]> {
    this.collectionCalls += 1;
    if (this.collectionsFailure) throw this.collectionsFailure;
    return this.collections;
  }

  async close(): Promise<void> {}
}

function statusOf(row: SearchRow): string | null {
  const status = row.doc_metadata?.['status'];
  return typeof status === 'string' ? status : null;
}

/**
 * The subset of Postgres `jsonb @>` this suite needs: every key in the filter
 * must be present, scalars compared by equality and arrays by containment.
 * Mirroring the operator here is what makes the metadata tests mean something.
 */
function contains(
  metadata: Record<string, unknown> | null,
  filter: Readonly<Record<string, unknown>>,
): boolean {
  if (!metadata) return false;
  return Object.entries(filter).every(([key, wanted]) => {
    const actual = metadata[key];
    if (Array.isArray(wanted)) {
      return Array.isArray(actual) && wanted.every((entry) => actual.includes(entry));
    }
    return actual === wanted;
  });
}

export function makeRow(overrides: Partial<SearchRow> = {}): SearchRow {
  return {
    chunk_id: 1,
    doc_id: 10,
    doc_source: 'claude-mem',
    doc_collection: 'quant-edge-tracker',
    doc_external: '4821',
    doc_title: 'Ledger event types',
    chunk_content: 'The ledger emits cash and wager events; cash must never exceed zero.',
    doc_metadata: { project: 'quant-edge-tracker' },
    fused_score: 0.032_786,
    vector_similarity: 0.8123,
    ...overrides,
  };
}

export function makeDocument(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: 10,
    source: 'obsidian',
    collection: 'agentic-harness',
    agent: 'claude-code',
    external_id: 'notes/ledger.md',
    title: 'Ledger model',
    body: 'Full note body.',
    metadata: { tags: ['ledger'] },
    content_hash: 'abc123',
    created_at: '2026-04-15T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Extract the single text block from a tool result. */
export function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? '').join('\n');
}
