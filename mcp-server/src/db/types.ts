/**
 * The retrieval contract, mirrored from the live `rag.search()`.
 *
 * `rag.search()` is the single definition of search shared by Claude Code and
 * Hermes Agent. Clients call it; they never hand-roll ranking SQL.
 *
 * The signature has already changed twice (gaining `filter_collection`,
 * `max_per_document`, `min_similarity`, and two output columns), so callers
 * bind arguments BY NAME. Positional binding breaks on the next change and
 * fails as a confusing 42883 "function does not exist".
 */

/** One row of `rag.search(...)`. */
export interface SearchRow {
  chunk_id: number;
  doc_id: number;
  doc_source: string;
  /** Project or class the document belongs to. Null for untagged documents. */
  doc_collection: string | null;
  doc_external: string;
  doc_title: string | null;
  chunk_content: string;
  doc_metadata: Record<string, unknown> | null;
  /** Raw RRF fusion score. Ordering only — not a similarity, not comparable across queries. */
  fused_score: number;
  /**
   * True cosine similarity to the query vector, in [-1, 1]. This is the
   * interpretable relevance signal. Null only when no embedding was supplied.
   *
   * Computed for every returned row regardless of which arm surfaced it, so a
   * chunk found by full-text search alone can legitimately sit below
   * `min_similarity` — that floor gates the vector arm only.
   */
  vector_similarity: number | null;
}

/** One row of `rag.documents`. */
export interface DocumentRow {
  id: number;
  source: string;
  collection: string | null;
  agent: string | null;
  external_id: string;
  title: string | null;
  body: string;
  metadata: Record<string, unknown> | null;
  content_hash: string;
  /** `pg` returns timestamptz as a Date; normalise before rendering. */
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

export interface SearchParams {
  /** 384-dim query vector, already length-checked. */
  embedding: number[];
  /** Raw query text — feeds the full-text arm of the RRF fusion. */
  queryText: string;
  matchCount: number;
  filterSource: string | null;
  /** Narrows to one project or class. Matched exactly, case-sensitively. */
  filterCollection: string | null;
  rrfK: number;
  maxPerDocument: number;
  /** Cosine floor on the vector arm. Null removes the floor. */
  minSimilarity: number | null;
  /**
   * jsonb contains-match against `documents.metadata` — session frontmatter.
   * `{"repo": "owner/name"}`, `{"phase": "phase-7"}`, `{"tags": ["review"]}`.
   * Null applies no metadata filter. Served by the `documents_metadata_idx`
   * GIN index, and applied inside both arms rather than after the fusion.
   */
  filterMetadata: Readonly<Record<string, unknown>> | null;
  /**
   * Keep documents whose metadata says `status: superseded`. False drops them.
   * The SQL function defaults this to true; this client sends the tool's own
   * default, which is false.
   */
  includeSuperseded: boolean;
}

/** A collection name and how many documents carry it. */
export interface CollectionCount {
  collection: string;
  documents: number;
}

export interface RagClient {
  /** Human-readable description of the transport, for diagnostics. */
  readonly description: string;
  search(params: SearchParams): Promise<SearchRow[]>;
  getDocument(source: string, externalId: string): Promise<DocumentRow | null>;
  /** Distinct collections, most populated first. Used to recover from a bad filter. */
  listCollections(limit?: number): Promise<CollectionCount[]>;
  close(): Promise<void>;
}

/**
 * Serialise a JS number array into pgvector's text input format.
 *
 * The `pg` driver would otherwise encode `number[]` as a Postgres array literal
 * (`{1,2,3}`), which does not cast to `vector`.
 */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}
