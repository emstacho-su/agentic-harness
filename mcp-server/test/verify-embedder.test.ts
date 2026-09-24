import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID } from '../src/config.js';
import {
  compatibilityProblem,
  cosine,
  embedReferences,
  formatReport,
  parseReferences,
  REFERENCE_AGREEMENT_THRESHOLD,
  scoreReferences,
  type References,
} from '../src/embedder-report.js';
import { FakeEmbedder } from './helpers.js';

const TEXTS = [
  'What did we decide about the ledger cash invariant?',
  'pgvector HNSW index configuration',
  'Realm sync pushes after a merge-pull, never before',
] as const;

/** A reference file as `uv run ingest embed-check --record` writes it. */
async function recordedWith(embedder: FakeEmbedder): Promise<References> {
  const items = await Promise.all(
    TEXTS.map(async (text) => ({ text, vector: await embedder.embed(text) })),
  );
  return {
    model: EMBEDDING_MODEL_ID,
    dimensions: EMBEDDING_DIMENSIONS,
    fastembed: '0.7.3',
    onnxruntime: '1.22.0',
    machine: 'test',
    recorded_at: '2026-09-24T00:00:00Z',
    items,
  };
}

/** Flip the sign of every fourth component: same length, clearly different direction. */
function perturb(vector: readonly number[]): number[] {
  return vector.map((value, i) => (i % 4 === 0 ? -value : value));
}

describe('cosine', () => {
  it('is 1 for parallel vectors and 0 for orthogonal ones', () => {
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });

  it('refuses vectors of different length', () => {
    expect(() => cosine([1, 2], [1, 2, 3])).toThrowError(/length 2 vs 3/);
  });

  it('refuses a zero vector instead of returning NaN', () => {
    expect(() => cosine([0, 0], [1, 1])).toThrowError(/zero vector/);
  });
});

describe('scoreReferences', () => {
  it('scores identical embeddings at 1 for every item', async () => {
    const embedder = new FakeEmbedder();
    const references = await recordedWith(embedder);
    const vectors = await embedReferences(new FakeEmbedder(), references);

    const scores = scoreReferences(references, vectors);

    expect(scores.map((score) => score.text)).toEqual([...TEXTS]);
    for (const score of scores) {
      expect(score.cosine).toBeCloseTo(1, 12);
    }
  });

  it('names the item whose vector drifted and scores it below the threshold', async () => {
    const references = await recordedWith(new FakeEmbedder());
    const vectors = await embedReferences(new FakeEmbedder(), references);
    const drifted = vectors.map((vector, i) => (i === 1 ? perturb(vector) : vector));

    const scores = scoreReferences(references, drifted);
    const below = scores.filter((score) => score.cosine < REFERENCE_AGREEMENT_THRESHOLD);

    expect(below).toHaveLength(1);
    expect(below[0]?.text).toBe(TEXTS[1]);
  });

  it('refuses when the vector count does not match the reference items', async () => {
    const references = await recordedWith(new FakeEmbedder());
    expect(() => scoreReferences(references, [])).toThrowError(/3 reference items but 0 vectors/);
  });
});

describe('embedReferences', () => {
  it('embeds every reference text in order with the given embedder', async () => {
    const references = await recordedWith(new FakeEmbedder());
    const embedder = new FakeEmbedder();

    const vectors = await embedReferences(embedder, references);

    expect(embedder.calls).toEqual([...TEXTS]);
    expect(vectors).toHaveLength(TEXTS.length);
  });
});

