/**
 * The one-shot move of the harness history into the harness realm (R-H3).
 *
 * Every note in the five collections that older rules invented or that the
 * harness filled (SOURCE_COLLECTIONS, all under `projects/`) is resolved again
 * with the R-H2 rules and goes where they send it:
 *   - a session note by its own recorded `cwd` (routeSession);
 *   - a worker note (`parent_session`) wherever its parent ends up, found in
 *     this move or elsewhere in the vault; by its own cwd when the parent is
 *     nowhere;
 *   - a session with no cwd stays with its collection: agentic-harness's go
 *     to the harness realm, any other's is left and reported.
 * `agentic-harness`'s hub, `notes/` and `decisions/` move with it once every
 * session has left. The hubs of the other four go to the archive, never deleted.
 *
 * A note keeps its `id`, the store's key, so the store sees a metadata update.
 * Its text changes only where the placement shows: `collection:`, `up:` and the
 * ` — <collection>` end of `title:`, each edited in place (frontmatter-lines).
 * A qualified `up:` link anywhere else in the vault that names a moved note is
 * pointed at its new path. Nothing is committed: the notes are copied into the
 * new folder and removed from the old one, and one sync commits both realms.
 *
 * Planning reads only. `applyMoveToRealm` carries a plan out, writing each
 * target before it removes the source.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { holdsHarnessRealm, routeSession } from './collection.mjs';
import { AREA_HARNESS, AREA_PROJECTS, REALM_MARKER, SESSIONS_DIR } from './constants.mjs';
import { editFrontmatterLines } from './frontmatter-lines.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { hubFilename, hubLink } from './links.mjs';
import { findNotesByName } from './notes-io.mjs';
import { describeHolder, peekRealmLock } from './realm-lock.mjs';
import { realmRootFor } from './realm-sync.mjs';
import { listRealmNotes } from './rename-hubs.mjs';
import { resolveRepo } from './repo.mjs';
import { toPosix } from './text.mjs';

/** The collections this move empties, all under `projects/`. */
export const SOURCE_COLLECTIONS = Object.freeze(['agentic-harness', 'claude', 'memory', 'projects', 'remote']);
/** The one of them that is a real project: it moves whole, hub and all. */
const MOVING_COLLECTION = 'agentic-harness';
const SOURCE_AREA = AREA_PROJECTS;
/** The realms the move writes into; neither may be mid-sync. */
const TOUCHED_REALMS = Object.freeze([AREA_PROJECTS, AREA_HARNESS]);

const SHORT_ID = 8;
const TITLE_SUFFIX = ' — ';
const QUALIFIED_NOTE_LINK = /^\[\[([a-z]+)\/([^/|\]]+)\/sessions\/([^/|\]]+)(?:\|([^\]]*))?\]\]$/;

const posixJoin = (...parts) => parts.filter(Boolean).join('/');
const short = (id) => String(id).slice(0, SHORT_ID);
const placeOf = (area, collection) => `${area}/${collection}`;

export function defaultArchiveRoot(now = new Date(), home = os.homedir()) {
  return toPosix(path.join(home, '.claude-archive', `${now.toISOString().slice(0, 10)}-vault-hubs`));
}

/** Reasons `--apply` must not run; empty when it may. */
export function checkPreconditions({ vault, realmsListed, peek = peekRealmLock }) {
  const problems = [];
  if (!holdsHarnessRealm(vault)) problems.push(`${AREA_HARNESS}/${REALM_MARKER} is missing: run init-realm --realm ${AREA_HARNESS} first`);
  if (!realmsListed.includes(AREA_HARNESS)) problems.push(`HARNESS_REALMS does not list ${AREA_HARNESS}: ingest would refuse the realm`);
  for (const realm of TOUCHED_REALMS) {
    const lock = peek(realmRootFor(vault, realm));
    if (lock.held) problems.push(`the ${realm} realm lock is held${lock.holder ? ` by ${describeHolder(lock.holder)}` : ''}; wait for the sync`);
  }
  return problems;
}

// ------------------------------------------------------------------ inventory

/** A file's text, or null when it would not survive a UTF-8 round trip. */
function readText(file) {
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

function walkFiles(dir, base = dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(full, base);
    return entry.isFile() ? [toPosix(path.relative(base, full))] : [];
  });
}

