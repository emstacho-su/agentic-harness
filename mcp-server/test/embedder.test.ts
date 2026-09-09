import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID } from '../src/config.js';
import { assertDimensions, FastEmbedEmbedder } from '../src/embedder.js';
import { DimensionMismatchError, EmbeddingError } from '../src/errors.js';

const vector = (length: number): number[] => Array.from({ length }, () => 0.1);

describe('assertDimensions', () => {
  it('accepts a correctly sized vector', () => {
    expect(() =>
      assertDimensions(vector(EMBEDDING_DIMENSIONS), EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID),
    ).not.toThrow();
  });

  it('throws DimensionMismatchError naming both widths and the model', () => {
    // 768 is bge-base — the realistic way this goes wrong.
    try {
      assertDimensions(vector(768), EMBEDDING_DIMENSIONS, 'BAAI/bge-base-en-v1.5');
      throw new Error('expected assertDimensions to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DimensionMismatchError);
      const mismatch = error as DimensionMismatchError;
      expect(mismatch.message).toContain('768-dimension');
      expect(mismatch.message).toContain('vector(384)');
      expect(mismatch.message).toContain('BAAI/bge-base-en-v1.5');
      expect(mismatch.hint).toContain(EMBEDDING_MODEL_ID);
    }
  });

  it('catches a short vector too', () => {
    expect(() => assertDimensions(vector(383), 384, EMBEDDING_MODEL_ID)).toThrowError(
      DimensionMismatchError,
    );
  });

  it('rejects non-finite values from a corrupt model', () => {
    const corrupt = vector(EMBEDDING_DIMENSIONS);
    corrupt[12] = Number.NaN;

    try {
      assertDimensions(corrupt, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID);
      throw new Error('expected assertDimensions to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingError);
      expect((error as EmbeddingError).message).toContain('index 12');
    }
  });
});

describe('FastEmbedEmbedder construction', () => {
  it('exposes the ingestion model identity', () => {
    const embedder = new FastEmbedEmbedder();
    expect(embedder.modelId).toBe(EMBEDDING_MODEL_ID);
    expect(embedder.dimensions).toBe(EMBEDDING_DIMENSIONS);
  });

  it('refuses a model the store was not embedded with', () => {
    try {
      new FastEmbedEmbedder({ modelId: 'sentence-transformers/all-MiniLM-L6-v2' });
      throw new Error('expected the constructor to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingError);
      const embeddingError = error as EmbeddingError;
      expect(embeddingError.message).toContain('Unsupported embedding model');
      expect(embeddingError.hint).toContain(EMBEDDING_MODEL_ID);
    }
  });

  it('refuses a dimension override that contradicts the model', () => {
    expect(() => new FastEmbedEmbedder({ dimensions: 768 })).toThrowError(DimensionMismatchError);
  });

  it('rejects an empty query before loading the model', async () => {
    // No model download happens: the empty check runs first.
    await expect(new FastEmbedEmbedder().embed('   ')).rejects.toThrowError(
      /Cannot embed an empty query/,
    );
  });
});
