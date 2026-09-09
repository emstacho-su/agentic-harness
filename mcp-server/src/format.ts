/**
 * Result rendering.
 *
 * Tool output is read by an LLM, not parsed by a program, so results are
 * rendered as compact prose-with-headers rather than raw JSON.
 *
 * Two scores come back and they mean different things:
 *   - `vector_similarity` is real cosine. It is interpretable in absolute terms
 *     (0.79-0.83 relevant on this corpus, 0.48-0.66 unrelated), so it is shown
 *     as THE relevance signal.
 *   - `fused_score` is a raw RRF sum. It orders results and means nothing on
 *     its own, so it is shown as ordering only and never called a percentage.
 */

import type { CollectionCount, DocumentRow, SearchRow } from './db/types.js';

/** Chunks are ~1-2k chars; cap defensively so one row cannot flood a context. */
const MAX_CHUNK_CHARS = 4_000;
/** Full documents can be far larger; cap harder and say so. */
const MAX_BODY_CHARS = 20_000;
const MAX_METADATA_CHARS = 400;
const MAX_LISTED_COLLECTIONS = 20;

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated, ${text.length - limit} more characters]`;
}

function renderMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  const keys = Object.keys(metadata);
  if (keys.length === 0) return null;

  try {
    return truncate(JSON.stringify(metadata), MAX_METADATA_CHARS);
  } catch {
    return `[${keys.length} key(s), not JSON-serialisable]`;
  }
}

/**
 * `pg` parses timestamptz into a JS Date, and interpolating one yields a
 * locale- and timezone-dependent string ("Wed Sep 09 2026 14:35:00 GMT-0400").
 * Timestamps go to a model, so they are normalised to ISO 8601 UTC.
 */
function formatTimestamp(value: string | Date | null): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function titleOf(row: { doc_title?: string | null; title?: string | null }): string {
  const title = row.doc_title ?? row.title;
  return title && title.trim().length > 0 ? title.trim() : '(untitled)';
}

export interface SearchContext {
  query: string;
  source: string | null;
  collection: string | null;
  matchCount: number;
  minSimilarity: number | null;
}

function describeScope(context: SearchContext): string {
  const parts: string[] = [];
  if (context.source) parts.push(`source "${context.source}"`);
  if (context.collection) parts.push(`collection "${context.collection}"`);
  return parts.length > 0 ? parts.join(', ') : 'all sources and collections';
}

/**
 * Message for a search that matched nothing.
 *
 * With a similarity floor in play this is usually the CORRECT answer — the
 * store genuinely holds nothing relevant — so the wording leads with that
 * instead of implying a failure. `collections` is passed only when a collection
 * filter was used, so a mistyped name is recoverable rather than a dead end.
 */
export function formatEmptyResults(
  context: SearchContext,
  collections: readonly CollectionCount[] = [],
): string {
  const floor = context.minSimilarity;
  const lines = [
    `Nothing relevant found for "${context.query}" in ${describeScope(context)}.`,
    '',
    floor === null
      ? 'The store was searched with no similarity floor and still returned no rows, semantically or lexically.'
      : `No chunk cleared the ${floor} cosine similarity floor, and no chunk matched the query terms literally. On this corpus that normally means the store genuinely holds nothing on this topic — it is a real answer, not a failure.`,
  ];

  if (context.collection) {
    lines.push('', `Collection names are matched exactly and are case-sensitive.`);
    if (collections.length > 0) {
      const named = collections
        .slice(0, MAX_LISTED_COLLECTIONS)
        .map((entry) => `${entry.collection} (${entry.documents})`)
        .join(', ');
      const more =
        collections.length > MAX_LISTED_COLLECTIONS
          ? `, and ${collections.length - MAX_LISTED_COLLECTIONS} more`
          : '';
      lines.push(`Collections that exist: ${named}${more}.`);
    }
  }

  lines.push(
    '',
    'If you expected a hit, try in this order:',
    context.collection || context.source
      ? '- Drop the filters and search everything.'
      : '- Rephrase with fewer, more central terms.',
    floor === null
      ? '- Rephrase with different wording.'
      : '- Lower `min_similarity` (e.g. 0.5) to widen the net deliberately.',
  );

  return lines.join('\n');
}

/** Render `rag.search` rows for an LLM reader. */
export function formatSearchResults(context: SearchContext, rows: readonly SearchRow[]): string {
  if (rows.length === 0) return formatEmptyResults(context);

  const header = [
    `${rows.length} result${rows.length === 1 ? '' : 's'} for "${context.query}" (${describeScope(context)}, top ${context.matchCount}).`,
    'Hybrid search: semantic (cosine) and full-text ranked separately, then fused with RRF.',
    'Judge relevance by `similarity` — real cosine, where ~0.8 is a strong match and below ~0.65 is usually unrelated. `rrf` only sets the ordering and is not a percentage.',
  ].join('\n');

  const blocks = rows.map((row, index) => {
    const lines = [`### ${index + 1}. ${titleOf(row)}`, `- source: ${row.doc_source}`];

    if (row.doc_collection) lines.push(`- collection: ${row.doc_collection}`);
    lines.push(`- external_id: ${row.doc_external}`);
    lines.push(`- similarity: ${formatSimilarity(row.vector_similarity, context.minSimilarity)}`);
    lines.push(`- rrf: ${formatScore(row.fused_score)} (ordering only)`);
    lines.push(`- ids: doc ${row.doc_id}, chunk ${row.chunk_id}`);

    const metadata = renderMetadata(row.doc_metadata);
    if (metadata) lines.push(`- metadata: ${metadata}`);

    lines.push('', truncate(row.chunk_content ?? '', MAX_CHUNK_CHARS));
    return lines.join('\n');
  });

  const footer =
    'To read a full document, call get_document with the `source` and `external_id` shown above.';

  return [header, '', blocks.join('\n\n---\n\n'), '', footer].join('\n');
}

