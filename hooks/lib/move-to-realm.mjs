/**
 * The one-shot move of the harness history into the harness realm (R-H3): the plan.
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
 * session has left; a stub hub the new hook already made there is replaced.
 * The hubs of the other four go to the archive, never deleted. A collection
 * that keeps anything (a conflict, an unreadable note) keeps its hub.
 *
 * A note keeps its `id`, the store's key, so the store sees a metadata update.
 * Its text changes only where the placement shows: `collection:`,
 * `collection_source:`, `up:` and the ` — <collection>` end of `title:`, each
 * edited in place (frontmatter-lines), and checked afterwards: a line that
 * could not be edited makes the note a conflict, never a stale move. A
 * qualified `up:` link in any note that stays, here or elsewhere in the vault,
 * that names a moved note is pointed at its new path.
 *
 * Planning reads only; move-to-realm-apply.mjs carries a plan out.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { holdsHarnessRealm, routeSession } from './collection.mjs';
import { AREA_HARNESS, AREA_PROJECTS, HUB_NOTE_TYPE, REALM_MARKER, SESSIONS_DIR } from './constants.mjs';
import { editFrontmatterLines } from './frontmatter-lines.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { hubFilename, hubLink } from './links.mjs';
import { findNotesByName, hubStubBody } from './notes-io.mjs';
import { describeHolder, peekRealmLock } from './realm-lock.mjs';
import { realmRootFor } from './realm-sync.mjs';
import { listRealmNotes } from './rename-hubs.mjs';
import { resolveRepo } from './repo.mjs';
import { toPosix } from './text.mjs';

/** The collections this move empties, all under `projects/`. */
export const SOURCE_COLLECTIONS = Object.freeze(['agentic-harness', 'claude', 'memory', 'projects', 'remote']);
export const SOURCE_AREA = AREA_PROJECTS;
/** The realms the move writes into; neither may be mid-sync. */
export const TOUCHED_REALMS = Object.freeze([AREA_PROJECTS, AREA_HARNESS]);
/** The one source collection that is a real project: it moves whole, hub and all. */
const MOVING_COLLECTION = 'agentic-harness';

const SHORT_ID = 8;
const TITLE_SUFFIX = ' — ';
const HUB_LINK = /^\[\[([a-z]+)\/([^/|\]]+)\/([^/|\]]+)(\|[^\]]*)?\]\]$/;
const QUALIFIED_NOTE_LINK = /^\[\[([a-z]+)\/([^/|\]]+)\/sessions\/([^/|\]]+)(?:\|([^\]]*))?\]\]$/;

const posixJoin = (...parts) => parts.filter(Boolean).join('/');
const short = (id) => String(id).slice(0, SHORT_ID);
const placeOf = (area, collection) => `${area}/${collection}`;
export const describeError = (err) => err?.code || err?.message || 'unknown';
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function defaultArchiveRoot(now = new Date(), home = os.homedir()) {
  return toPosix(path.join(home, '.claude-archive', `${now.toISOString().slice(0, 10)}-vault-hubs`));
}

/**
 * Reasons the move must not run; empty when it may. A stale lock does not
 * count: the apply takes it over, as the checkpoint collector does.
 */
export function checkPreconditions({ vault, realmsListed, peek = peekRealmLock }) {
  const problems = [];
  if (!holdsHarnessRealm(vault)) problems.push(`${AREA_HARNESS}/${REALM_MARKER} is missing: run init-realm --realm ${AREA_HARNESS} first`);
  if (!realmsListed.includes(AREA_HARNESS)) problems.push(`HARNESS_REALMS does not list ${AREA_HARNESS}: ingest would refuse the realm`);
  for (const realm of TOUCHED_REALMS) {
    const lock = peek(realmRootFor(vault, realm));
    if (lock.held && !lock.stale) problems.push(`the ${realm} realm lock is held${lock.holder ? ` by ${describeHolder(lock.holder)}` : ''}; wait for the sync`);
  }
  return problems;
}

/** Why a plan must not be applied: its conflicts and unreadable notes, in words; '' when none. */
export function planBlockers(plan) {
  const parts = [];
  if (plan.conflicts.length) parts.push(plural(plan.conflicts.length, 'conflict'));
  if (plan.unreadable.length) parts.push(plural(plan.unreadable.length, 'unreadable note'));
  return parts.length ? `the plan has ${parts.join(' and ')}; fix them and run --dry-run again` : '';
}

