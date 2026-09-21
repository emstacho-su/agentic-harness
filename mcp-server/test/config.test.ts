import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID, loadConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

const DB_URL = 'postgresql://postgres:pw@db.example.supabase.co:5432/postgres';

/** The real pinned Supabase CA that ships with the repo, wherever the repo is checked out. */
const CA_PATH = fileURLToPath(new URL('../../certs/prod-ca.crt', import.meta.url)).replace(/\\/g, '/');

describe('loadConfig', () => {
  it('builds a postgres config from DATABASE_URL', () => {
    const config = loadConfig({ DATABASE_URL: DB_URL });

    expect(config.database).toEqual({
      kind: 'postgres',
      connectionString: DB_URL,
      vectorType: 'extensions.vector',
      caCert: null,
      ssl: true,
    });
    expect(config.embedding.modelId).toBe(EMBEDDING_MODEL_ID);
    expect(config.embedding.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(config.search).toEqual({
      defaultMatchCount: 10,
      maxMatchCount: 50,
      rrfK: 60,
      maxPerDocument: 3,
      minSimilarity: 0.7,
    });
  });

  it('refuses a DATABASE_URL pointing at bb2dash', () => {
    // bb2dash holds a gte-small store at the same 384 dims, so this is the one
    // misconfiguration that would otherwise fail silently.
    try {
      loadConfig({ DATABASE_URL: 'postgresql://u:p@db.goultdzqcavefcgnifdy.supabase.co:5432/postgres' });
      throw new Error('expected loadConfig to throw');
    } catch (error) {
      const configError = error as ConfigError;
      expect(configError).toBeInstanceOf(ConfigError);
      expect(configError.message).toContain('bb2dash');
      expect(configError.hint).toContain('gte-small');
      expect(configError.hint).toContain('hqkytnyiiuxovnnyixye');
    }
  });

  it('fails with an actionable message when DATABASE_URL is absent', () => {
    expect(() => loadConfig({})).toThrowError(ConfigError);

    try {
      loadConfig({});
    } catch (error) {
      const configError = error as ConfigError;
      expect(configError.message).toContain('DATABASE_URL is not set');
      expect(configError.hint).toContain('Connection string');
      // Naming the right project is the point: the wrong one fails silently.
      expect(configError.hint).toContain('hqkytnyiiuxovnnyixye');
    }
  });

  it('explains why REST credentials alone are not enough', () => {
    try {
      loadConfig({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE: 'key' });
      throw new Error('expected loadConfig to throw');
    } catch (error) {
      const configError = error as ConfigError;
      expect(configError).toBeInstanceOf(ConfigError);
      expect(configError.hint).toContain('PGRST106');
      expect(configError.hint).toContain('DATABASE_URL');
    }
  });

  it('rejects a DATABASE_URL that is not a postgres URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'https://example.com' })).toThrowError(
      /not a postgres:\/\/ or postgresql:\/\/ URL/,
    );
  });

  it('trims whitespace and treats blank values as unset', () => {
    expect(() => loadConfig({ DATABASE_URL: '   ' })).toThrowError(/DATABASE_URL is not set/);
    expect(loadConfig({ DATABASE_URL: `  ${DB_URL}  ` }).database.connectionString).toBe(DB_URL);
  });

  it('honours RAG_VECTOR_TYPE for non-Supabase pgvector installs', () => {
    const config = loadConfig({ DATABASE_URL: DB_URL, RAG_VECTOR_TYPE: 'public.vector' });
    expect(config.database.vectorType).toBe('public.vector');
  });

  it('rejects a RAG_VECTOR_TYPE that is not a bare identifier', () => {
    // It is interpolated into SQL, so anything but [schema.]identifier is refused.
    expect(() =>
      loadConfig({ DATABASE_URL: DB_URL, RAG_VECTOR_TYPE: 'vector; drop table rag.chunks' }),
    ).toThrowError(/not a valid \[schema\.\]type identifier/);
  });

  it('validates numeric overrides', () => {
    expect(() => loadConfig({ DATABASE_URL: DB_URL, RAG_RRF_K: 'sixty' })).toThrowError(
      /RAG_RRF_K must be a positive integer/,
    );
    expect(() => loadConfig({ DATABASE_URL: DB_URL, RAG_MAX_MATCH_COUNT: '0' })).toThrowError(
      /must be a positive integer/,
    );
    expect(() =>
      loadConfig({ DATABASE_URL: DB_URL, RAG_DEFAULT_MATCH_COUNT: '30', RAG_MAX_MATCH_COUNT: '20' }),
    ).toThrowError(/exceeds RAG_MAX_MATCH_COUNT/);
  });

  it('defaults the query prefix to empty for parity with ingestion', () => {
    expect(loadConfig({ DATABASE_URL: DB_URL }).embedding.queryPrefix).toBe('');
  });

  it('parses the similarity floor, including "none" to disable it', () => {
    expect(loadConfig({ DATABASE_URL: DB_URL, RAG_MIN_SIMILARITY: '0.5' }).search.minSimilarity).toBe(0.5);
    expect(loadConfig({ DATABASE_URL: DB_URL, RAG_MIN_SIMILARITY: 'none' }).search.minSimilarity).toBeNull();
    expect(loadConfig({ DATABASE_URL: DB_URL, RAG_MIN_SIMILARITY: '0' }).search.minSimilarity).toBe(0);
  });

  it('rejects a similarity floor outside 0..1', () => {
    expect(() => loadConfig({ DATABASE_URL: DB_URL, RAG_MIN_SIMILARITY: '1.5' })).toThrowError(
      /must be a number between 0 and 1/,
    );
    expect(() => loadConfig({ DATABASE_URL: DB_URL, RAG_MIN_SIMILARITY: 'high' })).toThrowError(
      /must be a number between 0 and 1/,
    );
  });

  it('honours RAG_MAX_PER_DOCUMENT', () => {
    expect(loadConfig({ DATABASE_URL: DB_URL, RAG_MAX_PER_DOCUMENT: '1' }).search.maxPerDocument).toBe(1);
    expect(() => loadConfig({ DATABASE_URL: DB_URL, RAG_MAX_PER_DOCUMENT: '0' })).toThrowError(
      /must be a positive integer/,
    );
  });

  it('loads a pinned CA certificate when DATABASE_CA_CERT is set', () => {
    const config = loadConfig({ DATABASE_URL: DB_URL, DATABASE_CA_CERT: CA_PATH });
    expect(config.database.ssl).toBe(true);
    expect(config.database.caCert).toContain('BEGIN CERTIFICATE');
  });

  it('explains an unreadable CA path in Windows terms', () => {
    try {
      loadConfig({ DATABASE_URL: DB_URL, DATABASE_CA_CERT: '/c/Users/estac/agentic-harness/certs/prod-ca.crt' });
      throw new Error('expected loadConfig to throw');
    } catch (error) {
      const configError = error as ConfigError;
      expect(configError).toBeInstanceOf(ConfigError);
      expect(configError.hint).toContain('C:/');
    }
  });

  it('allows TLS to be switched off for a local Postgres', () => {
    const config = loadConfig({ DATABASE_URL: DB_URL, DATABASE_SSL: 'disable' });
    expect(config.database.ssl).toBe(false);
  });
});
