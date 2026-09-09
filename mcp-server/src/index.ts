#!/usr/bin/env node
/**
 * stdio entry point.
 *
 * HARD RULE: stdout is the JSON-RPC channel. Every diagnostic goes to stderr.
 * Anything that writes to stdout (a progress bar, a stray console.log) corrupts
 * the protocol and the client silently loses the server.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createRagClient } from './db/index.js';
import { FastEmbedEmbedder } from './embedder.js';
import { describeError } from './errors.js';
import { createRagServer, SERVER_NAME, SERVER_VERSION } from './server.js';

function log(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  const embedder = new FastEmbedEmbedder({
    modelId: config.embedding.modelId,
    dimensions: config.embedding.dimensions,
    cacheDir: config.embedding.cacheDir,
    queryPrefix: config.embedding.queryPrefix,
  });

  const rag = createRagClient(config);
  const server = createRagServer({ embedder, rag, config });
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
    await Promise.allSettled([server.close(), rag.close(), embedder.close()]);
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  await server.connect(transport);

  log(
    `v${SERVER_VERSION} ready — ${rag.description}, embeddings ${embedder.modelId} (${embedder.dimensions}d, loaded on first search)`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`[${SERVER_NAME}] fatal startup error\n${describeError(error)}\n`);
  process.exit(1);
});