// ------------------------------------------------------------------ inventory

/** A file's text, or null when it would not survive a UTF-8 round trip. Throws when it cannot be read. */
function readText(file) {
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

/** Relative paths of every file under `dir`. A folder that exists and cannot be read goes to `onError`. */
function walkFiles(dir, onError, base = dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    if (err?.code !== 'ENOENT') onError(dir, describeError(err));
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(full, onError, base);
    return entry.isFile() ? [toPosix(path.relative(base, full))] : [];
  });
}

/** One source file as planning sees it; `unreadable` when it cannot be planned for. */
function inventoryEntry(vault, collection, sub) {
  const rel = posixJoin(SOURCE_AREA, collection, sub);
  const isSession = sub.startsWith(`${SESSIONS_DIR}/`) && sub.endsWith('.md');
  const kind = isSession ? 'session' : sub === hubFilename(collection) ? 'hub' : 'other';
  const entry = { collection, sub, rel, file: path.join(vault, rel), kind, text: null, fields: {} };
  if (!sub.endsWith('.md')) return entry;
  let text;
  try {
    text = readText(entry.file);
  } catch (err) {
    return { ...entry, unreadable: describeError(err) };
  }
  if (text === null) return { ...entry, unreadable: 'not UTF-8 round-trip safe' };
  const parsed = parseFrontmatter(text);
  return parsed.ok ? { ...entry, text, fields: parsed.fields } : { ...entry, unreadable: parsed.error };
}

/** Every file of the source collections. Unreadable ones are reported and hold their collection. */
function inventory(vault, unreadable, keeps) {
  return SOURCE_COLLECTIONS.flatMap((collection) => {
    const onError = (dir, error) => {
      unreadable.push({ path: toPosix(path.relative(vault, dir)), error });
      keeps.add(collection);
    };
    return walkFiles(path.join(vault, SOURCE_AREA, collection), onError).flatMap((sub) => {
      const entry = inventoryEntry(vault, collection, sub);
      if (!entry.unreadable) return [entry];
      unreadable.push({ path: entry.rel, error: entry.unreadable });
      keeps.add(collection);
      return [];
    });
  });
}

// ------------------------------------------------------------------ placement

/** Where a top-level session goes, and why. */
function placeSession(entry, ctx) {
  const cwd = String(entry.fields.cwd ?? '');
  if (!cwd) {
    if (entry.collection === MOVING_COLLECTION && ctx.holdsHarness) {
      return { area: AREA_HARNESS, collection: MOVING_COLLECTION, collectionSource: null, reason: `no cwd: stays with its collection ${MOVING_COLLECTION}` };
    }
    return { area: SOURCE_AREA, collection: entry.collection, collectionSource: null, reason: 'no cwd: left where it is' };
  }
  const routed = routeSession({ cwd, vaultRoot: ctx.vault, home: ctx.home, tmp: ctx.tmp, resolveRepoFor: ctx.resolveRepoFor, holdsHarness: ctx.holdsHarness });
  const decoded = toPosix(cwd) !== routed.routedCwd;
  return { area: routed.area, collection: routed.collection, collectionSource: routed.collectionSource, reason: `${routed.rule}: ${routed.routedCwd}`, decoded };
}

/** A note's `collection_source`, or null when it cannot be read. */
function collectionSourceOf(file) {
  try {
    const text = readText(file);
    const parsed = text === null ? null : parseFrontmatter(text);
    return parsed?.ok && typeof parsed.fields.collection_source === 'string' ? parsed.fields.collection_source : null;
  } catch {
    return null;
  }
}

