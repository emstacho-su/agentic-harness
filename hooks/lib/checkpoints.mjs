/**
 * Collecting `/checkpoint` notes out of git and into the vault.
 *
 * A cloud session cannot reach this machine, so the skill leaves its note in
 * the repository under `.harness/sessions/` and pushes. This module fetches,
 * reads every such note off every branch, and files the ones that pass
 * validation into the vault, where the ingest picks them up like any other
 * session note.
 *
 * Everything read here is model-written text that arrived through git: it is
 * untrusted. The same allow-lists the hook applies (session id as a filename
 * segment, frontmatter keys, collection slug) apply again on this side, the
 * body goes through `redact()`, and the collection is mapped onto folders the
 * vault already has rather than folders the note asks for.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  AREA_CLASSES,
  AREA_PROJECTS,
  CAPTURED_BY_SKILL,
  CHECKPOINT_FETCH_TIMEOUT_MS,
  CHECKPOINT_GIT_TIMEOUT_MS,
  CHECKPOINT_NOTES_DIR,
  SCHEMA_VERSION,
  STATUS_CONCLUDED,
} from './constants.mjs';
import { FIELD_SPEC, parseFrontmatter } from './frontmatter.mjs';
import { runGitSync } from './git-log.mjs';
import { withLinks } from './links.mjs';
import { renderNote } from './note.mjs';
import { ensureIndex, persist, readNote, vaultAvailable } from './notes-io.mjs';
import { redact } from './redact.mjs';
import { isSafeFilenameSegment, slugify, toPosix } from './text.mjs';

const FALLBACK_COLLECTION = 'misc';
const UNCLASSIFIED = 'unclassified';
const ID_PREFIX = 'session-';
const MAX_NOTE_BYTES = 256 * 1024;

// ------------------------------------------------------------------- git

/**
 * Every branch that could carry a note: the remote's and this checkout's own.
 * Full ref names, so `refs/remotes/origin/HEAD` (a symref to the default
 * branch, which `%(refname:short)` would render as just `origin`) can be
 * dropped by name and every other ref is passed to git unambiguously.
 */
export function listRefs(repoRoot, runGit = runGitSync) {
  const result = runGit(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin', 'refs/heads'], {
    cwd: repoRoot,
    timeoutMs: CHECKPOINT_GIT_TIMEOUT_MS,
  });
  if (!result.ok) return { ok: false, error: result.error, refs: [] };
  return {
    ok: true,
    refs: result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((ref) => ref.startsWith('refs/') && ref !== 'refs/remotes/origin/HEAD'),
  };
}

/** The note paths under `.harness/sessions/` on one ref. */
export function listNotesOnRef(repoRoot, ref, runGit = runGitSync) {
  const result = runGit(['ls-tree', '-r', '--name-only', ref, '--', CHECKPOINT_NOTES_DIR], {
    cwd: repoRoot,
    timeoutMs: CHECKPOINT_GIT_TIMEOUT_MS,
  });
  if (!result.ok) return { ok: false, error: result.error, files: [] };
  return {
    ok: true,
    files: result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((file) => file.endsWith('.md') && toPosix(file).startsWith(`${CHECKPOINT_NOTES_DIR}/`)),
  };
}

export function readNoteOnRef(repoRoot, ref, file, runGit = runGitSync) {
  const result = runGit(['show', `${ref}:${file}`], { cwd: repoRoot, timeoutMs: CHECKPOINT_GIT_TIMEOUT_MS });
  return result.ok ? { ok: true, text: result.stdout } : { ok: false, error: result.error, text: '' };
}

/** The author email of the commit that last touched the note on that ref, or `''`. */
export function noteAuthorOnRef(repoRoot, ref, file, runGit = runGitSync) {
  const result = runGit(['log', '-1', '--format=%ae', ref, '--', file], { cwd: repoRoot, timeoutMs: CHECKPOINT_GIT_TIMEOUT_MS });
  return result.ok ? result.stdout.trim().toLowerCase() : '';
}

/**
 * Every distinct note in a repository, keyed by filename. The same note on
 * several refs is one note: it was written once and merged along.
 *
 * A git call that fails is an `error`, logged and counted, never a silent gap:
 * a nightly log that says "clean" while a note went uncollected is the one
 * outcome this must not produce.
 */
