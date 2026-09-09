import { describe, expect, it } from 'vitest';
import { DatabaseError } from '../src/errors.js';
import { handleGetDocument } from '../src/tools/get-document.js';
import type { ToolDeps } from '../src/tools/search-context.js';
import { FakeEmbedder, FakeRagClient, makeConfig, makeDocument, textOf } from './helpers.js';

function deps(rag: FakeRagClient): ToolDeps {
  return { embedder: new FakeEmbedder(), rag, config: makeConfig() };
}

describe('get_document — input validation', () => {
  const rag = () => new FakeRagClient([], makeDocument());

  it('requires both keys', async () => {
    const missingBoth = await handleGetDocument(deps(rag()), {});
    expect(missingBoth.isError).toBe(true);
    expect(textOf(missingBoth)).toContain('external_id');
    expect(textOf(missingBoth)).toContain('source');

    const missingSource = await handleGetDocument(deps(rag()), { external_id: 'notes/a.md' });
    expect(missingSource.isError).toBe(true);
  });

  it('rejects empty strings', async () => {
    const result = await handleGetDocument(deps(rag()), { external_id: '  ', source: 'obsidian' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('external_id must not be empty');
  });

  it('rejects a non-string external_id', async () => {
    const result = await handleGetDocument(deps(rag()), { external_id: 12, source: 'obsidian' });
    expect(result.isError).toBe(true);
  });

  it('accepts a source outside the known list so new producers keep working', async () => {
    const client = new FakeRagClient([], makeDocument({ source: 'future-agent' }));
    const result = await handleGetDocument(deps(client), {
      external_id: 'notes/ledger.md',
      source: 'future-agent',
    });

    expect(result.isError).toBeUndefined();
    expect(client.getCalls[0]).toEqual({ source: 'future-agent', externalId: 'notes/ledger.md' });
  });
});

describe('get_document — lookup', () => {
  it('renders the full document', async () => {
    const client = new FakeRagClient([], makeDocument());
    const result = await handleGetDocument(deps(client), {
      external_id: 'notes/ledger.md',
      source: 'obsidian',
    });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('# Ledger model');
    expect(textOf(result)).toContain('Full note body.');
    expect(client.getCalls[0]).toEqual({ source: 'obsidian', externalId: 'notes/ledger.md' });
  });

  it('trims the key before querying', async () => {
    const client = new FakeRagClient([], makeDocument());
    await handleGetDocument(deps(client), { external_id: ' notes/ledger.md ', source: ' obsidian ' });
    expect(client.getCalls[0]).toEqual({ source: 'obsidian', externalId: 'notes/ledger.md' });
  });

  it('returns a non-error message when the document does not exist', async () => {
    const result = await handleGetDocument(deps(new FakeRagClient([], null)), {
      external_id: 'missing.md',
      source: 'obsidian',
    });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('No document in rag.documents');
    expect(textOf(result)).toContain('empty result, not an error');
  });

  it('surfaces a database error with its hint', async () => {
    const client = new FakeRagClient(
      [],
      null,
      new DatabaseError('Lookup of rag.documents failed', 'Apply db/migrations.'),
    );

    const result = await handleGetDocument(deps(client), { external_id: 'x', source: 'obsidian' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('get_document failed');
    expect(textOf(result)).toContain('Fix: Apply db/migrations.');
  });
});