/** Where a worker goes: after its parent, found in this move or in the vault; else by its own cwd. */
function placeWorker(entry, parents, ctx) {
  const parent = String(entry.fields.parent_session);
  const inMove = parents.get(parent);
  if (inMove) return { ...inMove, reason: `parent ${short(parent)} -> ${placeOf(inMove.area, inMove.collection)}` };
  const elsewhere = findNotesByName(ctx.vault, `${parent}.md`).find((copy) => copy.area !== SOURCE_AREA || !SOURCE_COLLECTIONS.includes(copy.collection));
  if (elsewhere) {
    const reason = `parent ${short(parent)} -> ${placeOf(elsewhere.area, elsewhere.collection)}`;
    return { area: elsewhere.area, collection: elsewhere.collection, collectionSource: collectionSourceOf(elsewhere.notePath), reason };
  }
  const own = placeSession(entry, ctx);
  const notes = [own.decoded ? 'decoded' : '', `parent ${short(parent)} not in the vault`].filter(Boolean).join('; ');
  return { ...own, reason: `${own.reason} (${notes})` };
}

// ------------------------------------------------------------------ text

function retitle(title, from, to) {
  return from !== to && title.endsWith(`${TITLE_SUFFIX}${from}`) ? `${title.slice(0, -from.length)}${to}` : title;
}

/**
 * An `up:` value pointed at where things now are: a moved collection's new hub
 * (`hubMoves`, keyed `projects/<collection>`), or a moved note's new path.
 */
function relink(up, { hubMoves, movedNotes }) {
  const hub = up.match(HUB_LINK);
  const hubTo = hub && hub[2] === hub[3] && hubMoves.get(`${hub[1]}/${hub[2]}`);
  if (hubTo) return hubLink(hubTo.area, hubTo.collection);
  const qualified = up.match(QUALIFIED_NOTE_LINK);
  const moved = qualified && movedNotes.get(`${qualified[1]}/${qualified[2]}/${SESSIONS_DIR}/${qualified[3]}`);
  if (!moved) return up;
  const label = qualified[4] === undefined ? '' : `|${qualified[4] === moved.oldTitle ? moved.newTitle : qualified[4]}`;
  return `[[${moved.newStem}${label}]]`;
}

/** The line edits a moved note needs. */
function editsFor(entry, target, movedNotes) {
  const up = (value) => relink(value, { hubMoves: new Map([[`${SOURCE_AREA}/${entry.collection}`, target]]), movedNotes });
  if (entry.kind !== 'session') return { up };
  return {
    collection: (value) => (value === entry.collection ? target.collection : value),
    collection_source: (value) => target.collectionSource ?? value,
    title: (value) => retitle(value, entry.collection, target.collection),
    up,
  };
}

/**
 * The moved note's text and, when a line the move must change could not be
 * edited in place (a double-quoted value with escapes, bare-CR line ends), why.
 * Checked on the parsed result, the way ingest will read it.
 */
function movedText(entry, target, movedNotes) {
  if (entry.text === null) return { text: null, error: '' };
  const edits = editsFor(entry, target, movedNotes);
  const edited = editFrontmatterLines(entry.text, edits);
  const { text } = edited;
  if (!edited.found && Object.keys(entry.fields).length) return { text, error: 'could not edit the frontmatter in place (line endings)' };
  // A refused line matters only when the move needs it changed. The hook's own
  // reader keeps escapes raw, so `collection` (the one line every move rewrites)
  // is taken as needed whatever it reads.
  const needed = edited.skipped.filter((key) => key === 'collection' || edits[key](String(entry.fields[key] ?? '')) !== String(entry.fields[key] ?? ''));
  if (needed.length) return { text, error: `could not edit ${needed.join(', ')} in place (escaped double-quoted value)` };
  const after = parseFrontmatter(text);
  for (const [key, edit] of Object.entries(edits)) {
    const before = entry.fields[key];
    if (typeof before !== 'string') continue;
    const wanted = edit(before);
    if (wanted !== null && wanted !== before && after.fields?.[key] !== wanted) return { text, error: `could not edit ${key} in place` };
  }
  return { text, error: '' };
}

// ------------------------------------------------------------------ plan

function isStubHub(file, collection) {
  try {
    const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    return parsed.ok && parsed.fields.type === HUB_NOTE_TYPE && parsed.fields.collection === collection && parsed.body === hubStubBody(collection);
  } catch {
    return false;
  }
}

/** `free`, `same`, `stub` (a hub ensureIndex wrote and nobody has touched) or `different`. */
function targetState(file, move, entry) {
  if (!fs.existsSync(file)) return 'free';
  const same = move.text === null ? fs.readFileSync(file).equals(fs.readFileSync(entry.file)) : fs.readFileSync(file, 'utf8') === move.text;
  if (same) return 'same';
  return entry.kind === 'hub' && isStubHub(file, entry.collection) ? 'stub' : 'different';
}