export function gatherNotes({ repoRoot, runGit = runGitSync, fetch = true, log = () => {} }) {
  const fetched = fetch
    ? runGit(['fetch', 'origin', '--prune', '--quiet'], { cwd: repoRoot, timeoutMs: CHECKPOINT_FETCH_TIMEOUT_MS })
    : { ok: true };
  if (!fetched.ok) log(`fetch failed for ${repoRoot}: ${fetched.error}; reading what is already here`);

  let errors = 0;
  const listed = listRefs(repoRoot, runGit);
  if (!listed.ok) {
    errors += 1;
    log(`error listing refs in ${repoRoot}: ${listed.error}`);
  }

  const notes = new Map();
  for (const ref of listed.refs) {
    const files = listNotesOnRef(repoRoot, ref, runGit);
    if (!files.ok) {
      errors += 1;
      log(`error listing ${CHECKPOINT_NOTES_DIR} on ${ref} in ${repoRoot}: ${files.error}`);
      continue;
    }
    for (const file of files.files) {
      const key = path.basename(file);
      if (notes.has(key)) continue;
      const read = readNoteOnRef(repoRoot, ref, file, runGit);
      if (!read.ok) {
        errors += 1;
        log(`error reading ${file} on ${ref} in ${repoRoot}: ${read.error}`);
        continue;
      }
      notes.set(key, { file, ref, text: read.text, author: noteAuthorOnRef(repoRoot, ref, file, runGit) });
    }
  }
  return { refs: listed.refs.length, fetched: fetched.ok, errors, notes: [...notes.values()] };
}

// ------------------------------------------------------------ validation

/**
 * Parse and check one note. Returns `{ ok, fields, body }` or `{ ok: false, reason }`.
 * Refusals are specific so the log says what was wrong with the note, and
 * nothing in a refused note reaches the vault.
 */
export function validateNote(text) {
  if (Buffer.byteLength(String(text ?? ''), 'utf8') > MAX_NOTE_BYTES) return { ok: false, reason: 'note is larger than 256 KiB' };

  const parsed = parseFrontmatter(text);
  if (!parsed.ok) return { ok: false, reason: `frontmatter: ${parsed.error}` };
  const fields = parsed.fields ?? {};
  if (Object.keys(fields).length === 0) return { ok: false, reason: 'no frontmatter' };

  if (fields.type !== 'session') return { ok: false, reason: `type is ${JSON.stringify(fields.type)}, not session` };
  if (fields.captured_by !== CAPTURED_BY_SKILL) return { ok: false, reason: `captured_by is ${JSON.stringify(fields.captured_by)}, not ${CAPTURED_BY_SKILL}` };

  const sessionId = String(fields.session_id ?? '');
  if (!isSafeFilenameSegment(sessionId)) return { ok: false, reason: 'session_id is not a safe filename segment' };
  if (fields.id !== `${ID_PREFIX}${sessionId}`) return { ok: false, reason: 'id does not match session-<session_id>' };

  const collection = slugify(fields.collection);
  if (!collection) return { ok: false, reason: 'collection is empty' };

  const body = redact(String(parsed.body ?? '')).trim();
  if (!body) return { ok: false, reason: 'body is empty' };

  return { ok: true, fields: normalizeFields({ ...fields, session_id: sessionId, collection }), body };
}

/**
 * Only the schema-v2 fields, every one present, and the ones a note may not
 * decide for itself pinned. A hand-built note (the skill's no-node fallback)
 * can omit half the fields or carry `status: superseded`; the vault must see
 * the same shape from every note, and a status ratchet must not be triggered
 * by text that arrived through git.
 */
export function normalizeFields(fields) {
  const out = {};
  for (const [key, kind] of FIELD_SPEC) {
    const value = fields[key];
    if (kind === 'list' || kind === 'numlist') out[key] = Array.isArray(value) ? value : [];
    else if (kind === 'map') out[key] = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    else if (kind === 'plain') out[key] = value ?? (key === 'date' ? '' : 0);
    else out[key] = typeof value === 'string' ? value : value == null ? '' : String(value);
  }
  return {
    ...out,
    type: 'session',
    schema_version: SCHEMA_VERSION,
    status: STATUS_CONCLUDED,
    supersedes: [],
    resumed_from: '',
    captured_by: CAPTURED_BY_SKILL,
    agent: 'claude-code',
  };
}

/**
 * Where a note goes. A class must already have a folder (an argument that
 * names nothing becomes `misc`, and the log says so); a project folder is
 * created on demand, exactly as the hook does for a session's own repository.
 */
export function resolvePlacement(vaultRoot, fields) {
  const slug = fields.collection;
  if (folderExists(vaultRoot, AREA_CLASSES, slug)) return { area: AREA_CLASSES, collection: slug, reason: '' };
  if (folderExists(vaultRoot, AREA_PROJECTS, slug)) return { area: AREA_PROJECTS, collection: slug, reason: '' };
  if (fields.collection_source === 'git') return { area: AREA_PROJECTS, collection: slug, reason: '' };
  return {
    area: AREA_PROJECTS,
    collection: FALLBACK_COLLECTION,
    reason: `collection ${JSON.stringify(slug)} names no vault folder; filed under ${FALLBACK_COLLECTION}`,
  };
}

