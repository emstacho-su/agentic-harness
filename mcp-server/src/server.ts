/** Wires the two retrieval tools onto an MCP server instance. */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createGetDocumentTool } from './tools/get-document.js';
import { createSearchContextTool, type ToolDeps } from './tools/search-context.js';

export const SERVER_NAME = 'agentic-harness-rag';
export const SERVER_VERSION = '0.1.0';

export const SERVER_INSTRUCTIONS = [
  'This server is the retrieval side of the agentic-harness RAG store: an Obsidian vault plus six months of migrated agent memory, in Postgres with pgvector.',
  '',
  'Call `search_context` whenever the answer depends on past decisions, project history, or the user\'s own notes — it is cheap and local.',
  'Call `get_document` to read the full text behind a promising chunk.',
  '',
  'Scores are raw Reciprocal Rank Fusion scores from hybrid vector + full-text search. Higher is better; they are not similarity percentages and are not comparable across queries.',
].join('\n');

export function createRagServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  // Registered individually rather than in a loop: `registerTool` infers the
  // JSON Schema from each tool's own Zod shape, and a loop would collapse the
  // two shapes into a union.
  const search = createSearchContextTool(deps);
  server.registerTool(search.name, search.config, (args: unknown) => search.handler(args));

  const getDocument = createGetDocumentTool(deps);
  server.registerTool(getDocument.name, getDocument.config, (args: unknown) =>
    getDocument.handler(args),
  );

  return server;
}