/** Every file of the source collections, each with what planning needs to know. */
function inventory(vault, unreadable) {
  return SOURCE_COLLECTIONS.flatMap((collection) =>
    walkFiles(path.join(vault, SOURCE_AREA, collection)).flatMap((sub) => {
      const rel = posixJoin(SOURCE_AREA, collection, sub);
      const isSession = sub.startsWith(`${SESSIONS_DIR}/`) && sub.endsWith('.md');
      const isHub = sub === hubFilename(collection);
      const entry = { collection, sub, rel, file: path.join(vault, rel), kind: isSession ? 'session' : isHub ? 'hub' : 'other' };
      if (!sub.endsWith('.md')) return [entry];
      const text = readText(entry.file);
      if (text === null) {
        unreadable.push({ path: rel, error: 'not UTF-8 round-trip safe' });
        return [];
      }
      const parsed = parseFrontmatter(text);
      if (!parsed.ok) {
        unreadable.push({ path: rel, error: parsed.error });
        return [];
      }
      return [{ ...entry, text, fields: parsed.fields }];
    }),
  );
}

// ------------------------------------------------------------------ placement

/** Where a top-level session goes, and why. */
function placeSession(entry, ctx) {
  const cwd = String(entry.fields.cwd ?? '');
  if (!cwd) {
    if (entry.collection === MOVING_COLLECTION && ctx.holdsHarness) {
      return { area: AREA_HARNESS, collection: MOVING_COLLECTION, reason: `no cwd: stays with its collection ${MOVING_COLLECTION}` };
    }
    return { area: SOURCE_AREA, collection: entry.collection, reason: 'no cwd: left where it is' };
  }
  const routed = routeSession({ cwd, vaultRoot: ctx.vault, repo: ctx.resolveRepoFor(cwd), home: ctx.home, tmp: ctx.tmp, resolveRepoFor: ctx.resolveRepoFor, holdsHarness: ctx.holdsHarness });
  const decoded = toPosix(cwd) !== routed.routedCwd;
  return { area: routed.area, collection: routed.collection, reason: `${routed.rule}: ${routed.routedCwd}`, decoded };
}

/** Where a worker goes: after its parent, found in this move or in the vault; else by its own cwd. */
function placeWorker(entry, parents, ctx) {
  const parent = String(entry.fields.parent_session);
  const inMove = parents.get(parent);
  if (inMove) return { ...inMove, reason: `parent ${short(parent)} -> ${placeOf(inMove.area, inMove.collection)}` };
  const elsewhere = findNotesByName(ctx.vault, `${parent}.md`).find((copy) => !SOURCE_COLLECTIONS.includes(copy.collection) || copy.area !== SOURCE_AREA);
  if (elsewhere) return { area: elsewhere.area, collection: elsewhere.collection, parentTitle: null, reason: `parent ${short(parent)} -> ${placeOf(elsewhere.area, elsewhere.collection)}` };
  const own = placeSession(entry, ctx);
  const notes = [own.decoded ? 'decoded' : '', `parent ${short(parent)} not in the vault`].filter(Boolean).join('; ');
  return { ...own, reason: `${own.reason} (${notes})` };
}

// ------------------------------------------------------------------ text

function retitle(title, from, to) {
  return from !== to && title.endsWith(`${TITLE_SUFFIX}${from}`) ? `${title.slice(0, -from.length)}${to}` : title;
}

/** A moved or linking note's `up:`, pointed at where things now are. */
function relink(up, { fromCollection, to, movedNotes }) {
  const hub = up.match(/^\[\[([a-z]+)\/([^/|\]]+)\/([^/|\]]+)(\|[^\]]*)?\]\]$/);
  if (hub && hub[1] === SOURCE_AREA && hub[2] === fromCollection && hub[3] === fromCollection) return hubLink(to.area, to.collection);
  const qualified = up.match(QUALIFIED_NOTE_LINK);
  const moved = qualified && movedNotes.get(`${qualified[1]}/${qualified[2]}/${SESSIONS_DIR}/${qualified[3]}`);
  if (!moved) return up;
  const label = qualified[4] === undefined ? '' : `|${qualified[4] === moved.oldTitle ? moved.newTitle : qualified[4]}`;
  return `[[${moved.newStem}${label}]]`;
}