function folderExists(vaultRoot, area, slug) {
  try {
    return fs.statSync(path.join(vaultRoot, area, slug)).isDirectory();
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- filing

/**
 * File one validated note. **Written once, never merged.** A checkpoint is
 * produced once by the session that ran it, so the first copy collected is
 * the note; a later copy under the same id is refused and logged, and an id
 * that already belongs to a hook- or sweep-written note is refused outright.
 * Nothing that arrives through git can therefore alter a note the vault
 * already holds: a forged branch can at worst add a new note, and that note
 * says `captured_by: skill` and came through `redact()`.
 */
export function fileNote({ vaultRoot, fields, body, dryRun = false }) {
  const placement = resolvePlacement(vaultRoot, fields);
  const sessionsDir = path.join(vaultRoot, placement.area, placement.collection, 'sessions');
  const notePath = path.join(sessionsDir, `${fields.session_id}.md`);
  const relative = `${placement.area}/${placement.collection}/sessions/${fields.session_id}.md`;

  // Links are derived here, from the placement, and never taken from the note:
  // whatever `up` or `related` arrived through git is overwritten.
  const incoming = withLinks(
    {
      ...fields,
      collection: placement.collection,
      tags: Array.isArray(fields.tags) && fields.tags.length ? fields.tags : [UNCLASSIFIED],
    },
    placement.area,
  );

  const current = readNote(notePath);
  if (current.error) return { action: 'skip', reason: `existing note unreadable: ${current.error}`, notePath: relative, placement };
  if (current.fields) {
    if (current.fields.captured_by !== CAPTURED_BY_SKILL) {
      return { action: 'skip', reason: 'id already belongs to a note the hook or the sweep wrote', notePath: relative, placement };
    }
    return { action: 'noop', reason: 'already collected; a checkpoint is never merged', notePath: relative, placement };
  }

  if (dryRun) return { action: 'create', reason: placement.reason, notePath: relative, placement, dryRun: true };

  const result = persist(notePath, renderNote(incoming, body));
  if (!result.ok) return { action: 'skip', reason: `write failed (${result.error})`, notePath: relative, placement };
  ensureIndex(vaultRoot, placement.area, placement.collection);
  return { action: 'create', reason: placement.reason, notePath: relative, placement, touched: notePath };
}

// ------------------------------------------------------------------- run

/**
 * The whole collection: every repo, every ref, every note, into the vault.
 * Repos that are missing are reported and skipped; nothing here throws for
 * one repo's sake.
 */
export function runCollect({ repos, vaultRoot, dryRun = false, fetch = true, authors = [], runGit = runGitSync, log = () => {} }) {
  if (!vaultAvailable(vaultRoot)) throw new Error(`vaultRoot is not available: ${vaultRoot}`);
  const allowedAuthors = new Set(authors.map((email) => String(email).trim().toLowerCase()).filter(Boolean));

  const summary = { repos: [], found: 0, created: 0, merged: 0, unchanged: 0, skipped: 0, errors: 0, touchedPaths: [], results: [] };

  for (const repoRoot of repos) {
    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
      log(`skip repo ${repoRoot}: not a git repository`);
      summary.repos.push({ repoRoot, status: 'missing', notes: 0 });
      continue;
    }

    const gathered = gatherNotes({ repoRoot, runGit, fetch, log });
    const status = !gathered.fetched ? 'fetch-failed' : gathered.errors > 0 ? 'git-errors' : 'ok';
    summary.repos.push({ repoRoot, status, refs: gathered.refs, notes: gathered.notes.length, errors: gathered.errors });
    summary.errors += gathered.errors;
    summary.found += gathered.notes.length;

    for (const note of gathered.notes) {
      // Provenance, when an allow-list was given: the commit's author email.
      // Without one the trust boundary is "anyone who can push to this repo",
      // and the log still records who that was.
      if (allowedAuthors.size && !allowedAuthors.has(note.author)) {
        summary.skipped += 1;
        const reason = `author ${JSON.stringify(note.author)} is not in the allow-list`;
        summary.results.push({ repoRoot, file: note.file, ref: note.ref, action: 'skip', reason });
        log(`skip ${note.file} (${note.ref}): ${reason}`);
        continue;
      }

      const checked = validateNote(note.text);
      if (!checked.ok) {
        summary.skipped += 1;
        summary.results.push({ repoRoot, file: note.file, ref: note.ref, action: 'skip', reason: checked.reason });
        log(`skip ${note.file} (${note.ref}): ${checked.reason}`);
        continue;
      }

      const filed = fileNote({ vaultRoot, fields: checked.fields, body: checked.body, dryRun });
      summary.results.push({ repoRoot, file: note.file, ref: note.ref, ...filed });
      if (filed.action === 'create') summary.created += 1;
      else if (filed.action === 'merge') summary.merged += 1;
      else if (filed.action === 'noop') summary.unchanged += 1;
      else summary.skipped += 1;
      if (filed.touched) summary.touchedPaths.push(filed.touched);
      log(`${filed.action} ${filed.notePath}${filed.reason ? ` (${filed.reason})` : ''} from ${note.ref} by ${note.author || 'unknown author'}`);
    }
  }

  return summary;
}
