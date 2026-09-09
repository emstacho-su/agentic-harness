/**
 * `get_document` — point lookup of one full document by its natural key.
 *
 * This is not ranking, so it does not go through `rag.search()`; it reads
 * `rag.documents` on the UNIQUE (source, external_id) key. All *ranked*
 * retrieval still goes through the shared SQL function.
 */

import type { z } from 'zod';
import { KNOWN_SOURCES } from '../config.js';
import { describeError } from '../errors.js';
import { formatDocument, formatDocumentNotFound } from '../format.js';
import type { ToolDeps } from './search-context.js';
import type { ToolResult } from './schemas.js';
import { errorResult, formatZodIssues, getDocumentSchema, getDocumentShape, textResult } from './schemas.js';

export const GET_DOCUMENT_DESCRIPTION = [
  'Fetch one complete document from the shared knowledge store by its natural key (source + external_id).',
  'Use it after search_context when a chunk looks relevant and you need the full text around it.',
  `Known sources: ${KNOWN_SOURCES.join(', ')}.`,
].join(' ');

export function createGetDocumentTool(deps: ToolDeps) {
  return {
    name: 'get_document',
    config: {
      title: 'Get full document',
      description: GET_DOCUMENT_DESCRIPTION,
      inputSchema: getDocumentShape,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    handler: (rawArgs: unknown): Promise<ToolResult> => handleGetDocument(deps, rawArgs),
  };
}

export async function handleGetDocument(deps: ToolDeps, rawArgs: unknown): Promise<ToolResult> {
  const parsed = getDocumentSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return errorResult(
      `Invalid arguments for get_document:\n${formatZodIssues(parsed.error as z.ZodError)}`,
    );
  }

  const { source, external_id: externalId } = parsed.data;

  try {
    const document = await deps.rag.getDocument(source, externalId);
    if (!document) {
      return textResult(formatDocumentNotFound(source, externalId));
    }
    return textResult(formatDocument(document));
  } catch (error) {
    return errorResult(`get_document failed.\n${describeError(error)}`);
  }
}
