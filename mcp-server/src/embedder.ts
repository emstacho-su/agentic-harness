/**
 * Local query embedding.
 *
 * EMBEDDING PARITY IS LOAD-BEARING. `rag.chunks.embedding` was written by the
 * Python `fastembed` implementation of BAAI/bge-small-en-v1.5. If retrieval
 * embeds with a different model the database will happily return rows — just
 * meaningless ones. So the model identity is asserted explicitly here and every
 * vector is length-checked before it reaches SQL.
 *
 * `fastembed` (npm) is the JS port of Qdrant's Python `fastembed`: it downloads
 * the same `fast-bge-small-en-v1.5` ONNX artifact (`model_optimized.onnx`) from
 * the same Hugging Face mirror and applies the same CLS-pool + L2-normalise
 * post-processing. That is why it is used instead of transformers.js, which
 * would run the unquantised fp32 weights and drift slightly.
 */

import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID } from './config.js';
import { DimensionMismatchError, EmbeddingError } from './errors.js';

export interface Embedder {
  /** Human-readable model identity, surfaced in errors and diagnostics. */
  readonly modelId: string;
  /** Vector width this embedder promises to produce. */
  readonly dimensions: number;
  /** Embed a single query string. Result is always `dimensions` long. */
  embed(text: string): Promise<number[]>;
  close(): Promise<void>;
}

/** fastembed's standard (non-CUSTOM) model ids. */
type StandardModel = Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>;

/** fastembed model ids we are allowed to use, keyed by canonical HF model id. */
const SUPPORTED_MODELS: Readonly<Record<string, { model: StandardModel; dimensions: number }>> = {
  [EMBEDDING_MODEL_ID]: { model: EmbeddingModel.BGESmallENV15, dimensions: EMBEDDING_DIMENSIONS },
};

/**
 * Guard against a silent dimension drift between the embedder and the
 * `vector(384)` column. Always call this before handing a vector to SQL.
 */
export function assertDimensions(vector: readonly number[], expected: number, modelId: string): void {
  if (vector.length !== expected) {
    throw new DimensionMismatchError(
      `Embedding model ${modelId} produced a ${vector.length}-dimension vector but rag.chunks.embedding is vector(${expected}).`,
      `Retrieval and ingestion must use the same model. Confirm ingestion still uses ${EMBEDDING_MODEL_ID} (${EMBEDDING_DIMENSIONS} dims) and that FASTEMBED_CACHE_DIR does not hold a different model.`,
    );
  }

  const badIndex = vector.findIndex((value) => !Number.isFinite(value));
  if (badIndex !== -1) {
    throw new EmbeddingError(
      `Embedding contains a non-finite value at index ${badIndex}.`,
      'The ONNX model output is corrupt. Delete the fastembed cache directory and let it re-download the model.',
    );
  }
}

export interface FastEmbedOptions {
  modelId?: string;
  dimensions?: number;
  cacheDir?: string | undefined;
  /** Prefix prepended to the query text before embedding. Default: none. */
  queryPrefix?: string;
}

/**
 * Lazily-initialised fastembed embedder.
 *
 * Initialisation downloads ~130 MB on first run, so it is deferred until the
 * first `search_context` call rather than blocking MCP handshake. Concurrent
 * callers share one in-flight init promise.
 */
export class FastEmbedEmbedder implements Embedder {
  readonly modelId: string;
  readonly dimensions: number;

  readonly #model: StandardModel;
  readonly #cacheDir: string | undefined;
  readonly #queryPrefix: string;
  #pending: Promise<FlagEmbedding> | null = null;

  constructor(options: FastEmbedOptions = {}) {
    this.modelId = options.modelId ?? EMBEDDING_MODEL_ID;
    const supported = SUPPORTED_MODELS[this.modelId];

    if (!supported) {
      throw new EmbeddingError(
        `Unsupported embedding model ${JSON.stringify(this.modelId)}.`,
        `This server only implements ${Object.keys(SUPPORTED_MODELS).join(', ')} because that is what ingestion wrote into rag.chunks.embedding.`,
      );
    }

    this.dimensions = options.dimensions ?? supported.dimensions;

    if (this.dimensions !== supported.dimensions) {
      throw new DimensionMismatchError(
        `Requested ${this.dimensions} dimensions but ${this.modelId} produces ${supported.dimensions}.`,
        'Remove the dimension override; the column width is fixed at vector(384).',
      );
    }

    this.#model = supported.model;
    this.#cacheDir = options.cacheDir;
    this.#queryPrefix = options.queryPrefix ?? '';
  }

  async #load(): Promise<FlagEmbedding> {
    if (!this.#pending) {
      this.#pending = FlagEmbedding.init({
        model: this.#model,
        // MUST stay false: this is a stdio server and stdout is the JSON-RPC
        // channel. A progress bar there corrupts the protocol stream.
        showDownloadProgress: false,
        ...(this.#cacheDir ? { cacheDir: this.#cacheDir } : {}),
      }).catch((cause: unknown) => {
        this.#pending = null;
        throw new EmbeddingError(
          `Failed to load embedding model ${this.modelId}.`,
          'First run downloads ~130 MB from Hugging Face; check network access, or pre-populate FASTEMBED_CACHE_DIR from a machine that has it.',
          { cause },
        );
      });
    }
    return this.#pending;
  }

  async embed(text: string): Promise<number[]> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new EmbeddingError(
        'Cannot embed an empty query.',
        'Pass a non-empty `query` string to search_context.',
      );
    }

    const model = await this.#load();
    const input = this.#queryPrefix ? `${this.#queryPrefix}${trimmed}` : trimmed;

    let first: ArrayLike<number> | undefined;
    try {
      for await (const batch of model.embed([input], 1)) {
        first = batch[0];
        break;
      }
    } catch (cause) {
      throw new EmbeddingError(
        `Embedding failed for model ${this.modelId}.`,
        'Delete the fastembed cache directory to force a clean model re-download, then retry.',
        { cause },
      );
    }

    if (!first) {
      throw new EmbeddingError(
        `Embedding model ${this.modelId} returned no vectors.`,
        'This usually means the ONNX session produced an empty batch. Clear the fastembed cache and retry.',
      );
    }

    const vector = Array.from(first);
    assertDimensions(vector, this.dimensions, this.modelId);
    return vector;
  }

  async close(): Promise<void> {
    this.#pending = null;
  }
}