function movedText(entry, target, movedNotes) {
  if (entry.kind !== 'session' || target.collection === entry.collection && target.area === SOURCE_AREA) return entry.text;
  const edits = {
    collection: (value) => (value === entry.collection ? target.collection : value),
    title: (value) => retitle(value, entry.collection, target.collection),
    up: (value) => relink(value, { fromCollection: entry.collection, to: target, movedNotes }),
  };
  return editFrontmatterLines(entry.text, edits).text;
}

// ------------------------------------------------------------------ plan

function targetState(file, text, sourceFile) {
  if (!fs.existsSync(file)) return 'free';
  if (text === null) return fs.readFileSync(file).equals(fs.readFileSync(sourceFile)) ? 'same' : 'different';
  return fs.readFileSync(file, 'utf8') === text ? 'same' : 'different';
}

/**
 * The whole move, planned; nothing on disk changes.
 *
 * @returns {{vault: string, moves: object[], archives: object[], rewrites: object[], stays: object[], conflicts: object[], unreadable: object[]}}
 */
export function planMoveToRealm({ vault, home = os.homedir(), tmp = os.tmpdir(), holdsHarness = holdsHarnessRealm(vault), resolveRepoFor = resolveRepo, archiveRoot = defaultArchiveRoot() }) {
  const ctx = { vault, home, tmp, holdsHarness, resolveRepoFor };
  const unreadable = [];
  const entries = inventory(vault, unreadable);
  const sessions = entries.filter((entry) => entry.kind === 'session');
  const isWorker = (entry) => Boolean(entry.fields.parent_session);

  const placed = new Map();
  const parents = new Map();
  for (const entry of sessions.filter((each) => !isWorker(each))) {
    const routed = placeSession(entry, ctx);
    const target = routed.decoded ? { ...routed, reason: `${routed.reason} (decoded)` } : routed;
    placed.set(entry, target);
    parents.set(String(entry.fields.session_id ?? ''), target);
  }
  for (const entry of sessions.filter(isWorker)) placed.set(entry, placeWorker(entry, parents, ctx));

  // Titles and paths of the session notes that move, for the links that name them.
  const movedNotes = new Map();
  for (const [entry, target] of placed) {
    if (target.area === SOURCE_AREA && target.collection === entry.collection) continue;
    const stem = path.posix.basename(entry.sub, '.md');
    const oldTitle = String(entry.fields.title ?? '');
    movedNotes.set(posixJoin(SOURCE_AREA, entry.collection, SESSIONS_DIR, stem), {
      newStem: posixJoin(target.area, target.collection, SESSIONS_DIR, stem),
      oldTitle,
      newTitle: retitle(oldTitle, entry.collection, target.collection),
    });
  }

  const moves = [];
  const stays = [];
  const conflicts = [];
  const keeps = new Set();
  const noteKey = (entry) => posixJoin(SOURCE_AREA, entry.collection, SESSIONS_DIR, path.posix.basename(entry.sub, '.md'));
  const holdBack = (entry, error) => {
    conflicts.push({ path: entry.rel, error });
    keeps.add(entry.collection);
    movedNotes.delete(noteKey(entry));
  };
  // Parents first: a parent that cannot move holds its workers back with it,
  // or their links would name a path it never reached.
  const heldParents = new Set();
  const ordered = [...placed].sort(([a], [b]) => Number(isWorker(a)) - Number(isWorker(b)));
  for (const [entry, target] of ordered) {
    if (target.area === SOURCE_AREA && target.collection === entry.collection) {
      stays.push({ path: entry.rel, reason: target.reason });
      keeps.add(entry.collection);
      continue;
    }
    const parent = String(entry.fields.parent_session ?? '');
    if (isWorker(entry) && heldParents.has(parent)) {
      holdBack(entry, `parent ${short(parent)} stays (conflict); left with it`);
      continue;
    }
    const to = posixJoin(target.area, target.collection, entry.sub);
    const text = movedText(entry, target, movedNotes);
    const state = targetState(path.join(vault, to), text, entry.file);
    if (state === 'different') {
      holdBack(entry, `${to} already exists with different text`);
      if (!isWorker(entry)) heldParents.add(String(entry.fields.session_id ?? ''));
      continue;
    }
    moves.push({ from: entry.rel, to, reason: target.reason, text, alreadyThere: state === 'same' });
  }

  const archives = [];
  for (const entry of entries.filter((each) => each.kind !== 'session')) {
    if (keeps.has(entry.collection)) {
      stays.push({ path: entry.rel, reason: `${entry.collection} keeps notes` });
      continue;
    }
    if (entry.collection === MOVING_COLLECTION && holdsHarness) {
      const to = posixJoin(AREA_HARNESS, MOVING_COLLECTION, entry.sub);
      const text = entry.text ?? null;
      const state = targetState(path.join(vault, to), text, entry.file);
      if (state === 'different') conflicts.push({ path: entry.rel, error: `${to} already exists with different text` });
      else moves.push({ from: entry.rel, to, reason: `moves with ${MOVING_COLLECTION}`, text, alreadyThere: state === 'same' });
    } else if (entry.kind === 'hub') {
      archives.push({ from: entry.rel, to: posixJoin(toPosix(archiveRoot), entry.rel) });
    } else {
      stays.push({ path: entry.rel, reason: 'not a session or a hub; left for a person' });
    }
  }

  const sourceRels = new Set(entries.map((entry) => entry.rel));
  const rewrites = planLinkRewrites(vault, sourceRels, movedNotes, unreadable);
  return { vault, moves, archives, rewrites, stays, conflicts, unreadable };
}