describe('parseReferences', () => {
  it('accepts the recorded file shape', async () => {
    const recorded = await recordedWith(new FakeEmbedder());
    const parsed = parseReferences(JSON.stringify(recorded));

    expect(parsed.model).toBe(EMBEDDING_MODEL_ID);
    expect(parsed.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(parsed.items).toHaveLength(TEXTS.length);
    expect(parsed.items[2]?.vector).toEqual(recorded.items[2]?.vector);
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseReferences('{not json')).toThrowError(/not valid JSON/);
  });

  it('rejects a missing model or bad dimensions', async () => {
    const recorded = await recordedWith(new FakeEmbedder());
    expect(() => parseReferences(JSON.stringify({ ...recorded, model: '' }))).toThrowError(
      /"model"/,
    );
    expect(() => parseReferences(JSON.stringify({ ...recorded, dimensions: 0 }))).toThrowError(
      /"dimensions"/,
    );
  });

  it('rejects an empty item list', async () => {
    const recorded = await recordedWith(new FakeEmbedder());
    expect(() => parseReferences(JSON.stringify({ ...recorded, items: [] }))).toThrowError(
      /"items"/,
    );
  });

  it('names the item index of a vector with the wrong length', async () => {
    const recorded = await recordedWith(new FakeEmbedder());
    const items = recorded.items.map((item, i) =>
      i === 2 ? { ...item, vector: item.vector.slice(0, 100) } : item,
    );
    expect(() => parseReferences(JSON.stringify({ ...recorded, items }))).toThrowError(
      /item 2.*100.*384/,
    );
  });

  it('names the item index of a vector holding a non-number', async () => {
    const recorded = await recordedWith(new FakeEmbedder());
    const items = recorded.items.map((item, i) =>
      i === 1 ? { ...item, vector: item.vector.map((v, j) => (j === 5 ? 'x' : v)) } : item,
    );
    expect(() => parseReferences(JSON.stringify({ ...recorded, items }))).toThrowError(
      /item 1.*index 5/,
    );
  });

  it('names the item index of a missing text', async () => {
    const recorded = await recordedWith(new FakeEmbedder());
    const items = recorded.items.map((item, i) => (i === 0 ? { ...item, text: '' } : item));
    expect(() => parseReferences(JSON.stringify({ ...recorded, items }))).toThrowError(/item 0/);
  });
});

describe('compatibilityProblem', () => {
  it('is null when model and dimensions match the Node embedder', async () => {
    const references = await recordedWith(new FakeEmbedder());
    expect(compatibilityProblem(references, new FakeEmbedder())).toBeNull();
  });

  it('describes a model mismatch', async () => {
    const references = { ...(await recordedWith(new FakeEmbedder())), model: 'thenlper/gte-small' };
    expect(compatibilityProblem(references, new FakeEmbedder())).toMatch(
      /thenlper\/gte-small.*BAAI\/bge-small-en-v1\.5/,
    );
  });

  it('describes a dimension mismatch', async () => {
    const references = { ...(await recordedWith(new FakeEmbedder())), dimensions: 768 };
    expect(compatibilityProblem(references, new FakeEmbedder())).toMatch(/768.*384/);
  });
});

describe('formatReport', () => {
  const longText = 'x'.repeat(80);

  it('prints one line per item, the min, and the agreement note when all pass', () => {
    const lines = formatReport(
      [
        { text: 'short text', cosine: 0.9999991 },
        { text: longText, cosine: 0.9995 },
      ],
      REFERENCE_AGREEMENT_THRESHOLD,
    );

    expect(lines).toEqual([
      '  0.999999  short text',
      `  0.999500  ${'x'.repeat(57)}...`,
      'reference agreement: min 0.999500 (Python reference, threshold 0.999 informational)',
      'note: Node embeddings agree with the Python references',
    ]);
  });

  it('prints the disagreement note when the min is below the threshold', () => {
    const lines = formatReport(
      [
        { text: 'first', cosine: 0.99999 },
        { text: 'second\nline', cosine: 0.9871234 },
      ],
      REFERENCE_AGREEMENT_THRESHOLD,
    );

    expect(lines[1]).toBe('  0.987123  second line');
    expect(lines[2]).toBe(
      'reference agreement: min 0.987123 (Python reference, threshold 0.999 informational)',
    );
    expect(lines[3]).toBe(
      'note: Python and Node caches hold different ONNX artifacts of this model; a min below 0.999 means the two sides do not embed alike',
    );
  });

  it('keeps every item line within the truncation width', () => {
    const [line] = formatReport([{ text: longText, cosine: 1 }], REFERENCE_AGREEMENT_THRESHOLD);
    expect(line?.slice('  1.000000  '.length)).toHaveLength(60);
  });

  it('refuses an empty score list', () => {
    expect(() => formatReport([], REFERENCE_AGREEMENT_THRESHOLD)).toThrowError(/no scores/);
  });
});
