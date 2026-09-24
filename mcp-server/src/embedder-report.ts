/**
 * Node-vs-Python embedding agreement report (R-D2, Node side).
 *
 * Ingestion embeds with Python `fastembed`; `search_context` embeds queries
 * with npm `fastembed`. Both claim BAAI/bge-small-en-v1.5, but each caches its
 * own ONNX artifact of it. `ingest/eval/embeddings.json` holds ten reference
 * vectors recorded by the Python side; this module scores the Node embedder
 * against them. It is a report, not a gate: `verify-embedder.mjs` exits 0
 * whatever the numbers say.
 *
 * Pure apart from `embedReferences`, which only calls the injected embedder,
 * and `embedderFromConfig`, which builds the live one the same way the server
 * does, so the script and the tests share every line of the scoring logic.
 */

import type { EmbeddingConfig } from './config.js';
import { type Embedder, FastEmbedEmbedder } from './embedder.js';

/**
 * Cosine the Python `embed-check` gate uses (R-D2). Same-model runs on
 * different CPUs land around 0.99999; a different artifact or post-processing
 * step falls well below. Informational on this side.
 */
export const REFERENCE_AGREEMENT_THRESHOLD = 0.999;

/** Width a reference text is cut to in the per-item lines, so each stays on one terminal line. */
export const REPORT_TEXT_WIDTH = 60;

/** Decimal places in the report. Six resolves the 0.999 boundary with room to spare. */
const COSINE_DECIMALS = 6;

const ELLIPSIS = '...';

/** Label column of the report header, wide enough for its longest label. */
const HEADER_LABEL_WIDTH = 'query prefix: '.length;

export interface ReferenceItem {
  readonly text: string;
  readonly vector: readonly number[];
}

/** Parsed `ingest/eval/embeddings.json`. Provenance fields are optional and only printed. */
export interface References {
  readonly model: string;
  readonly dimensions: number;
  readonly fastembed?: string | undefined;
  readonly onnxruntime?: string | undefined;
  readonly machine?: string | undefined;
  readonly recorded_at?: string | undefined;
  readonly items: readonly ReferenceItem[];
}

export interface ReferenceScore {
  readonly text: string;
  readonly cosine: number;
}

/** Cosine similarity. Throws rather than returning NaN on unequal lengths or a zero vector. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Cannot compare vectors of length ${a.length} vs ${b.length}.`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) {
    throw new Error('Cannot take the cosine of a zero vector.');
  }
  return dot / Math.sqrt(normA * normB);
}

/** Pair each reference item with the cosine between its recorded vector and the fresh one. */
export function scoreReferences(
  references: References,
  vectors: readonly (readonly number[])[],
): readonly ReferenceScore[] {
  if (vectors.length !== references.items.length) {
    throw new Error(
      `Got ${references.items.length} reference items but ${vectors.length} vectors to score.`,
    );
  }
  return references.items.map((item, i) => ({
    text: item.text,
    cosine: cosine(item.vector, vectors[i] as readonly number[]),
  }));
}

/**
 * The Node embedder exactly as `search_context` builds it (src/index.ts): same
 * model, cache dir and RAG_QUERY_PREFIX, so the report measures what queries get.
 */
export function embedderFromConfig(embedding: EmbeddingConfig): Embedder {
  return new FastEmbedEmbedder({
    modelId: embedding.modelId,
    dimensions: embedding.dimensions,
    cacheDir: embedding.cacheDir,
    queryPrefix: embedding.queryPrefix,
  });
}

/**
 * Header lines of the reference report: the file, its provenance, the item
 * count and the query prefix. A set prefix is quoted (so trailing spaces show)
 * and flagged, because the Python references never carry one.
 */
export function formatReportHeader(
  references: References,
  source: string,
  queryPrefix: string,
): readonly string[] {
  const label = (name: string): string => `${name}:`.padEnd(HEADER_LABEL_WIDTH);
  const recordedOn = [
    references.recorded_at && `recorded ${references.recorded_at}`,
    references.machine && `on ${references.machine}`,
    references.fastembed && `fastembed ${references.fastembed}`,
    references.onnxruntime && `onnxruntime ${references.onnxruntime}`,
  ].filter(Boolean);

  const lines = [`${label('reference')}${source}`];
  if (recordedOn.length > 0) lines.push(`${' '.repeat(HEADER_LABEL_WIDTH)}${recordedOn.join(', ')}`);
  lines.push(`${label('items')}${references.items.length}`);
  lines.push(`${label('query prefix')}${queryPrefix ? JSON.stringify(queryPrefix) : 'none'}`);
  if (queryPrefix) {
    lines.push(
      'note: RAG_QUERY_PREFIX is prepended on the Node side and the Python references were embedded without it, so the cosines below differ on purpose',
    );
  }
  return lines;
}

