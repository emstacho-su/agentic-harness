/**
 * Typed errors for the RAG MCP server.
 *
 * Every failure mode the operator can actually fix carries a `hint` explaining
 * the fix. Nothing is silently swallowed: handlers convert these into MCP tool
 * errors whose text contains both the message and the hint.
 */

export class HarnessError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.hint = hint;
  }
}

/** Missing / malformed environment configuration. */
export class ConfigError extends HarnessError {}

/** The local embedding model failed to load or produce a vector. */
export class EmbeddingError extends HarnessError {}

/**
 * The embedder returned a vector whose length does not match the column the
 * database was built with. This is the failure mode that would otherwise
 * silently return garbage rankings, so it is always fatal for the call.
 */
export class DimensionMismatchError extends EmbeddingError {}

/** Connection, query, or transport failure talking to Postgres / PostgREST. */
export class DatabaseError extends HarnessError {}

/**
 * Render any thrown value as an actionable, single-string message suitable for
 * returning to an LLM client. Never throws.
 */
export function describeError(error: unknown): string {
  if (error instanceof HarnessError) {
    const kind = error.name.replace(/Error$/, '');
    const lines = [`${kind} error: ${error.message}`];
    if (error.hint) lines.push(`Fix: ${error.hint}`);
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message !== error.message) {
      lines.push(`Cause: ${cause.message}`);
    }
    return lines.join('\n');
  }

  if (error instanceof Error) {
    return `Unexpected error: ${error.message}`;
  }

  return `Unexpected error: ${String(error)}`;
}
