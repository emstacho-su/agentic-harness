/**
 * Carrying out a move-to-realm plan (R-H3), under both realm locks.
 *
 * The locks are the ones the nightly sync and the checkpoint collector take, so
 * neither can commit a realm halfway through the move: the harness realm with
 * the copies while projects still holds the sources (one `id` from two paths),
 * or projects with the deletions before harness has the copies. A realm that is
 * not a git checkout has no lock and nothing that could commit it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AREAS } from './constants.mjs';
import { hubFilename } from './links.mjs';
import { describeError, SOURCE_AREA, SOURCE_COLLECTIONS, TOUCHED_REALMS } from './move-to-realm.mjs';
import { ensureIndex } from './notes-io.mjs';
import { acquireRealmLock, describeHolder, lockPathFor, releaseRealmLock } from './realm-lock.mjs';
import { realmRootFor } from './realm-sync.mjs';

const LOCK_OWNER = 'move-to-realm';
const CHANGED = 'changed since the plan; run --dry-run again';

/** The production locks: `acquire(realm)` -> `{ok, lock}` or `{ok: false, error}`; `release(lock)` -> `{ok, error?}`. */
export function realmLocks(vault) {
  return {
    acquire(realm) {
      const root = realmRootFor(vault, realm);
      if (!root || !lockPathFor(root)) return { ok: true, lock: null };
      const got = acquireRealmLock(root, { owner: LOCK_OWNER });
      if (got.ok) return { ok: true, lock: { lockPath: got.lockPath, token: got.token } };
      const why = got.reason === 'held' ? `held by ${describeHolder(got.holder)}` : got.error;
      return { ok: false, error: `the ${realm} realm lock: ${why}` };
    },
    release(lock) {
      return lock ? releaseRealmLock(lock) : { ok: true };
    },
  };
}

function removeEmptyDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name));
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // Left in place: an empty folder is harmless, and nothing in it needs a person.
  }
}

/** Copy `from` to `to` (never over an existing file), then remove `from`. */
function archiveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  fs.unlinkSync(from);
}

function writeTarget(vault, move) {
  const target = path.join(vault, move.to);
  if (move.replacesStub) archiveFile(target, move.stubArchiveTo);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (move.text === null) fs.copyFileSync(path.join(vault, move.from), target, fs.constants.COPYFILE_EXCL);
  else fs.writeFileSync(target, move.text, { encoding: 'utf8', flag: 'wx' });
}

/** Each step of a list, counted; a step that throws is recorded and the rest go on. */
function eachStep(items, pathOf, step, errors) {
  let done = 0;
  for (const item of items) {
    try {
      step(item);
      done += 1;
    } catch (err) {
      errors.push({ path: pathOf(item), error: describeError(err) });
    }
  }
  return done;
}

/** Throws when `file` no longer holds what the plan read: a hook wrote it since, and its text must not be lost. */
function assertUnchanged(file, planned) {
  if (planned !== null && planned !== undefined && fs.readFileSync(file, 'utf8') !== planned) throw new Error(CHANGED);
}

/** Every file left in a collection folder besides its hub. */
function othersIn(dir, hub) {
  const walk = (current) =>
    fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(current, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  try {
    return walk(dir).filter((file) => path.resolve(file) !== path.resolve(hub));
  } catch {
    return [];
  }
}

/**
 * Moves (target written before the source goes), links, new hubs, archives,
 * then empty folders. A hub whose collection still holds a file (a move that
 * failed, a note changed since the plan) is kept, not archived.
 */
function carryOut(plan, errors) {
  const { vault } = plan;
  const moved = eachStep(plan.moves, (m) => m.from, (move) => {
    assertUnchanged(path.join(vault, move.from), move.sourceText);
    if (!move.alreadyThere) writeTarget(vault, move);
    fs.unlinkSync(path.join(vault, move.from));
  }, errors);
  const rewritten = eachStep(plan.rewrites, (r) => r.path, (rewrite) => {
    assertUnchanged(rewrite.file, rewrite.original);
    fs.writeFileSync(rewrite.file, rewrite.text, 'utf8');
  }, errors);
  const hubs = eachStep(plan.hubsToCreate ?? [], (place) => place, (place) => {
    const [area, collection] = place.split('/');
    if (!AREAS.includes(area)) throw new Error(`not an area: ${area}`);
    const made = ensureIndex(vault, area, collection);
    if (!made.ok) throw new Error(made.error);
  }, errors);
  const kept = [];
  const archivable = plan.archives.filter((archive) => {
    const hub = path.join(vault, archive.from);
    const left = othersIn(path.dirname(hub), hub).length;
    if (left) kept.push({ path: archive.from, reason: `${left} file(s) still in its collection` });
    return !left;
  });
  const archived = eachStep(archivable, (a) => a.from, (archive) => archiveFile(path.join(vault, archive.from), archive.to), errors);
  for (const collection of SOURCE_COLLECTIONS) removeEmptyDirs(path.join(vault, SOURCE_AREA, collection));
  return { moved, rewritten, hubs, archived, kept };
}

/**
 * Carry a plan out while holding both realm locks. When a lock cannot be taken
 * nothing is written, and the error says who holds it.
 *
 * @param {object} plan  from planMoveToRealm
 * @param {object} [io]  `locks`: see realmLocks; injectable for tests
 * @returns {{moved: number, rewritten: number, hubs: number, archived: number, kept: object[], errors: Array<{path: string, error: string}>}}
 */
export function applyMoveToRealm(plan, { locks = realmLocks(plan.vault) } = {}) {
  const errors = [];
  const held = [];
  const releaseAll = () => {
    for (const lock of [...held].reverse()) {
      const released = locks.release(lock);
      if (released && released.ok === false) errors.push({ path: 'lock', error: `release failed (${released.error})` });
    }
  };
  for (const realm of TOUCHED_REALMS) {
    const got = locks.acquire(realm);
    if (!got.ok) {
      releaseAll();
      return { moved: 0, rewritten: 0, hubs: 0, archived: 0, kept: [], errors: [...errors, { path: realm, error: got.error }] };
    }
    held.push(got.lock);
  }
  try {
    return { ...carryOut(plan, errors), errors };
  } finally {
    releaseAll();
  }
}