/** Titles and new paths of the session notes placed somewhere new, for the links that name them. */
function movedNoteIndex(placed) {
  const index = new Map();
  for (const [entry, target] of placed) {
    if (target.area === SOURCE_AREA && target.collection === entry.collection) continue;
    const stem = path.posix.basename(entry.sub, '.md');
    const oldTitle = String(entry.fields.title ?? '');
    index.set(posixJoin(SOURCE_AREA, entry.collection, SESSIONS_DIR, stem), {
      newStem: posixJoin(target.area, target.collection, SESSIONS_DIR, stem),
      oldTitle,
      newTitle: retitle(oldTitle, entry.collection, target.collection),
    });
  }
  return index;
}

/**
 * The whole move, planned; nothing on disk changes.
 *
 * @returns {{vault: string, archiveRoot: string, moves: object[], archives: object[], rewrites: object[], stays: object[], conflicts: object[], unreadable: object[]}}
 */
export function planMoveToRealm({ vault, home = os.homedir(), tmp = os.tmpdir(), holdsHarness = holdsHarnessRealm(vault), resolveRepoFor = resolveRepo, archiveRoot = defaultArchiveRoot() }) {
  const ctx = { vault, home, tmp, holdsHarness, resolveRepoFor };
  const unreadable = [];
  const keeps = new Set();
  const entries = inventory(vault, unreadable, keeps);
  const isWorker = (entry) => Boolean(entry.fields.parent_session);
  const sessions = entries.filter((entry) => entry.kind === 'session');

  const placed = new Map();
  const parents = new Map();
  for (const entry of sessions.filter((each) => !isWorker(each))) {
    const routed = placeSession(entry, ctx);
    const target = routed.decoded ? { ...routed, reason: `${routed.reason} (decoded)` } : routed;
    placed.set(entry, target);
    parents.set(String(entry.fields.session_id ?? ''), target);
  }
  for (const entry of sessions.filter(isWorker)) placed.set(entry, placeWorker(entry, parents, ctx));
  const movedNotes = movedNoteIndex(placed);

  const plan = { moves: [], stays: [], conflicts: [], archives: [] };
  const planned = new Map();
  const heldParents = new Set();
  const holdBack = (entry, error) => {
    plan.conflicts.push({ path: entry.rel, error });
    keeps.add(entry.collection);
    movedNotes.delete(posixJoin(SOURCE_AREA, entry.collection, SESSIONS_DIR, path.posix.basename(entry.sub, '.md')));
    if (entry.kind === 'session' && !isWorker(entry)) heldParents.add(String(entry.fields.session_id ?? ''));
  };
  const tryMove = (entry, target, reason) => {
    const to = posixJoin(target.area, target.collection, entry.sub);
    const { text, error } = movedText(entry, target, movedNotes);
    if (error) return holdBack(entry, error);
    if (planned.has(to)) return holdBack(entry, `${to} is also planned from ${planned.get(to)}`);
    const move = { from: entry.rel, to, reason, text, sourceText: entry.text };
    const state = targetState(path.join(vault, to), move, entry);
    if (state === 'different') return holdBack(entry, `${to} already exists with different text`);
    planned.set(to, entry.rel);
    const stub = state === 'stub' ? { replacesStub: true, stubArchiveTo: posixJoin(toPosix(archiveRoot), to.replace(/\.md$/, '.stub.md')) } : {};
    plan.moves.push({ ...move, alreadyThere: state === 'same', ...stub });
  };

  // Parents first: a parent that cannot move holds its workers back with it,
  // or their links would name a path it never reached.
  const ordered = [...placed].sort(([a], [b]) => Number(isWorker(a)) - Number(isWorker(b)));
  for (const [entry, target] of ordered) {
    const parent = String(entry.fields.parent_session ?? '');
    if (target.area === SOURCE_AREA && target.collection === entry.collection) {
      plan.stays.push({ path: entry.rel, reason: target.reason });
      keeps.add(entry.collection);
    } else if (isWorker(entry) && heldParents.has(parent)) {
      holdBack(entry, `parent ${short(parent)} stays (conflict); left with it`);
    } else {
      tryMove(entry, target, target.reason);
    }
  }

  for (const entry of entries.filter((each) => each.kind !== 'session')) {
    if (keeps.has(entry.collection)) {
      plan.stays.push({ path: entry.rel, reason: `${entry.collection} keeps notes` });
    } else if (entry.collection === MOVING_COLLECTION && holdsHarness) {
      tryMove(entry, { area: AREA_HARNESS, collection: MOVING_COLLECTION, collectionSource: null }, `moves with ${MOVING_COLLECTION}`);
    } else if (entry.kind === 'hub') {
      plan.archives.push({ from: entry.rel, to: posixJoin(toPosix(archiveRoot), entry.rel) });
    } else {
      plan.stays.push({ path: entry.rel, reason: 'not a session or a hub; left for a person' });
      keeps.add(entry.collection);
    }
  }
  // A hub queued for the archive before a later file made its collection stay would orphan that file.
  const heldHubs = plan.archives.filter((archive) => keeps.has(archive.from.split('/')[1]));
  plan.archives = plan.archives.filter((archive) => !heldHubs.includes(archive));
  for (const hub of heldHubs) plan.stays.push({ path: hub.from, reason: `${hub.from.split('/')[1]} keeps notes` });

  const movedRels = new Set(plan.moves.map((move) => move.from));
  const hubMoves = new Map(
    plan.moves.filter((move) => path.posix.basename(move.from) === hubFilename(move.from.split('/')[1]) && move.from.split('/').length === 3)
      .map((move) => [path.posix.dirname(move.from), { area: move.to.split('/')[0], collection: move.to.split('/')[1] }]),
  );
  const links = planLinkRewrites(vault, movedRels, { hubMoves, movedNotes }, unreadable);
  return {
    vault,
    archiveRoot: toPosix(archiveRoot),
    ...plan,
    conflicts: [...plan.conflicts, ...links.conflicts],
    rewrites: links.rewrites,
    hubsToCreate: hubsToCreate(vault, plan.moves),
    unreadable,
  };
}

