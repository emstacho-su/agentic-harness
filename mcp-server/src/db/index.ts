/**
 * Connection factory.
 *
 * Direct Postgres via `pg` is the only supported transport — see the note in
 * `config.ts` for why the PostgREST route was rejected.
 */

import pg from 'pg';
import type { Config } from '../config.js';
import { PostgresRagClient } from './postgres.js';
import type { RagClient } from './types.js';

export { PostgresRagClient } from './postgres.js';
export type { QueryablePool } from './postgres.js';
export type {
  CollectionCount,
  DocumentRow,
  RagClient,
  SearchParams,
  SearchRow,
} from './types.js';
export { toVectorLiteral } from './types.js';

export function createRagClient(config: Config): RagClient {
  const { caCert, ssl } = config.database;

  const pool = new pg.Pool({
    connectionString: config.database.connectionString,
    // Supabase's pooler presents a cert from a private CA. Pinning it keeps
    // verification ON; the alternative people reach for (rejectUnauthorized:
    // false) silently accepts any certificate, so it is not offered.
    ssl: ssl ? (caCert ? { ca: caCert, rejectUnauthorized: true } : true) : false,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    application_name: 'agentic-harness-rag-mcp',
  });

  // A pool-level error with no listener crashes the process; surface it on
  // stderr instead. stdout belongs to the JSON-RPC stream.
  pool.on('error', (error) => {
    process.stderr.write(`[rag-mcp] idle Postgres client error: ${error.message}\n`);
  });

  return new PostgresRagClient({ pool, vectorType: config.database.vectorType });
}
