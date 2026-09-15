/**
 * The one-time migration of session notes written by hook 1.0.0 (R-27.1).
 *
 * Three things are wrong with those notes and this fixes all three:
 *   - they are filed by **folder**, so `bb2dash-retrieval` and `bb2dash-wt-sl`
 *     are separate "projects" from `bb2dash`;
 *   - they are named `<date>-<id8>.md`, a key that changes when a session is
 *     resumed, which strands the old row;
 *   - they carry no relational context at all.
 *
 * Deciding the new collection, in order:
 *   1. resolve the note's `cwd` against git, exactly as the hook now does;
 *   2. an explicit path override, for a checkout that no longer exists;
 *   3. keep the folder the note is already in.
 *
 * Step 2 is a table someone typed, not a heuristic. `bb2dash-retrieval` is not
 * on disk any more, so nothing can resolve it — and inferring it from the name
 * would be a rule that silently mis-files the next similarly-named folder.
 *
 * The body is rewritten too, but only its `## Session facts` table. That is
 * deliberate: `ingest` hashes the body, so a note whose frontmatter changed and
 * whose body did not would keep its old metadata in the store forever.
 */

import path from 'node:path';

import {
  AREA_CLASSES,
  AREA_PROJECTS,
  COLLECTION_FROM_FOLDER,
  COLLECTION_FROM_GIT,
  GENERATOR_VERSION,
  MAX_DOCS_TOUCHED,
  MAX_FILES_LISTED,
  MAX_MEMORY_FILES,
  MAX_REPOS_TOUCHED,
  SCHEMA_VERSION,
  STATUS_CONCLUDED,
} from './constants.mjs';
import { classifyPaths } from './paths.mjs';
import { classify } from './tags.mjs';
import { noteFilename, noteId, renderFacts } from './note.mjs';
import { uniqueCapped } from './text.mjs';

/**
 * Checkouts that no longer exist, and the collection their notes belong to.
 * Every entry is a decision someone made; nothing is inferred from the name.
 */
export const COLLECTION_OVERRIDES = Object.freeze({
  // Phase 7 retrieval work happened in a checkout that has since been removed.
  'bb2dash-retrieval': 'bb2dash',
  // A worktree of emstacho-su/bb2dash, filed as its own project by hook 1.0.0.
  'bb2dash-wt-sl': 'bb2dash',
});

/** Folders the migration empties and then removes, once nothing is left. */
export const RETIRED_FOLDERS = Object.freeze(Object.keys(COLLECTION_OVERRIDES));

const FACTS_HEADING = /^##\s+Session facts\s*$/m;

/**
 * Decide where one note goes and what its collection becomes.
 *
 * @param {object} args
 * @param {object} args.note        `{ area, collection, name, fields }`
 * @param {function} args.resolveRepoFor  cwd -> repo, injected for testability
 * @returns {{area: string, collection: string, collectionSource: string,
 *            repoFullName: string, filename: string, decidedBy: string}}
 */
export function planNote({ note, resolveRepoFor, overrides = COLLECTION_OVERRIDES }) {
  const sessionId = String(note.fields.session_id ?? '').trim();
  const filename = sessionId ? noteFilename(sessionId) : note.name;

  const repo = resolveRepoFor(String(note.fields.cwd ?? ''));
  if (repo?.repoSlug) {
    return {
      area: AREA_PROJECTS,
      collection: repo.repoSlug,
      collectionSource: COLLECTION_FROM_GIT,
      repoFullName: repo.repoFullName,
      filename,
      decidedBy: 'git remote of the recorded cwd',
    };
  }

  const override = overrides[note.collection];
  if (override) {
    return {
      area: AREA_PROJECTS,
      collection: override,
      collectionSource: COLLECTION_FROM_FOLDER,
      repoFullName: '',
      filename,
      decidedBy: `override table (${note.collection} -> ${override})`,
    };
  }

  return {
    area: note.area === AREA_CLASSES ? AREA_CLASSES : AREA_PROJECTS,
    collection: note.collection,
    collectionSource: COLLECTION_FROM_FOLDER,
    repoFullName: '',
    filename,
    decidedBy: 'kept: the cwd no longer resolves and no override covers it',
  };
}

