/**
 * `search_context` — the primary retrieval path.
 *
 * Embeds the query locally, then calls `rag.search()` with BOTH the vector and
 * the raw text. Passing only one collapses the RRF fusion to a single ranked
 * list, which is the whole point of the function, so both are always sent.
 */

import { z } from 'zod';
import type { Config } from '../config.js';
import {
  DEFAULT_INCLUDE_SUPERSEDED,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_ID,
} from '../config.js';
import { buildFilterMetadata } from './filter-metadata.js';
import type { CollectionCount, RagClient } from '../db/types.js';
import type { Embedder } from '../embedder.js';
import { assertDimensions } from '../embedder.js';
import { DimensionMismatchError, describeError } from '../errors.js';
import { formatEmptyResults, formatSearchResults } from '../format.js';
import type { ToolResult } from './schemas.js';
import {
  errorResult,
  formatZodIssues,
  searchContextSchema,
  searchContextShape,
  textResult,
} from './schemas.js';

export interface ToolDeps {
  embedder: Embedder;
  rag: RagClient;
  config: Config;
}

export const SEARCH_CONTEXT_DESCRIPTION = [
  'Search the shared knowledge store (Obsidian vault notes, captured session histories and migrated agent memory, tagged by project or class) for context relevant to a question.',
  'Use this before answering anything that depends on past decisions, project history, or the user\'s own notes.',
  `Hybrid retrieval: the query is embedded locally with ${EMBEDDING_MODEL_ID} (${EMBEDDING_DIMENSIONS} dims) and simultaneously run through Postgres full-text search; the two ranked lists are fused with Reciprocal Rank Fusion.`,
  'Narrow with `source` and `collection`, or — for captured sessions — with `repo`, `phase` and `tags`, which match the session note\'s own frontmatter and are combined with AND.',
  `Superseded notes (the earlier half of a resumed session) are excluded unless \`include_superseded\` is true; the default is ${DEFAULT_INCLUDE_SUPERSEDED}.`,
  'Results carry a real cosine `similarity` — judge relevance by that. An empty result is a valid answer meaning the store holds nothing on the topic.',
  'Follow up with get_document to read a full document.',
].join(' ');

export function createSearchContextTool(deps: ToolDeps) {
  return {
    name: 'search_context',
    config: {
      title: 'Search shared context store',
      description: SEARCH_CONTEXT_DESCRIPTION,
      inputSchema: searchContextShape,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    handler: (rawArgs: unknown): Promise<ToolResult> => handleSearchContext(deps, rawArgs),
  };
}

export async function handleSearchContext(deps: ToolDeps, rawArgs: unknown): Promise<ToolResult> {
  const parsed = searchContextSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return errorResult(
      `Invalid arguments for search_context:\n${formatZodIssues(parsed.error as z.ZodError)}`,
    );
  }

  const {
    query,
    limit,
    source,
    collection,
    min_similarity: minSimilarityArg,
    repo,
    phase,
    tags,
    include_superseded: includeSupersededArg,
  } = parsed.data;
  const { search: searchConfig } = deps.config;

  const matchCount = Math.min(limit ?? searchConfig.defaultMatchCount, searchConfig.maxMatchCount);
  const filterSource = source ?? null;
  const filterCollection = collection ?? null;
  const minSimilarity = minSimilarityArg ?? searchConfig.minSimilarity;
  const filterMetadata = buildFilterMetadata({ repo, phase, tags });
  const includeSuperseded = includeSupersededArg ?? DEFAULT_INCLUDE_SUPERSEDED;

  const context = {
    query,
    source: filterSource,
    collection: filterCollection,
    matchCount,
    minSimilarity,
    filterMetadata,
    includeSuperseded,
  };

  try {
    const embedding = await deps.embedder.embed(query);

    // Second guard: the embedder checks its own output, but this is the last
    // point before the vector reaches vector(384) and a mismatch here returns
    // wrong rankings instead of an error.
    assertDimensions(embedding, deps.config.embedding.dimensions, deps.embedder.modelId);

    if (deps.embedder.modelId !== deps.config.embedding.modelId) {
      throw new DimensionMismatchError(
        `Embedder model ${deps.embedder.modelId} does not match the ingestion model ${deps.config.embedding.modelId}.`,
        'Rankings would be meaningless. Align the retrieval model with the model ingestion used, or re-embed the store.',
      );
    }

    const rows = await deps.rag.search({
      embedding,
      queryText: query,
      matchCount,
      filterSource,
      filterCollection,
      rrfK: searchConfig.rrfK,
      maxPerDocument: searchConfig.maxPerDocument,
      minSimilarity,
      filterMetadata,
      includeSuperseded,
    });

    if (rows.length === 0) {
      // Only when a collection filter was in play: a mistyped collection name
      // and a genuinely empty topic look identical otherwise.
      const collections = filterCollection ? await listCollectionsSafely(deps.rag) : [];
      return textResult(formatEmptyResults(context, collections));
    }

    return textResult(formatSearchResults(context, rows));
  } catch (error) {
    return errorResult(`search_context failed.\n${describeError(error)}`);
  }
}

/**
 * The collection list is a nicety on an already-empty result. If it fails, the
 * empty-result message is still correct and useful, so the failure is dropped
 * rather than converting a valid answer into an error.
 */
async function listCollectionsSafely(rag: RagClient): Promise<CollectionCount[]> {
  try {
    return await rag.listCollections();
  } catch {
    return [];
  }
}
