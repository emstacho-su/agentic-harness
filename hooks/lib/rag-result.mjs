/**
 * Retrieval provenance from the RAG server's rendered tool text.
 *
 * Claude Code ignores MCP `structuredContent` and the transcript keeps only a
 * tool result's text blocks, so the rendered lines of `mcp-server/src/format.ts`
 * are the wire format. They are pinned on both sides by the shared fixtures in
 * `tests/fixtures/rag-results/`: `mcp-server/test/transcript-contract.test.ts`
 * renders them byte for byte, `tests/rag-result.test.mjs` parses them.
 *
 * Only identity and score fields are read. The `- metadata:` line, the chunk
 * text and a document's body are never copied: they are large, and they are
 * the store's content, not a record of the retrieval.
 *
 * Pure: no filesystem, no imports. Nothing here throws; text that matches no
 * known shape is null, and a search that could not be read whole is `partial`.
 */

const TOOL_PREFIX = 'mcp__rag__';
const SEARCH_TOOL = 'search_context';
const DOCUMENT_TOOL = 'get_document';

/** `N result(s) for "<query>" (<scope>, top K).` then the fixed second line. Greedy query: the scope never contains `" (`. */
const SEARCH_HEADER =
  /^(\d+) results? for "([\s\S]*)" \([^\n]*, top \d+\)\.\nHybrid search: /;
/** `Nothing relevant found for "<query>" in <scope>.` then a blank line and one of two fixed sentences. */
const EMPTY_HEADER =
  /^Nothing relevant found for "([\s\S]*)" in [^\n]*\.\n\n(?:The store was searched|No chunk cleared)/;
const NOT_FOUND =
  /^No document in rag\.documents with source="([^"\n]*)" and external_id="([\s\S]*)"\.\n\nThis is an empty result, not an error\./;

const BLOCK_HEADING = /^### (\d+)\. (.*)$/;
const FIELD_LINE = /^- ([a-z_]+): (.*)$/;
const SIMILARITY = /^(-?\d+(?:\.\d+)?)( \(below the .* floor\b.*\))?$/;
const RRF = /^(\S+) \(ordering only\)$/;
const IDS = /^doc (\d+), chunk (\d+)$/;
const INTEGER = /^\d+$/;

/** A search block needs all of these to count as a result. */
const REQUIRED_SEARCH_FIELDS = ['source', 'external_id', 'similarity', 'rrf', 'ids'];

function toLines(text) {
  return text.replace(/\r\n?/g, '\n');
}

/** The server's two error shapes, named for the tool; a document title ending in "failed." is not one. */
function isErrorRendering(tool, text) {
  const firstLine = text.split('\n', 1)[0];
  return firstLine === `${tool} failed.` || firstLine.startsWith(`Invalid arguments for ${tool}:`);
}

/**
 * The `- key: value` lines from `start` up to the first line that is not one.
 * First occurrence of a key wins; unknown keys are kept but never read.
 */
function readFields(lines, start) {
  const fields = new Map();
  for (let index = start; index < lines.length; index += 1) {
    const match = FIELD_LINE.exec(lines[index]);
    if (!match) break;
    if (!fields.has(match[1])) fields.set(match[1], match[2]);
  }
  return fields;
}

function parseSimilarity(value) {
  if (value === 'n/a') return { similarity: null, belowFloor: false };
  const match = SIMILARITY.exec(value);
  if (!match) return null;
  return { similarity: Number(match[1]), belowFloor: match[2] !== undefined };
}

function parseRrf(value) {
  const match = RRF.exec(value);
  if (!match) return null;
  const score = Number(match[1]);
  return Number.isFinite(score) ? score : null;
}