/** Collections a moved session lands in that have no hub on disk and get none from the move. */
function hubsToCreate(vault, moves) {
  const arriving = new Set(moves.map((move) => move.to));
  const places = new Set(moves.filter((move) => move.to.split('/')[2] === SESSIONS_DIR).map((move) => move.to.split('/').slice(0, 2).join('/')));
  return [...places]
    .filter((place) => {
      const hub = `${place}/${hubFilename(place.split('/')[1])}`;
      return !arriving.has(hub) && !fs.existsSync(path.join(vault, hub));
    })
    .sort();
}

/**
 * `up:` links in notes that stay, anywhere in the vault, that name a moved note
 * or a moved hub. A note that links to one but cannot be edited in place is a
 * conflict: its link would dangle after the move.
 */
function planLinkRewrites(vault, movedRels, moved, unreadable) {
  const rewrites = [];
  const conflicts = [];
  if (moved.movedNotes.size === 0 && moved.hubMoves.size === 0) return { rewrites, conflicts };
  const relinkUp = (value) => relink(value, moved);
  const cannot = (note, why) => conflicts.push({ path: note.rel, error: `links to a moved note but ${why}` });
  for (const note of listRealmNotes(vault, unreadable).filter((each) => !movedRels.has(each.rel))) {
    let bytes;
    try {
      bytes = fs.readFileSync(note.file);
    } catch (err) {
      unreadable.push({ path: note.rel, error: describeError(err) });
      continue;
    }
    const text = bytes.toString('utf8');
    const up = parseFrontmatter(text).fields?.up;
    const needsEdit = typeof up === 'string' && relinkUp(up) !== up;
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      if (needsEdit) cannot(note, 'it is not UTF-8 round-trip safe');
      continue;
    }
    const edited = editFrontmatterLines(text, { up: relinkUp });
    if (edited.changes.length) rewrites.push({ path: note.rel, file: note.file, text: edited.text, original: text, changes: edited.changes });
    else if (needsEdit) cannot(note, 'its up: cannot be edited in place');
  }
  return { rewrites, conflicts };
}
