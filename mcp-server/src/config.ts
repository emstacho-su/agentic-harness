/**
 * Environment-driven configuration.
 *
 * Secrets are read from the environment only — never hardcoded, never written
 * to disk by this server.
 *
 * ── WHICH DATABASE ──────────────────────────────────────────────────────────
 * This server talks to `harness-memory` (ref hqkytnyiiuxovnnyixye) and nothing
 * else. There is a second, unrelated RAG store in `bb2dash` holding class
 * materials embedded with `gte-small`. Both are 384-dim, so pointing this
 * server at bb2dash raises NO error — it returns confidently-ranked nonsense
 * from a different vector space. DATABASE_URL must name harness-memory.
 *
 * ── WHY THERE IS NO PostgREST PATH ──────────────────────────────────────────
 * Probed and rejected: schema `rag` is not exposed to PostgREST and will not
 * be (`406 PGRST106`). DATABASE_URL is the only connection path.
 */

import { readFileSync } from 'node:fs';
import { ConfigError } from './errors.js';

/** The embedding model ingestion used. Retrieval MUST match it exactly. */
export const EMBEDDING_MODEL_ID = 'BAAI/bge-small-en-v1.5';

/** Vector width of `rag.chunks.embedding`. */
export const EMBEDDING_DIMENSIONS = 384;

/** Sources currently produced by the ingestion pipeline. */
export const KNOWN_SOURCES = ['obsidian', 'claude-mem', 'hermes'] as const;
export type KnownSource = (typeof KNOWN_SOURCES)[number];

export const DEFAULT_MATCH_COUNT = 10;
export const MAX_MATCH_COUNT = 50;
export const DEFAULT_RRF_K = 60;

/** Chunks per document in one result set. Stops one long doc crowding out the rest. */
export const DEFAULT_MAX_PER_DOCUMENT = 3;

/**
 * Cosine floor on the vector arm of `rag.search`. Measured on this corpus:
 * relevant hits land 0.79–0.83, unrelated queries 0.48–0.66. Below this floor
 * the vector arm contributes nothing, so an off-topic query correctly returns
 * zero rows instead of its nearest irrelevant neighbours.
 */
export const DEFAULT_MIN_SIMILARITY = 0.7;

/**
 * Whether superseded documents are in a result set by default.
 *
 * A resumed session leaves its earlier note ingested and searchable, marked
 * `status: superseded` (R-27.2). Nothing is deleted, but the default answer to
 * "what happened in that session" is the note that carried on, not the fragment
 * it replaced — so the default here is false and a caller opts back in.
 *
 * `rag.search()` itself defaults this to true, which keeps every pre-existing
 * caller unchanged. The policy lives here, at the agent-facing boundary.
 */
export const DEFAULT_INCLUDE_SUPERSEDED = false;

/**
 * Tags are ANDed by jsonb containment, so more than a handful can only ever
 * narrow to nothing. The hook applies at most five (R-27.4).
 */
export const MAX_FILTER_TAGS = 10;

/**
 * Fully-qualified name of the pgvector type. pgvector lives in schema
 * `extensions` on Supabase; self-hosted installs often put it in `public`.
 */
export const DEFAULT_VECTOR_TYPE = 'extensions.vector';

export interface DatabaseConfig {
  kind: 'postgres';
  connectionString: string;
  vectorType: string;
  /** PEM contents of a pinned CA, or null to verify against system roots. */
  caCert: string | null;
  /** false disables TLS entirely — local Postgres only. */
  ssl: boolean;
}

export interface Config {
  readonly database: DatabaseConfig;
  readonly embedding: {
    readonly modelId: string;
    readonly dimensions: number;
    readonly cacheDir: string | undefined;
    /**
     * Optional instruction prefix prepended to queries before embedding.
     * Project convention is NO prefix, on either side. Changing it here without
     * re-embedding the store is a silent-quality-loss bug.
     */
    readonly queryPrefix: string;
  };
  readonly search: {
    readonly defaultMatchCount: number;
    readonly maxMatchCount: number;
    readonly rrfK: number;
    readonly maxPerDocument: number;
    readonly minSimilarity: number | null;
  };
}

function readOptional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = readOptional(env, key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(
      `${key} must be a positive integer, got ${JSON.stringify(raw)}.`,
      `Unset ${key} to use the default (${fallback}), or set it to a whole number greater than zero.`,
    );
  }
  return parsed;
}

/** Reads a 0–1 similarity floor. `none` disables the floor entirely. */
function readSimilarity(env: NodeJS.ProcessEnv, key: string, fallback: number): number | null {
  const raw = readOptional(env, key);
  if (raw === undefined) return fallback;
  if (/^(none|null|off)$/i.test(raw)) return null;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new ConfigError(
      `${key} must be a number between 0 and 1, or "none", got ${JSON.stringify(raw)}.`,
      `Unset ${key} to use the default (${fallback}). Lower values widen the net; "none" removes the floor.`,
    );
  }
  return parsed;
}

