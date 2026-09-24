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
 * The embedder is built the way `search_context` builds it: the repo `.env` and
 * ~/.harness/machine.env are read as the server reads them, and the embedding
 * settings (cache dir, RAG_QUERY_PREFIX) come from `loadEmbeddingConfig`. So a
 * prefix set for the server shows in the header and in the numbers. Only the
 * embedding settings are used; no other value from those files is printed.
 *
 * All output goes to stdout here; this is a CLI, not the stdio server.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID, loadEmbeddingConfig } from '../dist/config.js';
import { loadEnvFiles } from '../dist/env-file.js';
import {
  compatibilityProblem,
  embedderFromConfig,
  embedReferences,
  formatReport,
  formatReportHeader,
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

/** The repo root, where the server looks for `.env` (dist/index.js resolves the same folder). */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

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

async function reportReferenceAgreement(embedder, queryPrefix) {
  const references = loadReferences(embedder);
  if (!references) return;

  for (const line of formatReportHeader(references, REFERENCE_PATH, queryPrefix)) {
    console.log(line);
  }
  console.log('');

  const vectors = await embedReferences(embedder, references);
  const scores = scoreReferences(references, vectors);
  for (const line of formatReport(scores, REFERENCE_AGREEMENT_THRESHOLD)) {
    console.log(line);
  }
}

/** A file that exists but will not parse is reported and skipped, as the server does. */
function reportEnvProblem(message) {
  console.log(`env: ${message}`);
}

async function main() {
  const embedding = loadEmbeddingConfig(
    loadEnvFiles(process.env, { repoRoot: REPO_ROOT, report: reportEnvProblem }),
  );

  console.log(`model:      ${EMBEDDING_MODEL_ID}`);
  console.log(`expected:   ${EMBEDDING_DIMENSIONS} dimensions`);
  console.log(`cache dir:  ${embedding.cacheDir ?? '(default ./local_cache)'}`);
  console.log('First run downloads ~130 MB from Hugging Face.\n');

  const embedder = embedderFromConfig(embedding);

  try {
    await checkShape(embedder);
    await reportReferenceAgreement(embedder, embedding.queryPrefix);
  } finally {
    await embedder.close();
  }
}

main().catch((error) => {
  console.error('FAILED');
  console.error(error);
  process.exit(1);
});
