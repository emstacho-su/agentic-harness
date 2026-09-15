/**
 * Direct Postgres access via `pg` — the only supported transport.
 *
 * Arguments to `rag.search()` are bound BY NAME (`query_embedding => $1`). The
 * signature has changed twice already; positional binding silently shifts every
 * argument one slot left when a parameter is inserted, and Postgres reports
 * that as 42883 "function does not exist", which reads like a missing
 * migration. Named binding survives insertions and reorderings.
 */

import { DatabaseError } from '../errors.js';
import type {
  CollectionCount,
  DocumentRow,
  RagClient,
  SearchParams,
  SearchRow,
} from './types.js';
import { toVectorLiteral } from './types.js';

/** Minimal slice of `pg.Pool` we depend on — keeps tests free of a real driver. */
export interface QueryablePool {
  query<R>(config: { text: string; values: unknown[] }): Promise<{ rows: R[] }>;
  end(): Promise<void>;
}

const DOCUMENT_COLUMNS =
  'id, source, collection, agent, external_id, title, body, metadata, content_hash, created_at, updated_at';

const SEARCH_COLUMNS =
  'chunk_id, doc_id, doc_source, doc_collection, doc_external, doc_title, chunk_content, doc_metadata, fused_score, vector_similarity';

export interface PostgresClientOptions {
  pool: QueryablePool;
  /** Fully-qualified pgvector type name, e.g. `extensions.vector`. */
  vectorType: string;
  description?: string;
}

export class PostgresRagClient implements RagClient {
  readonly description: string;

  readonly #pool: QueryablePool;
  readonly #searchSql: string;

  constructor(options: PostgresClientOptions) {
    this.#pool = options.pool;
    this.description = options.description ?? 'direct Postgres (pg)';
    // vectorType is identifier-validated in config.ts before it reaches here.
    this.#searchSql = [
      `select ${SEARCH_COLUMNS}`,
      'from rag.search(',
      `  query_embedding   => $1::${options.vectorType},`,
      '  query_text        => $2::text,',
      '  match_count       => $3::int,',
      '  filter_source     => $4::text,',
      '  filter_collection => $5::text,',
      '  rrf_k             => $6::int,',
      '  max_per_document  => $7::int,',
      '  min_similarity    => $8::double precision,',
      '  filter_metadata   => $9::jsonb,',
      '  include_superseded => $10::boolean',
      ')',
    ].join('\n');
  }

  async search(params: SearchParams): Promise<SearchRow[]> {
    const values = [
      toVectorLiteral(params.embedding),
      params.queryText,
      params.matchCount,
      params.filterSource,
      params.filterCollection,
      params.rrfK,
      params.maxPerDocument,
      params.minSimilarity,
      // Serialised here rather than left to the driver's object handling, so
      // what reaches ::jsonb is a string this code chose.
      params.filterMetadata === null ? null : JSON.stringify(params.filterMetadata),
      params.includeSuperseded,
    ];

    try {
      const result = await this.#pool.query<SearchRow>({ text: this.#searchSql, values });
      return result.rows;
    } catch (cause) {
      throw new DatabaseError(`rag.search() failed: ${messageOf(cause)}`, hintFor(cause), { cause });
    }
  }

  async getDocument(source: string, externalId: string): Promise<DocumentRow | null> {
    const sql = `select ${DOCUMENT_COLUMNS} from rag.documents where source = $1 and external_id = $2 limit 1`;

    try {
      const result = await this.#pool.query<DocumentRow>({ text: sql, values: [source, externalId] });
      return result.rows[0] ?? null;
    } catch (cause) {
      throw new DatabaseError(
        `Lookup of rag.documents failed: ${messageOf(cause)}`,
        hintFor(cause),
        { cause },
      );
    }
  }

  async listCollections(limit = 50): Promise<CollectionCount[]> {
    // A key/aggregate read, not ranking — the "all retrieval goes through
    // rag.search()" rule is about ranking, and this exists so a caller who
    // guessed a collection name wrong can see the real ones.
    const sql = [
      'select collection, count(*)::int as documents',
      'from rag.documents',
      'where collection is not null',
      'group by collection',
      'order by documents desc, collection asc',
      'limit $1::int',
    ].join('\n');

    try {
      const result = await this.#pool.query<CollectionCount>({ text: sql, values: [limit] });
      return result.rows;
    } catch (cause) {
      throw new DatabaseError(
        `Listing rag.documents collections failed: ${messageOf(cause)}`,
        hintFor(cause),
        { cause },
      );
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Map the Postgres errors an operator can actually act on to a concrete fix. */
function hintFor(cause: unknown): string {
  const code = (cause as { code?: string } | null)?.code;
  const message = messageOf(cause);

  switch (code) {
    case '42883':
      // Named binding makes a genuine signature drift far more likely than an
      // absent function, so lead with that.
      return 'No rag.search() overload matched these argument names. The signature has changed before — compare src/db/postgres.ts against `\\df rag.search`, and confirm db/migrations is applied.';
    case '42P01':
      return 'The rag schema tables are missing. Apply db/migrations before starting the server.';
    case '42501':
      return 'Permission denied. RLS is enabled on rag with no policies, so DATABASE_URL must use the postgres/service role.';
    case 'P0001':
      // rag.search raises these itself; its own message is already the fix.
      return 'rag.search() rejected the arguments. Its message above states the requirement.';
    case '28P01':
      return 'Authentication failed. Check the password in DATABASE_URL.';
    case '3D000':
      return 'That database does not exist. Check the database name at the end of DATABASE_URL.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Host could not be resolved. Check the hostname in DATABASE_URL.';
    case 'ECONNREFUSED':
      return 'Connection refused. Check the host and port in DATABASE_URL, and that the Supabase project is not paused.';
    case 'ETIMEDOUT':
      return 'Connection timed out. Check network access to the database host.';
    default:
      break;
  }

  if (/type "?vector"? does not exist|schema "extensions" does not exist/i.test(message)) {
    return 'pgvector is not where the server expects it. Set RAG_VECTOR_TYPE (default extensions.vector, self-hosted is often public.vector).';
  }

  if (/self.signed certificate|unable to verify|certificate/i.test(message)) {
    return 'TLS verification failed. Set DATABASE_CA_CERT to the pinned Supabase CA (certs/prod-ca.crt in this repo), using a C:/... path.';
  }

  return 'Verify DATABASE_URL points at harness-memory (hqkytnyiiuxovnnyixye) and that db/migrations has been applied.';
}
