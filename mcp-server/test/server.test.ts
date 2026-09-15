/**
 * End-to-end over the real MCP protocol, using the SDK's in-memory transport
 * pair. This is what catches schema-registration mistakes that unit tests on
 * the handlers cannot see.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRagServer, SERVER_NAME } from '../src/server.js';
import { FakeEmbedder, FakeRagClient, makeConfig, makeDocument, makeRow } from './helpers.js';

let client: Client;
let close: () => Promise<void>;
let rag: FakeRagClient;

beforeEach(async () => {
  rag = new FakeRagClient([makeRow()], makeDocument());
  const server = createRagServer({
    embedder: new FakeEmbedder(),
    rag,
    config: makeConfig(),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  close = async () => {
    await Promise.allSettled([client.close(), server.close()]);
  };
});

afterEach(async () => {
  await close();
});

function firstText(result: unknown): string {
  const content = (result as { content: Array<{ text?: string }> }).content;
  return content.map((part) => part.text ?? '').join('\n');
}

describe('createRagServer', () => {
  it('advertises exactly the two retrieval tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['get_document', 'search_context']);
  });

  it('publishes a JSON Schema with the documented search_context parameters', async () => {
    const { tools } = await client.listTools();
    const search = tools.find((tool) => tool.name === 'search_context');

    expect(search?.inputSchema.required).toEqual(['query']);
    expect(Object.keys(search?.inputSchema.properties ?? {}).sort()).toEqual([
      'collection',
      'include_superseded',
      'limit',
      'min_similarity',
      'phase',
      'query',
      'repo',
      'source',
      'tags',
    ]);

    const source = (search?.inputSchema.properties as Record<string, { enum?: string[] }>)['source'];
    expect(source?.enum).toEqual(['obsidian', 'claude-mem', 'hermes']);

    // collection is deliberately an open string: 17 exist today and vault
    // ingestion adds more, so an enum would go stale.
    const collection = (search?.inputSchema.properties as Record<string, { type?: string }>)['collection'];
    expect(collection?.type).toBe('string');
  });

  it('publishes the get_document schema with both key fields required', async () => {
    const { tools } = await client.listTools();
    const get = tools.find((tool) => tool.name === 'get_document');
    expect((get?.inputSchema.required ?? []).slice().sort()).toEqual(['external_id', 'source']);
  });

  it('marks both tools read-only', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('reports the server identity', async () => {
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
  });

  it('round-trips a search_context call', async () => {
    const result = await client.callTool({
      name: 'search_context',
      arguments: { query: 'ledger invariants', limit: 5 },
    });

    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain('### 1. Ledger event types');
    expect(rag.searchCalls[0]?.matchCount).toBe(5);
  });

  it('round-trips a collection-filtered search', async () => {
    const result = await client.callTool({
      name: 'search_context',
      arguments: { query: 'ledger', collection: 'quant-edge-tracker', min_similarity: 0.6 },
    });

    expect(result.isError).toBeFalsy();
    expect(rag.searchCalls[0]?.filterCollection).toBe('quant-edge-tracker');
    expect(rag.searchCalls[0]?.minSimilarity).toBe(0.6);
  });

  it('round-trips a get_document call', async () => {
    const result = await client.callTool({
      name: 'get_document',
      arguments: { source: 'obsidian', external_id: 'notes/ledger.md' },
    });

    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain('# Ledger model');
  });

  it('rejects a bad source at the protocol boundary', async () => {
    const result = await client.callTool({
      name: 'search_context',
      arguments: { query: 'x', source: 'notion' },
    });

    expect(result.isError).toBe(true);
    expect(rag.searchCalls).toHaveLength(0);
  });
});