/**
 * Rewrite a v1 note as schema v2.
 *
 * @param {object} args
 * @param {object} args.note      the parsed note
 * @param {object} args.plan      from `planNote`
 * @param {object} args.backfill  `{ commits, prs, branch }`, possibly all empty
 * @param {function} args.repoFor from `makeRepoResolver()`
 * @returns {{fields: object, body: string, emptied: string[]}}
 */
export function migrateNote({ note, plan, backfill, repoFor }) {
  const old = note.fields;
  const sessionId = String(old.session_id ?? '').trim();
  const rawFiles = asList(old.files_modified).map((file) => [String(file), 1]);

  const paths = classifyPaths(rawFiles, {
    repoFor,
    maxFiles: MAX_FILES_LISTED,
    maxDocs: MAX_DOCS_TOUCHED,
    maxMemory: MAX_MEMORY_FILES,
    maxRepos: MAX_REPOS_TOUCHED,
  });

  const branch = backfill.branch || '';
  const { tags, phase } = classify({
    files: paths.files,
    docsTouched: paths.docsTouched,
    branch,
  });

  const endedAt = String(old.ended_at ?? '');
  const repoFullName = plan.repoFullName || repoFullNameOf(old, repoFor);

  const fields = {
    id: noteId(sessionId),
    title: String(old.title ?? `Session ${old.date} — ${plan.collection}`).replace(
      / — .*$/,
      ` — ${plan.collection}`,
    ),
    type: 'session',
    schema_version: SCHEMA_VERSION,
    collection: plan.collection,
    collection_source: plan.collectionSource,
    session_id: sessionId,
    date: String(old.date ?? ''),
    started_at: String(old.started_at ?? ''),
    ended_at: endedAt,
    duration_minutes: Number(old.duration_minutes ?? 0),
    // Every migrated note is historical: it ended, and nothing has resumed it.
    status: STATUS_CONCLUDED,
    concluded_at: endedAt,
    end_reason: String(old.end_reason ?? 'other'),
    repo: repoFullName,
    branch,
    worktree: worktreeOf(old),
    repos_touched: paths.reposTouched,
    cwd: String(old.cwd ?? ''),
    cwds_seen: uniqueCapped(asList(old.cwds_seen).map(String), 20),
    phase,
    tags,
    supersedes: [],
    resumed_from: '',
    // Not derivable after the fact: nothing in a v1 note records either.
    parent_session: '',
    child_sessions: [],
    commits: backfill.commits ?? [],
    prs: backfill.prs ?? [],
    memory_files: paths.memoryFiles,
    plan_file: paths.planFile,
    docs_touched: paths.docsTouched,
    artifacts: [],
    files_modified: paths.files.map((file) => file.path),
    prompt_count: Number(old.prompt_count ?? 0),
    command_count: Number(old.command_count ?? 0),
    agent: String(old.agent ?? 'claude-code'),
    generator: `session-capture.mjs ${GENERATOR_VERSION} (migrated)`,
    tools_used: old.tools_used && typeof old.tools_used === 'object' ? old.tools_used : {},
  };

  const emptied = ['branch', 'commits', 'prs', 'phase', 'parent_session', 'child_sessions', 'artifacts'].filter(
    (name) => isEmpty(fields[name]),
  );

  return { fields, body: rewriteBody(note.body, fields), emptied };
}

/** Replace the v1 facts table; leave the prompts, files and commands alone. */
export function rewriteBody(body, fields) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const match = text.match(FACTS_HEADING);
  const head = match ? text.slice(0, match.index) : `${text.replace(/\s+$/, '')}\n\n`;
  return `${head.replace(/\n+$/, '\n\n')}${renderFacts(fields, {
    transcriptPath: '',
    subagentFilesRead: 0,
  }).join('\n')}`;
}

function repoFullNameOf(old, repoFor) {
  const cwd = String(old.cwd ?? '');
  if (!cwd) return '';
  const repo = repoFor(path.join(cwd, 'x'));
  return repo?.repoFullName ?? '';
}

/**
 * A v1 `cwd` ending in `<repo>-wt-<name>` is a worktree. This reads the folder
 * name and nothing else — the checkout may be long gone, and a folder name is
 * the only evidence left.
 */
function worktreeOf(old) {
  const cwd = String(old.cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const base = cwd.split('/').pop() ?? '';
  return /-wt(-|$)/.test(base) ? base : '';
}

function isEmpty(value) {
  if (Array.isArray(value)) return value.length === 0;
  return value === '' || value === undefined || value === null;
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}