/** One result block, or null when a required field is missing or malformed. */
function parseBlock(rank, title, fields) {
  if (!REQUIRED_SEARCH_FIELDS.every((key) => fields.has(key))) return null;
  const similarity = parseSimilarity(fields.get('similarity'));
  const rrf = parseRrf(fields.get('rrf'));
  const ids = IDS.exec(fields.get('ids'));
  if (!similarity || rrf === null || !ids) return null;
  return {
    rank,
    title,
    source: fields.get('source'),
    collection: fields.get('collection') ?? null,
    externalId: fields.get('external_id'),
    similarity: similarity.similarity,
    belowFloor: similarity.belowFloor,
    rrf,
    docId: Number(ids[1]),
    chunkId: Number(ids[2]),
  };
}

/**
 * A real block starts right after the header's blank line (rank 1) or after
 * the `\n\n---\n\n` separator (every later rank), is numbered in sequence, and
 * its heading is followed at once by `- source: `. Chunk text can contain any
 * of those pieces on its own, so all of them are required together. A fake
 * that satisfies every one is indistinguishable from a real block; the header
 * count then disagrees and the parse is marked partial.
 */
function isBlockStart(lines, index, rank) {
  if (!lines[index + 1]?.startsWith('- source: ')) return false;
  if (lines[index - 1] !== '') return false;
  return rank === 1 || lines[index - 2] === '---';
}

/**
 * `conflict` is set when a second well-framed block claims a rank already
 * taken: a block forged in chunk text got there first and pushed the real one
 * out of sequence, so the count alone would still agree.
 */
function scanBlocks(lines) {
  const results = [];
  let conflict = false;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = BLOCK_HEADING.exec(lines[index]);
    if (!heading) continue;
    const rank = Number(heading[1]);
    if (!isBlockStart(lines, index, rank)) continue;
    if (rank !== results.length + 1) {
      if (rank >= 1 && rank <= results.length) conflict = true;
      continue;
    }
    const block = parseBlock(rank, heading[2], readFields(lines, index + 1));
    if (block) results.push(block);
  }
  return { results, conflict };
}

/** A `search_context` rendering, or null when the text is not one. */
export function parseSearchResult(text) {
  if (typeof text !== 'string') return null;
  const normalised = toLines(text);

  const empty = EMPTY_HEADER.exec(normalised);
  if (empty) return { kind: 'search', query: empty[1], count: 0, results: [], partial: false };

  const header = SEARCH_HEADER.exec(normalised);
  if (!header) return null;

  const count = Number(header[1]);
  const { results, conflict } = scanBlocks(normalised.split('\n'));
  return { kind: 'search', query: header[2], count, results, partial: conflict || results.length !== count };
}

/** A `get_document` rendering (found or not found), or null when the text is neither. */
export function parseDocumentResult(text) {
  if (typeof text !== 'string') return null;
  const normalised = toLines(text);

  const missing = NOT_FOUND.exec(normalised);
  if (missing) return { kind: 'document', found: false, source: missing[1], externalId: missing[2] };

  const lines = normalised.split('\n');
  if (!lines[0]?.startsWith('# ') || lines[1] !== '') return null;

  const fields = readFields(lines, 2);
  const docId = fields.get('doc_id');
  if (!fields.has('source') || !fields.has('external_id') || !INTEGER.test(docId ?? '')) return null;

  return {
    kind: 'document',
    title: lines[0].slice(2),
    source: fields.get('source'),
    collection: fields.get('collection') ?? null,
    externalId: fields.get('external_id'),
    docId: Number(docId),
  };
}

/**
 * Parse a RAG tool result by tool name (`search_context`, `get_document`, or
 * either with the `mcp__rag__` prefix). Null for any other tool, for an error
 * rendering, and for text that matches no known shape.
 */
export function parseRagResult(toolName, text) {
  if (typeof toolName !== 'string' || typeof text !== 'string') return null;
  const bare = toolName.startsWith(TOOL_PREFIX) ? toolName.slice(TOOL_PREFIX.length) : toolName;
  if (isErrorRendering(bare, toLines(text))) return null;
  if (bare === SEARCH_TOOL) return parseSearchResult(text);
  if (bare === DOCUMENT_TOOL) return parseDocumentResult(text);
  return null;
}
