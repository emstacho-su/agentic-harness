/**
 * Offline embedding self-check. Needs no database credentials.
 *
 *   npm run verify:embedder      (builds first; the script imports from dist/)
 *
 * Confirms the local model loads on this machine and produces vectors that
 * match the shape ingestion wrote into rag.chunks.embedding. Run it after any
 * change to the embedding stack — a model swap does not error at query time,
 * it just returns quietly wrong rankings.
 *
 * Then, when `ingest/eval/embeddings.json` exists (written by
 * `uv run ingest embed-check --record`), it embeds the Python reference texts
 * with the Node embedder and reports the cosine per item (R-D2). That part is
 * a report, not a gate: it exits 0 whatever the numbers are. Only a failure of
 * the dimension and norm checks above it exits 1.
 *
 * All output goes to stdout here; this is a CLI, not the stdio server.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID } from '../dist/config.js';
import { FastEmbedEmbedder } from '../dist/embedder.js';
import {
  compatibilityProblem,
  embedReferences,
  formatReport,
  parseReferences,
  REFERENCE_AGREEMENT_THRESHOLD,
  scoreReferences,
} from '../dist/embedder-report.js';

const SAMPLES = [
  'What did we decide about the ledger cash invariant?',
  'pgvector HNSW index configuration',
];

/** Repo-root `ingest/eval/embeddings.json`, resolved from this script (mcp-server/scripts/). */
const REFERENCE_PATH = fileURLToPath(new URL('../../ingest/eval/embeddings.json', import.meta.url));

async function checkShape(embedder) {
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
  console.log('OK — embedder matches the ingestion contract.\n');
}

/** Read and validate the reference file; null (after printing why) when there is nothing to compare. */
function loadReferences(embedder) {
  if (!existsSync(REFERENCE_PATH)) {
    console.log(
      `reference file not found: ${REFERENCE_PATH} (run \`uv run ingest embed-check --record\` first)`,
    );
    return null;
  }

  let references;
  try {
    references = parseReferences(readFileSync(REFERENCE_PATH, 'utf8'));
  } catch (error) {
    console.log(`reference file unusable: ${REFERENCE_PATH}: ${error.message}; not comparing`);
    return null;
  }

  const problem = compatibilityProblem(references, embedder);
  if (problem) {
    console.log(problem);
    return null;
  }
  return references;
}

async function reportReferenceAgreement(embedder) {
  const references = loadReferences(embedder);
  if (!references) return;

  const recordedOn = [
    references.recorded_at && `recorded ${references.recorded_at}`,
    references.machine && `on ${references.machine}`,
    references.fastembed && `fastembed ${references.fastembed}`,
    references.onnxruntime && `onnxruntime ${references.onnxruntime}`,
  ].filter(Boolean);
  console.log(`reference:  ${REFERENCE_PATH}`);
  if (recordedOn.length > 0) console.log(`            ${recordedOn.join(', ')}`);
  console.log(`items:      ${references.items.length}\n`);

  const vectors = await embedReferences(embedder, references);
  const scores = scoreReferences(references, vectors);
  for (const line of formatReport(scores, REFERENCE_AGREEMENT_THRESHOLD)) {
    console.log(line);
  }
}

async function main() {
  console.log(`model:      ${EMBEDDING_MODEL_ID}`);
  console.log(`expected:   ${EMBEDDING_DIMENSIONS} dimensions`);
  console.log(`cache dir:  ${process.env.FASTEMBED_CACHE_DIR ?? '(default ./local_cache)'}`);
  console.log('First run downloads ~130 MB from Hugging Face.\n');

  const embedder = new FastEmbedEmbedder({
    cacheDir: process.env.FASTEMBED_CACHE_DIR,
  });

  try {
    await checkShape(embedder);
    await reportReferenceAgreement(embedder);
  } finally {
    await embedder.close();
  }
}

main().catch((error) => {
  console.error('FAILED');
  console.error(error);
  process.exit(1);
});
