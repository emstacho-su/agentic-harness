/**
 * R-P1: the RAG searches a transcript made, as SC-1 `retrievals:` records, and
 * the vault notes they returned, as R-P2 `retrieved:` links.
 *
 * Each `mcp__rag__search_context` or `mcp__rag__get_document` call is paired
 * with its `tool_result` by id and parsed by `rag-result.mjs`, which reads only
 * identity and score fields. An error, an `is_error` result, a call with no
 * result and text the parser does not know are not retrievals and are skipped.
 *
 * Only the tool *input* is free text here, so the query and every string filter
 * go through `redact()` and then `redactLiterals()` with the secrets the session
 * showed elsewhere, the same two passes a prompt and the outcome get.
 *
 * Each note records its own transcript: the parent's searches on the parent
 * note, a worker's on the worker note. Folding workers into the parent, as
 * `files_modified` does, would count every worker search twice in
 * `rag.retrieval_events`.
 */

import { MAX_LABEL_CHARS, MAX_RETRIEVALS, MAX_RETRIEVED, SESSIONS_DIR } from './constants.mjs';
import { noteStem, sessionLink } from './links.mjs';
import { findNotesByName } from './notes-io.mjs';
import { parseRagResult } from './rag-result.mjs';
import { redact, redactLiterals } from './redact.mjs';

const TOOL_PREFIX = 'mcp__rag__';
const SEARCH_TOOL = 'search_context';
const DOCUMENT_TOOL = 'get_document';
const RAG_TOOLS = new Set([SEARCH_TOOL, DOCUMENT_TOOL]);
const TOOL_CHANNEL = 'tool';

const OBSIDIAN = 'obsidian';
const MARKDOWN_SUFFIX = '.md';

/** The server caps a query at 2 000 characters; a note keeps the first 500. */
const MAX_QUERY_CHARS = 500;

/** The search inputs that say what was asked for. `query` is its own field. */
const SEARCH_FILTER_KEYS = Object.freeze(['collection', 'source', 'limit', 'min_similarity', 'repo', 'phase', 'tags', 'include_superseded']);
const DOCUMENT_FILTER_KEYS = Object.freeze(['source', 'external_id']);

/** A character that would end or split a `[[target|label]]` link, or leave the line. */
const LINK_BREAKING = /[[\]|#^\r\n\t\\]/;
const LABEL_BREAKING = /[[\]|\r\n\t]+/g;

// ------------------------------------------------------------- extraction

/**
 * Every RAG retrieval in `entries`, in time order, capped at MAX_RETRIEVALS.
 *
 * @param {object[]} entries transcript entries, as `readEntries` returns them
 * @param {{secrets?: string[], includeSidechain?: boolean}} options literal secret
 *        values to remove from free text; `includeSidechain` for a worker's own
 *        transcript, which is all sidechain (inline worker turns in a main
 *        transcript belong to the worker's note)
 * @returns {{records: object[], hits: Array<{source: string, externalId: string, title: string}>}}
 *          `hits` are the documents returned, in record order, for `retrievedLinks`
 */
export function extractRetrievals(entries, { secrets = [], includeSidechain = false } = {}) {
  const calls = collectCalls(entries, includeSidechain);
  const found = [];
  for (const entry of entries ?? []) {
    for (const block of toolResultBlocks(entry)) {
      const call = calls.get(block.tool_use_id);
      if (!call || block.is_error === true) continue;
      const parsed = parseRagResult(call.tool, resultText(block.content));
      if (!parsed) continue;
      const at = isoOrEmpty(entry.timestamp) || call.at;
      if (!at) continue;
      found.push(toRetrieval({ call, parsed, at, secrets }));
    }
  }

  const ordered = found
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => Date.parse(a.record.at) - Date.parse(b.record.at) || a.index - b.index)
    .slice(0, MAX_RETRIEVALS);
  return {
    records: ordered.map((item) => item.record),
    hits: ordered.flatMap((item) => item.hits),
  };
}

/** tool_use id -> {tool, input, at} for every RAG call in the assistant turns. */
function collectCalls(entries, includeSidechain) {
  const calls = new Map();
  for (const entry of entries ?? []) {
    if (entry?.type !== 'assistant') continue;
    if (entry.isSidechain === true && !includeSidechain) continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
      const name = String(block.name ?? '');
      if (!name.startsWith(TOOL_PREFIX)) continue;
      const tool = name.slice(TOOL_PREFIX.length);
      if (!RAG_TOOLS.has(tool)) continue;
      const input = block.input && typeof block.input === 'object' ? block.input : {};
      calls.set(block.id, { tool, input, at: isoOrEmpty(entry.timestamp) });
    }
  }
  return calls;
}

function toolResultBlocks(entry) {
  const content = entry?.message?.content;
  if (entry?.type !== 'user' || !Array.isArray(content)) return [];
  return content.filter((block) => block?.type === 'tool_result' && typeof block.tool_use_id === 'string');
}

