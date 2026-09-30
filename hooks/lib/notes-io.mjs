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

import { AREAS, HUB_NOTE_TYPE, LEGACY_HUB_FILENAME, SESSIONS_DIR } from './constants.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { hubFilename } from './links.mjs';
import { noteFilename } from './note.mjs';
import { isSafeFilenameSegment, yamlStr } from './text.mjs';

/** A resume chain longer than this is a bug, not a work pattern. */
export const MAX_RESUME_INDEX = 50;

/**
 * Read a note.
 *
 * A stub reads as absent, with `stub: true`: a file that is empty, holds only
 * whitespace, has no frontmatter block at all, or has an empty one. Obsidian
 * makes exactly that when a link to a note that does not exist yet is
 * followed — a worker's `up` link, clicked while the parent session is still
 * running — and it lands where the capture will write. Refusing to write over
 * it would lose the session's note to a click. A block that is there but
 * malformed is different: somebody typed it, so it is still an `error`.
 *
 * @returns {{fields: object|null, body: string, error: string, stub: boolean}}
 *          `fields: null` with an empty `error` means there is no note to
 *          merge into, which is the ordinary case for a first capture.
 */
export function readNote(notePath) {
  let raw;
  try {
    raw = fs.readFileSync(notePath, 'utf8');
  } catch {
    return { fields: null, body: '', error: '', stub: false }; // absent is not an error
  }
  const parsed = parseFrontmatter(raw);
  if (!parsed.ok) return { fields: null, body: '', error: parsed.error, stub: false };
  if (Object.keys(parsed.fields).length === 0) return { fields: null, body: '', error: '', stub: true };
  return { fields: parsed.fields, body: parsed.body.replace(/^\n+/, ''), error: '', stub: false };
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
 * The text goes to a temporary file in the same folder, which is then renamed
 * over the note (R-100, H-10). The hook never waits for a realm's lock — it
 * must not block session exit — so the nightly sync may be staging this very
 * folder; a rename means it reads the old note or the new one, never half of
 * one. The temporary name starts with a dot and does not end `.md`, so neither
 * Obsidian, the sweep's index nor a realm's sync paths take it for a note.
 *
 * @returns {{ok: boolean, changed: boolean, error: string}}
 */
export function persist(notePath, text) {
  try {
    if (isIdentical(notePath, text)) return { ok: true, changed: false, error: '' };
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    writeByRename(notePath, text);
    return { ok: true, changed: true, error: '' };
  } catch (err) {
    return { ok: false, changed: false, error: err?.code || err?.message || 'unknown' };
  }
}

/**
 * On Windows a rename onto a file another process has open (the sync's `git
 * add`, an indexer, antivirus, Obsidian) fails with one of these while the
 * handle is open. The rename is retried after each of these waits, 230 ms at
 * most, paid only when something is in the way and well inside the hook's
 * budget. Past that the write fails and says so; it is never done in place,
 * because a half-written note is exactly what a concurrent stage must not see.
 * The old note stays whole: a note that was never created is a candidate for
 * the next sweep, and a merge that did not land is redone by the next capture.
 */
const TRANSIENT_RENAME_CODES = Object.freeze(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS = Object.freeze([10, 20, 40, 80, 80]);

function writeByRename(notePath, text) {
  const temp = path.join(path.dirname(notePath), `.${path.basename(notePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' });
    renameWithRetry(temp, notePath);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* the write's own error is the one worth reporting; a stray .tmp is not a note */
    }
    throw err;
  }
}

function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const transient = TRANSIENT_RENAME_CODES.includes(err?.code) && !isDirectory(to);
      if (!transient || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function isDirectory(file) {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
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
 * Every copy of a note with this filename, in any collection.
 *
 * A worker note's filename is unique across the vault — it is the session id
 * and the agent id — so finding it anywhere means it exists, and more than one
 * entry is a duplicate somebody should hear about. One `stat` per collection
 * folder, never a listing of every `sessions/` directory. Collections come
 * back in sorted order, so the first copy is always the same one.
 *
 * @returns {Array<{notePath: string, area: string, collection: string}>}
 */
export function findNotesByName(vaultRoot, filename) {
  // One path segment, or nothing: a name with a separator in it could reach
  // outside the collection folders it is meant to be looked for in.
  const name = String(filename ?? '');
  if (!vaultRoot || !name || name.startsWith('.') || /[\\/]/.test(name)) return [];
  return AREAS.flatMap((area) =>
    listFolder(path.join(vaultRoot, area))
      .map((collection) => ({ notePath: path.join(vaultRoot, area, collection, SESSIONS_DIR, name), area, collection }))
      .filter((copy) => isFile(copy.notePath)),
  );
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
 * The body `ensureIndex` gives a hub it creates. move-to-realm compares a hub
 * against it to tell a stub nobody has written in from a hub worth keeping.
 */
export function hubStubBody(collection) {
  return ['', `# ${collection}`, '', `Collection \`${collection}\`. Session notes under \`sessions/\` link up to this note.`, ''].join('\n');
}

/**
 * Make sure the collection's hub note, `<area>/<collection>/<collection>.md`,
 * exists. Never throws, never overwrites.
 *
 * Every session note links `up` to this note, and a collection the hook creates
 * on demand does not have one. The body carries no links on purpose: a hub is
 * ingested like any other note, and a list of links would be embedded as text.
 * The `wx` flag is what makes "never overwrites" true even when two hooks
 * finish at once.
 *
 * @returns {{ok: boolean, created: boolean, path: string, error: string}}
 */
export function ensureIndex(vaultRoot, area, collection) {
  if (!vaultRoot || !AREAS.includes(area) || !isSafeFilenameSegment(collection)) {
    return { ok: false, created: false, path: '', error: 'not a collection folder' };
  }
  const hubPath = path.join(vaultRoot, area, collection, hubFilename(collection));
  // The ordinary case, answered with one stat. `wx` below is for the race.
  if (fs.existsSync(hubPath)) return { ok: true, created: false, path: hubPath, error: '' };
  // Transitional, and retires once `rename-hubs.mjs --apply` has run on the
  // live vault: until then a collection's hub is still `index.md`, and writing
  // `<collection>.md` beside it would make two `type: index` notes. The new
  // notes' `up` links already name `<collection>`, and resolve after the rename.
  const legacyPath = path.join(vaultRoot, area, collection, LEGACY_HUB_FILENAME);
  if (fs.existsSync(legacyPath)) return { ok: true, created: false, path: legacyPath, error: '' };
  const text = [
    '---',
    `id: ${yamlStr(randomUUID())}`,
    `title: ${yamlStr(collection)}`,
    `collection: ${yamlStr(collection)}`,
    `type: ${HUB_NOTE_TYPE}`,
    '---',
    hubStubBody(collection),
  ].join('\n');
  try {
    fs.mkdirSync(path.dirname(hubPath), { recursive: true });
    fs.writeFileSync(hubPath, text, { encoding: 'utf8', flag: 'wx' });
    return { ok: true, created: true, path: hubPath, error: '' };
  } catch (err) {
    if (err?.code === 'EEXIST') return { ok: true, created: false, path: hubPath, error: '' };
    return { ok: false, created: false, path: hubPath, error: err?.code || err?.message || 'unknown' };
  }
}
