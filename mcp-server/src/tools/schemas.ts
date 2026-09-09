/**
 * Tool input schemas.
 *
 * The raw shapes are handed to `McpServer.registerTool` so the SDK advertises a
 * correct JSON Schema and validates on the way in. The assembled `z.object`s are
 * exported too so handlers can re-validate defensively and so the boundary is
 * unit-testable without standing up a server.
 */

import { z } from 'zod';
import { DEFAULT_MIN_SIMILARITY, KNOWN_SOURCES, MAX_MATCH_COUNT } from '../config.js';

export const MAX_QUERY_CHARS = 2_000;
export const MAX_EXTERNAL_ID_CHARS = 1_024;
export const MAX_COLLECTION_CHARS = 256;

const sourceEnum = z.enum(KNOWN_SOURCES);

export const searchContextShape = {
  query: z
    .string()
    .trim()
    .min(1, 'query must not be empty')
    .max(MAX_QUERY_CHARS, `query must be at most ${MAX_QUERY_CHARS} characters`)
    .describe(
      'Natural-language question or topic. Embedded locally with BAAI/bge-small-en-v1.5 and also passed verbatim to full-text search; both ranked lists are fused with RRF.',
    ),
  limit: z
    .number()
    .int('limit must be a whole number')
    .min(1, 'limit must be at least 1')
    .max(MAX_MATCH_COUNT, `limit must be at most ${MAX_MATCH_COUNT}`)
    .optional()
    .describe(`Maximum number of chunks to return. Default 10, maximum ${MAX_MATCH_COUNT}.`),
  source: sourceEnum
    .optional()
    .describe(
      'Restrict results to a single producer: "obsidian" (vault notes), "claude-mem" (migrated agent memory), or "hermes" (Hermes Agent). Omit to search everything.',
    ),
  collection: z
    .string()
    .trim()
    .min(1, 'collection must not be empty')
    .max(MAX_COLLECTION_CHARS, `collection must be at most ${MAX_COLLECTION_CHARS} characters`)
    .optional()
    .describe(
      'Restrict results to one project or class, e.g. "quant-edge-tracker", "ai-news-agent", "ist335", "estac". Matched exactly and case-sensitively; most live names are lowercase. Omit to search every collection — an unrecognised name simply returns nothing.',
    ),
  min_similarity: z
    .number()
    .min(0, 'min_similarity must be at least 0')
    .max(1, 'min_similarity must be at most 1')
    .optional()
    .describe(
      `Cosine floor for the semantic half of the search. Default ${DEFAULT_MIN_SIMILARITY}: on this corpus relevant hits score 0.79-0.83 and unrelated ones 0.48-0.66, so the default correctly returns nothing for an off-topic query. Lower it (e.g. 0.5) to deliberately widen the net. It does not gate literal keyword matches.`,
    ),
} as const;

export const searchContextSchema = z.object(searchContextShape);
export type SearchContextInput = z.infer<typeof searchContextSchema>;

export const getDocumentShape = {
  external_id: z
    .string()
    .trim()
    .min(1, 'external_id must not be empty')
    .max(MAX_EXTERNAL_ID_CHARS, `external_id must be at most ${MAX_EXTERNAL_ID_CHARS} characters`)
    .describe(
      'Natural key of the document within its source. Copy it verbatim from a search_context result: a vault-relative path for obsidian, an observation id for claude-mem.',
    ),
  source: z
    .string()
    .trim()
    .min(1, 'source must not be empty')
    .describe(
      `Producer that owns the document. Known values: ${KNOWN_SOURCES.join(', ')}. Together with external_id this is the unique key on rag.documents.`,
    ),
} as const;

export const getDocumentSchema = z.object(getDocumentShape);
export type GetDocumentInput = z.infer<typeof getDocumentSchema>;

/** MCP text-content tool result. Structurally compatible with the SDK type. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Turn a ZodError into one readable line per bad field. The SDK normally
 * validates first, but handlers re-parse so a direct/older client cannot slip
 * unvalidated input through.
 */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `- ${path}: ${issue.message}`;
    })
    .join('\n');
}