/** Embed each reference text in order. Sequential: one ONNX session, no gain from overlap. */
export async function embedReferences(
  embedder: Embedder,
  references: References,
): Promise<readonly (readonly number[])[]> {
  const vectors: number[][] = [];
  for (const item of references.items) {
    vectors.push(await embedder.embed(item.text));
  }
  return vectors;
}

/**
 * Why these references cannot be compared with this embedder, or null when
 * they can. A different model or width would make every cosine meaningless.
 */
export function compatibilityProblem(
  references: References,
  embedder: Pick<Embedder, 'modelId' | 'dimensions'>,
): string | null {
  if (references.model !== embedder.modelId) {
    return `reference model ${references.model} differs from the Node model ${embedder.modelId}; not comparing`;
  }
  if (references.dimensions !== embedder.dimensions) {
    return `reference dimensions ${references.dimensions} differ from the Node embedder's ${embedder.dimensions}; not comparing`;
  }
  return null;
}

/** Parse and validate the reference file's text. Throws an Error naming the bad field or item. */
export function parseReferences(text: string): References {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error('Reference file is not valid JSON.', { cause });
  }

  if (!isRecord(raw)) {
    throw new Error('Reference file must be a JSON object.');
  }

  const model = raw['model'];
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('Reference file field "model" must be a non-empty string.');
  }

  const dimensions = raw['dimensions'];
  if (typeof dimensions !== 'number' || !Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error('Reference file field "dimensions" must be a positive integer.');
  }

  const items = raw['items'];
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Reference file field "items" must be a non-empty array.');
  }

  return {
    model,
    dimensions,
    fastembed: optionalString(raw, 'fastembed'),
    onnxruntime: optionalString(raw, 'onnxruntime'),
    machine: optionalString(raw, 'machine'),
    recorded_at: optionalString(raw, 'recorded_at'),
    items: items.map((item: unknown, index) => parseItem(item, index, dimensions)),
  };
}

function parseItem(item: unknown, index: number, dimensions: number): ReferenceItem {
  if (!isRecord(item)) {
    throw new Error(`Reference item ${index} must be an object with "text" and "vector".`);
  }

  const text = item['text'];
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error(`Reference item ${index} has no "text" string.`);
  }

  const vector = item['vector'];
  if (!Array.isArray(vector)) {
    throw new Error(`Reference item ${index} has no "vector" array.`);
  }
  if (vector.length !== dimensions) {
    throw new Error(
      `Reference item ${index} vector has ${vector.length} values but "dimensions" is ${dimensions}.`,
    );
  }

  const badIndex = vector.findIndex(
    (value: unknown) => typeof value !== 'number' || !Number.isFinite(value),
  );
  if (badIndex !== -1) {
    throw new Error(`Reference item ${index} vector holds a non-finite value at index ${badIndex}.`);
  }

  return { text, vector: [...(vector as number[])] };
}

/**
 * Report lines: one per item, then the min, then a one-line verdict. Informational;
 * the caller decides the exit code (always 0 in `verify-embedder.mjs`).
 */
export function formatReport(
  scores: readonly ReferenceScore[],
  threshold: number = REFERENCE_AGREEMENT_THRESHOLD,
): readonly string[] {
  if (scores.length === 0) {
    throw new Error('Cannot format a report with no scores.');
  }

  const min = Math.min(...scores.map((score) => score.cosine));
  const verdict =
    min < threshold
      ? `note: Python and Node caches hold different ONNX artifacts of this model; a min below ${threshold} means the two sides do not embed alike`
      : 'note: Node embeddings agree with the Python references';

  return [
    ...scores.map((score) => `  ${score.cosine.toFixed(COSINE_DECIMALS)}  ${truncate(score.text)}`),
    `reference agreement: min ${min.toFixed(COSINE_DECIMALS)} (Python reference, threshold ${threshold} informational)`,
    verdict,
  ];
}

/** Collapse whitespace so a multi-line text prints on one line, then cut to REPORT_TEXT_WIDTH. */
function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= REPORT_TEXT_WIDTH
    ? oneLine
    : `${oneLine.slice(0, REPORT_TEXT_WIDTH - ELLIPSIS.length)}${ELLIPSIS}`;
}

function optionalString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