const ENV_HELP = [
  'Set DATABASE_URL in the MCP server env block. It must point at harness-memory',
  '(ref hqkytnyiiuxovnnyixye), NOT at bb2dash — bb2dash uses a different embedding model.',
  '  DATABASE_URL=postgresql://<user>:<password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
  'Supabase dashboard > Project Settings > Database > Connection string.',
].join('\n');

const POSTGREST_REJECTED =
  'The PostgREST path is not supported: schema `rag` is not exposed on this project (RPC returns 406 PGRST106) and will not be exposed. Use DATABASE_URL instead.';

function resolveTls(env: NodeJS.ProcessEnv): { ssl: boolean; caCert: string | null } {
  if (/^(disable|false|off|0)$/i.test(readOptional(env, 'DATABASE_SSL') ?? '')) {
    return { ssl: false, caCert: null };
  }

  const caPath = readOptional(env, 'DATABASE_CA_CERT');
  if (!caPath) return { ssl: true, caCert: null };

  try {
    return { ssl: true, caCert: readFileSync(caPath, 'utf8') };
  } catch (cause) {
    throw new ConfigError(
      `DATABASE_CA_CERT points at ${caPath}, which could not be read.`,
      'Use a Windows-style absolute path (C:/...), not an MSYS /c/... path — Node cannot resolve those. The Supabase CA lives at certs/prod-ca.crt in this repo.',
      { cause },
    );
  }
}

function resolveDatabase(env: NodeJS.ProcessEnv, vectorType: string): DatabaseConfig {
  const connectionString = readOptional(env, 'DATABASE_URL');

  if (connectionString) {
    if (!/^postgres(ql)?:\/\//i.test(connectionString)) {
      throw new ConfigError(
        'DATABASE_URL is set but is not a postgres:// or postgresql:// URL.',
        'Use the Supabase "Connection string" value, e.g. postgresql://<user>:<password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
      );
    }

    // Cheap guard against the one mistake that fails silently rather than loudly.
    if (connectionString.includes('goultdzqcavefcgnifdy')) {
      throw new ConfigError(
        'DATABASE_URL points at bb2dash (goultdzqcavefcgnifdy), not harness-memory.',
        'bb2dash holds a separate class-materials store embedded with gte-small. It is also 384-dim, so querying it with bge vectors returns confidently-ranked nonsense with no error. Point DATABASE_URL at harness-memory (hqkytnyiiuxovnnyixye).',
      );
    }

    return { kind: 'postgres', connectionString, vectorType, ...resolveTls(env) };
  }

  const hasRestCredentials =
    readOptional(env, 'SUPABASE_URL') !== undefined ||
    readOptional(env, 'SUPABASE_SERVICE_ROLE') !== undefined;

  if (hasRestCredentials) {
    throw new ConfigError(
      'DATABASE_URL is missing. Supabase REST credentials were found, but this server does not use them.',
      `${POSTGREST_REJECTED}\n${ENV_HELP}`,
    );
  }

  throw new ConfigError('DATABASE_URL is not set.', ENV_HELP);
}

/**
 * Build config from the environment. Throws `ConfigError` with an actionable
 * hint rather than starting up in a half-configured state.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const vectorType = readOptional(env, 'RAG_VECTOR_TYPE') ?? DEFAULT_VECTOR_TYPE;
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(vectorType)) {
    throw new ConfigError(
      `RAG_VECTOR_TYPE=${JSON.stringify(vectorType)} is not a valid [schema.]type identifier.`,
      'Use something like extensions.vector or public.vector. It is interpolated into SQL, so only identifiers are accepted.',
    );
  }

  const defaultMatchCount = readPositiveInt(env, 'RAG_DEFAULT_MATCH_COUNT', DEFAULT_MATCH_COUNT);
  const maxMatchCount = readPositiveInt(env, 'RAG_MAX_MATCH_COUNT', MAX_MATCH_COUNT);

  if (defaultMatchCount > maxMatchCount) {
    throw new ConfigError(
      `RAG_DEFAULT_MATCH_COUNT (${defaultMatchCount}) exceeds RAG_MAX_MATCH_COUNT (${maxMatchCount}).`,
      'Lower the default or raise the maximum.',
    );
  }

  return {
    database: resolveDatabase(env, vectorType),
    embedding: {
      modelId: EMBEDDING_MODEL_ID,
      dimensions: EMBEDDING_DIMENSIONS,
      cacheDir: readOptional(env, 'FASTEMBED_CACHE_DIR'),
      queryPrefix: env['RAG_QUERY_PREFIX'] ?? '',
    },
    search: {
      defaultMatchCount,
      maxMatchCount,
      rrfK: readPositiveInt(env, 'RAG_RRF_K', DEFAULT_RRF_K),
      maxPerDocument: readPositiveInt(env, 'RAG_MAX_PER_DOCUMENT', DEFAULT_MAX_PER_DOCUMENT),
      minSimilarity: readSimilarity(env, 'RAG_MIN_SIMILARITY', DEFAULT_MIN_SIMILARITY),
    },
  };
}