/** `up:` links outside the move that name a moved note. */
function planLinkRewrites(vault, sourceRels, movedNotes, unreadable) {
  if (movedNotes.size === 0) return [];
  return listRealmNotes(vault, unreadable)
    .filter((note) => !sourceRels.has(note.rel))
    .flatMap((note) => {
      const text = readText(note.file);
      if (text === null) return [];
      const edited = editFrontmatterLines(text, { up: (value) => relink(value, { fromCollection: '', to: null, movedNotes }) });
      return edited.changes.length ? [{ path: note.rel, file: note.file, text: edited.text, changes: edited.changes }] : [];
    });
}

// ------------------------------------------------------------------ apply

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
    // Left in place: an empty folder is harmless, and the report names nothing to fix.
  }
}

const describeError = (err) => err?.code || err?.message || 'unknown';

function writeTarget(vault, move) {
  const target = path.join(vault, move.to);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (move.text === null) fs.copyFileSync(path.join(vault, move.from), target, fs.constants.COPYFILE_EXCL);
  else fs.writeFileSync(target, move.text, { encoding: 'utf8', flag: 'wx' });
}

/**
 * Carry a plan out: each move writes its target first and removes its source
 * only after; then the links outside the move; then the hubs to the archive
 * (copied, then removed); then the source folders that are left empty.
 *
 * @returns {{moved: number, rewritten: number, archived: number, errors: Array<{path: string, error: string}>}}
 */
export function applyMoveToRealm(plan) {
  const { vault } = plan;
  const errors = [];
  let moved = 0;
  for (const move of plan.moves) {
    try {
      if (!move.alreadyThere) writeTarget(vault, move);
      fs.unlinkSync(path.join(vault, move.from));
      moved += 1;
    } catch (err) {
      errors.push({ path: move.from, error: describeError(err) });
    }
  }
  let rewritten = 0;
  for (const rewrite of plan.rewrites) {
    try {
      fs.writeFileSync(rewrite.file, rewrite.text, 'utf8');
      rewritten += 1;
    } catch (err) {
      errors.push({ path: rewrite.path, error: describeError(err) });
    }
  }
  let archived = 0;
  for (const archive of plan.archives) {
    try {
      fs.mkdirSync(path.dirname(archive.to), { recursive: true });
      fs.copyFileSync(path.join(vault, archive.from), archive.to, fs.constants.COPYFILE_EXCL);
      fs.unlinkSync(path.join(vault, archive.from));
      archived += 1;
    } catch (err) {
      errors.push({ path: archive.from, error: describeError(err) });
    }
  }
  for (const collection of SOURCE_COLLECTIONS) removeEmptyDirs(path.join(vault, SOURCE_AREA, collection));
  return { moved, rewritten, archived, errors };
}