/**
 * A row below the floor reached the result set through the full-text arm — the
 * floor gates the vector arm only. That is a keyword hit, which is independent
 * evidence, so it is labelled rather than hidden.
 */
function formatSimilarity(similarity: number | null, floor: number | null): string {
  if (similarity === null || !Number.isFinite(similarity)) return 'n/a';
  const value = similarity.toFixed(4);
  if (floor !== null && similarity < floor) {
    return `${value} (below the ${floor} floor — surfaced by literal keyword match, not semantic similarity)`;
  }
  return value;
}

function formatScore(score: number): string {
  return Number.isFinite(score) ? score.toFixed(6) : String(score);
}

/** Message returned when `get_document` finds no row. */
export function formatDocumentNotFound(source: string, externalId: string): string {
  return [
    `No document in rag.documents with source="${source}" and external_id="${externalId}".`,
    '',
    'This is an empty result, not an error. Check that:',
    '- `source` is exactly one of the ingested producers (obsidian, claude-mem, hermes).',
    '- `external_id` is copied verbatim from a search_context result — for obsidian it is the vault-relative path, for claude-mem an observation id or a "summary:" / "prompt:" prefixed id.',
  ].join('\n');
}

/** Render one full `rag.documents` row for an LLM reader. */
export function formatDocument(document: DocumentRow): string {
  const lines = [
    `# ${titleOf(document)}`,
    '',
    `- source: ${document.source}`,
  ];

  if (document.collection) lines.push(`- collection: ${document.collection}`);
  lines.push(`- external_id: ${document.external_id}`);
  if (document.agent) lines.push(`- agent: ${document.agent}`);

  const created = formatTimestamp(document.created_at);
  if (created) lines.push(`- created_at: ${created}`);

  const updated = formatTimestamp(document.updated_at);
  if (updated) lines.push(`- updated_at: ${updated}`);

  lines.push(`- doc_id: ${document.id}`);

  const metadata = renderMetadata(document.metadata);
  if (metadata) lines.push(`- metadata: ${metadata}`);

  lines.push('', '---', '', truncate(document.body ?? '', MAX_BODY_CHARS));
  return lines.join('\n');
}
