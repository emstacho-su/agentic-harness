/**
 * Offline embedding self-check. Needs no database credentials.
 *
 *   npm run build && npm run verify:embedder
 *
 * Confirms the local model loads on this machine and produces vectors that
 * match the shape ingestion wrote into rag.chunks.embedding. Run it after any
 * change to the embedding stack — a model swap does not error at query time,
 * it just returns quietly wrong rankings.
 *
 * All output goes to stdout here; this is a CLI, not the stdio server.
 */

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID } from '../dist/config.js';
import { FastEmbedEmbedder } from '../dist/embedder.js';

const SAMPLES = [
  'What did we decide about the ledger cash invariant?',
  'pgvector HNSW index configuration',
];

async function main() {
  console.log(`model:      ${EMBEDDING_MODEL_ID}`);
  console.log(`expected:   ${EMBEDDING_DIMENSIONS} dimensions`);
  console.log(`cache dir:  ${process.env.FASTEMBED_CACHE_DIR ?? '(default ./local_cache)'}`);
  console.log('First run downloads ~130 MB from Hugging Face.\n');

  const embedder = new FastEmbedEmbedder({
    cacheDir: process.env.FASTEMBED_CACHE_DIR,
  });

  for (const sample of SAMPLES) {
    const started = Date.now();
    const vector = await embedder.embed(sample);
    const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));

    console.log(`"${sample}"`);
    console.log(`  dims  ${vector.length}`);
    console.log(`  L2    ${norm.toFixed(6)}  (bge vectors are L2-normalised, expect ~1.0)`);
    console.log(`  head  [${vector.slice(0, 4).map((v) => v.toFixed(6)).join(', ')}, …]`);
    console.log(`  took  ${Date.now() - started} ms\n`);
  }

  await embedder.close();
  console.log('OK — embedder matches the ingestion contract.');
}

main().catch((error) => {
  console.error('FAILED');
  console.error(error);
  process.exit(1);
});