/** A tool result's text: a string, or the text blocks of a content list joined. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function isoOrEmpty(value) {
  if (typeof value !== 'string') return '';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function toRetrieval({ call, parsed, at, secrets }) {
  if (call.tool === SEARCH_TOOL) {
    const record = {
      at,
      channel: TOOL_CHANNEL,
      tool: SEARCH_TOOL,
      query: clean(call.input.query ?? parsed.query ?? '', secrets, MAX_QUERY_CHARS),
      filters: pickFilters(call.input, SEARCH_FILTER_KEYS, secrets),
      results: parsed.results.map((r) => withSimilarity(`${r.source}:${r.externalId}`, r.similarity)),
      chunks: parsed.results.map((r) => `${r.docId}/${r.chunkId}@${r.rrf}`),
    };
    // A partial parse may hold a block forged in chunk text: the record keeps
    // what was read, but nothing from it becomes a link in the graph.
    const hits = parsed.partial ? [] : parsed.results.map((r) => ({ source: r.source, externalId: r.externalId, title: r.title ?? '' }));
    return { record, hits };
  }

  const found = parsed.found !== false;
  const record = {
    at,
    channel: TOOL_CHANNEL,
    tool: DOCUMENT_TOOL,
    query: '',
    filters: pickFilters(call.input, DOCUMENT_FILTER_KEYS, secrets),
    results: found ? [`${parsed.source}:${parsed.externalId}`] : [],
    chunks: found ? [String(parsed.docId)] : [],
  };
  const hits = found ? [{ source: parsed.source, externalId: parsed.externalId, title: parsed.title ?? '' }] : [];
  return { record, hits };
}

function withSimilarity(ref, similarity) {
  return typeof similarity === 'number' && Number.isFinite(similarity) ? `${ref}@${similarity}` : ref;
}

/** The named inputs that are present and plain: strings redacted, numbers finite, lists of strings. */
function pickFilters(input, keys, secrets) {
  const filters = {};
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) filters[key] = clean(value, secrets, MAX_LABEL_CHARS);
    else if (typeof value === 'number' && Number.isFinite(value)) filters[key] = value;
    else if (typeof value === 'boolean') filters[key] = value;
    else if (Array.isArray(value)) {
      const items = value.filter((item) => typeof item === 'string' && item.trim()).map((item) => clean(item, secrets, MAX_LABEL_CHARS));
      if (items.length) filters[key] = items;
    }
  }
  return filters;
}

function clean(text, secrets, max) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return redact(redactLiterals(oneLine, secrets)).slice(0, max);
}

// ------------------------------------------------------------------ links

/**
 * `retrieved:` — quoted, path-qualified links to the distinct vault notes the
 * searches returned, first seen first, capped at MAX_RETRIEVED.
 *
 * A vault-path id links by its path. A session note's id (`session-<uuid>…`) is
 * looked up in the vault for its folder, and falls back to the short `[[<uuid>]]`
 * form, which still resolves because the stem is unique. Anything else, and any
 * id that could break out of the link or the vault, is left out.
 *
 * @param {Array<{source: string, externalId: string, title: string}>} hits
 * @param {{vaultRoot?: string, deadlineAt?: number}} options
 */
export function retrievedLinks(hits, { vaultRoot = '', deadlineAt = Number.POSITIVE_INFINITY } = {}) {
  const links = [];
  const seen = new Set();
  const seenIds = new Set();
  for (const hit of hits ?? []) {
    if (links.length >= MAX_RETRIEVED) break;
    if (hit?.source !== OBSIDIAN) continue;
    const externalId = String(hit.externalId ?? '');
    // By id before the lookup: a note returned by fifty searches is looked up once.
    if (seenIds.has(externalId)) continue;
    seenIds.add(externalId);
    const link = linkFor(externalId, hit.title, { vaultRoot, deadlineAt });
    if (!link || seen.has(link.target)) continue;
    seen.add(link.target);
    links.push(link.text);
  }
  return links;
}

function linkFor(externalId, title, { vaultRoot, deadlineAt }) {
  if (externalId.toLowerCase().endsWith(MARKDOWN_SUFFIX)) {
    if (!isSafeVaultPath(externalId)) return null;
    return linked(externalId.slice(0, -MARKDOWN_SUFFIX.length), title);
  }
  const stem = noteStem(externalId);
  if (!stem || stem === externalId) return null;
  const copy = vaultRoot && Date.now() <= deadlineAt ? findNotesByName(vaultRoot, `${stem}${MARKDOWN_SUFFIX}`)[0] : null;
  if (!copy) return { target: stem, text: sessionLink(externalId) };
  return linked(`${copy.area}/${copy.collection}/${SESSIONS_DIR}/${stem}`, title);
}

function linked(target, title) {
  const label = String(title ?? '').replace(LABEL_BREAKING, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS);
  return { target, text: label ? `[[${target}|${label}]]` : `[[${target}]]` };
}

/** Relative, forward slashes, no climbing, nothing that ends a link early. */
function isSafeVaultPath(value) {
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value) || LINK_BREAKING.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
