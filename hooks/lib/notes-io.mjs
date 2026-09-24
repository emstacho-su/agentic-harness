/**
 * Reading and writing note files.
 *
 * Small on purpose: two callers need exactly these few operations, and both of
 * them care about the same rule — a note the parser cannot read is a note
 * somebody hand-edited, and the only safe response is to leave it alone.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AREAS, INDEX_FILENAME } from './constants.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { noteFilename } from './note.mjs';
import { isSafeFilenameSegment, yamlStr } from './text.mjs';

/** A resume chain longer than this is a bug, not a work pattern. */
export const MAX_RESUME_INDEX = 50;

/** The folder inside every collection that holds its session and worker notes. */
export const SESSIONS_FOLDER = 'sessions';

/**
 * Read a note.
 *
 * @returns {{fields: object|null, body: string, error: string}} — `fields: null`
 *          with an empty `error` means the note is simply not there, which is
 *          the ordinary case for a first capture.
 */
export function readNote(notePath) {
  let raw;
  try {
    raw = fs.readFileSync(notePath, 'utf8');
  } catch {
    return { fields: null, body: '', error: '' }; // absent is not an error
  }
  const parsed = parseFrontmatter(raw);
  if (!parsed.ok) return { fields: null, body: '', error: parsed.error };
  if (Object.keys(parsed.fields).length === 0) return { fields: null, body: '', error: 'no frontmatter' };
  return { fields: parsed.fields, body: parsed.body.replace(/^\n+/, ''), error: '' };
}

/**
 * Write a note, creating its directory. Never throws.
 *
 * A write whose text is byte-identical to what is already on disk is skipped
 * and reported as `changed: false`. `SubagentStop` fires every time a worker
 * stops, which for a multi-turn worker is many times per session, and each
 * capture re-renders the same note; a rewrite that changes nothing still costs
 * a detached ingest process that loads a 130 MB embedding model to conclude the
 * hash is unchanged. One small read is much cheaper than that.
 *
 * @returns {{ok: boolean, changed: boolean, error: string}}
 */
export function persist(notePath, text) {
  try {
    if (isIdentical(notePath, text)) return { ok: true, changed: false, error: '' };
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, text, 'utf8');
    return { ok: true, changed: true, error: '' };
  } catch (err) {
    return { ok: false, changed: false, error: err?.code || err?.message || 'unknown' };
  }
}

/** Is that exact text already the file's contents? An absent file is not. */
function isIdentical(notePath, text) {
  try {
    return fs.readFileSync(notePath, 'utf8') === text;
  } catch {
    return false;
  }
}

/**
 * Is the vault somewhere we may write?
 *
 * Auto-create inside an existing parent only. If OneDrive is unmounted the
 * parent is gone too, and inventing a vault on the wrong drive is worse than
 * skipping one session.
 */
export function vaultAvailable(vaultRoot) {
  if (!vaultRoot) return false;
  return fs.existsSync(vaultRoot) || fs.existsSync(path.dirname(vaultRoot));
}

/**
 * Where a note with this filename is already filed, in any collection.
 *
 * A worker note's filename is unique across the vault — it is the session id
 * and the agent id — so finding it anywhere means it exists, and writing a
 * second one elsewhere is a duplicate. One `stat` per collection folder, never
 * a listing of every `sessions/` directory. Collections are searched in sorted
 * order, so a name that is somehow filed twice always resolves to the same one.
 *
 * @returns {{notePath: string, area: string, collection: string} | null}
 */
export function findNoteByName(vaultRoot, filename) {
  // One path segment, or nothing: a name with a separator in it could reach
  // outside the collection folders it is meant to be looked for in.
  const name = String(filename ?? '');
  if (!vaultRoot || !name || name.startsWith('.') || /[\\/]/.test(name)) return null;
  for (const area of AREAS) {
    for (const collection of listFolder(path.join(vaultRoot, area))) {
      const notePath = path.join(vaultRoot, area, collection, SESSIONS_FOLDER, name);
      if (isFile(notePath)) return { notePath, area, collection };
    }
  }
  return null;
}

function listFolder(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The head of a session's resume chain: the highest `-rN` note that exists.
 *
 * Every write has to start from the head, not from `<id>.md`. Reading the base
 * note once an `-r2` exists means planning against a note that was superseded
 * days ago — which reads as "settled, but with new activity" on every single
 * `SessionEnd` afterwards, and mints `-r3`, `-r4`, `-r5` as duplicates of each
 * other until the chain limit stops it.
 *
 * @returns {{index: number, path: string, nextIndex: number}} `index` 1 means
 *          the base note; `nextIndex` 0 means the chain is implausibly long.
 */
export function resolveChainHead(sessionsDir, sessionId) {
  let index = 1;
  for (let candidate = 2; candidate <= MAX_RESUME_INDEX; candidate += 1) {
    if (!fs.existsSync(path.join(sessionsDir, noteFilename(sessionId, candidate)))) break;
    index = candidate;
  }
  return {
    index,
    path: path.join(sessionsDir, noteFilename(sessionId, index)),
    nextIndex: index < MAX_RESUME_INDEX ? index + 1 : 0,
  };
}

/**
 * Make sure `<area>/<collection>/index.md` exists. Never throws, never
 * overwrites.
 *
 * Every session note links `up` to this note, and a collection the hook creates
 * on demand does not have one. The body carries no links on purpose: an index
 * is ingested like any other note, and a list of links would be embedded as
 * text. The `wx` flag is what makes "never overwrites" true even when two hooks
 * finish at once.
 *
 * @returns {{ok: boolean, created: boolean, path: string, error: string}}
 */
export function ensureIndex(vaultRoot, area, collection) {
  if (!vaultRoot || !AREAS.includes(area) || !isSafeFilenameSegment(collection)) {
    return { ok: false, created: false, path: '', error: 'not a collection folder' };
  }
  const indexPath = path.join(vaultRoot, area, collection, INDEX_FILENAME);
  // The ordinary case, answered with one stat. `wx` below is for the race.
  if (fs.existsSync(indexPath)) return { ok: true, created: false, path: indexPath, error: '' };
  const text = [
    '---',
    `id: ${yamlStr(randomUUID())}`,
    `title: ${yamlStr(collection)}`,
    `collection: ${yamlStr(collection)}`,
    'type: index',
    '---',
    '',
    `# ${collection}`,
    '',
    `Collection \`${collection}\`. Session notes under \`sessions/\` link up to this note.`,
    '',
  ].join('\n');
  try {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, text, { encoding: 'utf8', flag: 'wx' });
    return { ok: true, created: true, path: indexPath, error: '' };
  } catch (err) {
    if (err?.code === 'EEXIST') return { ok: true, created: false, path: indexPath, error: '' };
    return { ok: false, created: false, path: indexPath, error: err?.code || err?.message || 'unknown' };
  }
}
