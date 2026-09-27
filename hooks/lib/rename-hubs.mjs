/**
 * The one-shot hub rename (R-N1): `<area>/<c>/index.md` becomes `<area>/<c>/<c>.md`,
 * and every `up:` link that names the old hub is rewritten to the new one.
 *
 * Three promises, in the order they matter.
 *
 * A hub is moved, never edited: its UUID `id` is the store's `external_id`, so a
 * byte-identical move costs the store a metadata update and nothing else.
 *
 * A link rewrite is a textual edit of one frontmatter line. The frontmatter is
 * never re-serialised: materials notes were written by Python's
 * `yaml.safe_dump`, and the hook's serializer would reorder and requote them —
 * a body-hash-neutral change, but hundreds of diffs nobody asked for.
 *
 * It converges. A collection whose hub already sits at `<c>/<c>.md` still has
 * its links rewritten, so a run interrupted halfway is finished by the next,
 * and a run after that finds nothing to do.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AREAS, HUB_NOTE_TYPE, LEGACY_HUB_FILENAME, SESSIONS_DIR } from './constants.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { runGitSync } from './git-log.mjs';
import { hubFilename } from './links.mjs';

/** Obsidian's settings and git's store are not notes; everything else is walked. */
const SKIPPED_DIRS = new Set(['.obsidian', '.git']);

/** A OneDrive-backed realm can be slow to answer; the hook's 400 ms is for session exit. */
const RENAME_GIT_TIMEOUT_MS = 10_000;

const DELIMITER = /^---\s*$/;
const UP_LINE = /^up:([ \t]*)(.*?)([ \t]*)$/;

/**
 * `'[[<area>/<c>/index|<alias>]]'`, in any of the three quoting styles, alias
 * optional. The quote must close what it opened, or the value is something a
 * person typed and this script does not guess at.
 */
const OLD_HUB_VALUE = new RegExp(`^(['"]?)\\[\\[(${AREAS.join('|')})/([^/|\\]'"\\\\]+)/index(\\|[^\\]]*)?\\]\\]\\1$`);

/** A wikilink, whole: `[[target]]`, `[[target|alias]]`, `[[target#heading|alias]]`. */
const WIKILINK = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/;

const toVaultRel = (vault, file) => path.relative(vault, file).split(path.sep).join('/');
const splitEol = (line) => {
  const eol = line.match(/\r?\n$/)?.[0] ?? '';
  return { body: line.slice(0, line.length - eol.length), eol };
};

/**
 * `raw` with every frontmatter `up:` line that names an old hub in `targets`
 * (a set of `<area>/<collection>`) pointed at the new one. Pure.
 *
 * Only top-level `up:` lines between the delimiters are looked at, and each
 * line keeps its quote style, its spacing and its line ending; no other byte
 * changes. A missing alias becomes `|<c>`, the label the hook writes.
 *
 * @returns {{text: string, changes: Array<{target: string, old: string, new: string}>}}
 */
export function rewriteUpLines(raw, targets) {
  const lines = String(raw).split(/(?<=\n)/);
  const unchanged = { text: String(raw), changes: [] };
  if (lines.length === 0 || !DELIMITER.test(splitEol(lines[0]).body)) return unchanged;
  const close = lines.findIndex((line, index) => index > 0 && DELIMITER.test(splitEol(line).body));
  if (close === -1) return unchanged;

  const changes = [];
  const rewritten = lines.map((line, index) => {
    if (index === 0 || index >= close) return line;
    const { body, eol } = splitEol(line);
    const up = body.match(UP_LINE);
    const link = up?.[2].match(OLD_HUB_VALUE);
    if (!link) return line;
    const [, quote, area, collection, alias] = link;
    const target = `${area}/${collection}`;
    if (!targets.has(target) || !hubFilename(collection)) return line;
    const value = `${quote}[[${area}/${collection}/${collection}${alias ?? `|${collection}`}]]${quote}`;
    changes.push({ target, old: up[2], new: value });
    return `up:${up[1]}${value}${up[3]}${eol}`;
  });
  return changes.length ? { text: rewritten.join(''), changes } : unchanged;
}

/**
 * A folder's entries, sorted. A folder that is not there has none; one that is
 * there and cannot be read goes to `onError`, because on an unmounted or busy
 * OneDrive "nothing to do" would be a lie the `--check` gate then believes.
 */
function listDir(dir, onError) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    if (err?.code !== 'ENOENT') onError(dir, err?.code || err?.message || 'unreadable');
    return [];
  }
}

const isFile = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * Every `.md` under the realms, sorted, as `{file, rel}`. A folder that
 * cannot be read is added to `unreadable` as `{path, error}`.
 */
export function listRealmNotes(vault, unreadable = []) {
  const notes = [];
  const onError = (dir, error) => unreadable.push({ path: toVaultRel(vault, dir), error });
  const walk = (dir) => {
    for (const entry of listDir(dir, onError)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) notes.push({ file: full, rel: toVaultRel(vault, full) });
    }
  };
  for (const area of AREAS) walk(path.join(vault, area));
  return notes;
}

/**
 * A note's text, or why it cannot be edited safely. A file that does not
 * survive a UTF-8 round trip would be changed by being written back, so it
 * counts as unreadable too.
 */
function readNoteText(file) {
  try {
    const bytes = fs.readFileSync(file);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) return { text: '', error: 'not valid UTF-8' };
    const parsed = parseFrontmatter(text);
    return parsed.ok ? { text, fields: parsed.fields, error: '' } : { text: '', error: parsed.error };
  } catch (err) {
    return { text: '', error: err?.code || err?.message || 'unreadable' };
  }
}

const isHub = (file) => isFile(file) && readNoteText(file).fields?.type === HUB_NOTE_TYPE;

/** Is `<vault>/<area>` a git work tree? One read-only question per realm. */
function isGitRealm(realmDir, runGit) {
  const answer = runGit(['rev-parse', '--is-inside-work-tree'], { cwd: realmDir, timeoutMs: RENAME_GIT_TIMEOUT_MS });
  return answer.ok && answer.stdout.trim() === 'true';
}

/**
 * `git mv` only moves what git tracks. A hub the hook created since the last
 * realm sync is untracked, and a plain rename is the right move for it.
 */
function isTracked(realmDir, realmRel, runGit) {
  return runGit(['ls-files', '--error-unmatch', '--', realmRel], { cwd: realmDir, timeoutMs: RENAME_GIT_TIMEOUT_MS }).ok;
}

/**
 * Which hubs move, which are refused, and which collections' links are due.
 *
 * @returns {{moves: object[], refused: object[], targets: Set<string>}}
 */
function planHubs(vault, runGit) {
  const moves = [];
  const refused = [];
  const targets = new Set();
  for (const area of AREAS) {
    const realmDir = path.join(vault, area);
    // A realm that cannot be listed is reported once, by planRewrites's walk.
    const collections = listDir(realmDir, () => {}).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    let git = null; // asked once, and only if a realm has a hub to move
    for (const { name: collection } of collections) {
      const hubName = hubFilename(collection);
      const from = path.join(realmDir, collection, LEGACY_HUB_FILENAME);
      const to = path.join(realmDir, collection, hubName);
      if (!isFile(from)) {
        if (hubName && isHub(to)) targets.add(`${area}/${collection}`);
        continue;
      }
      if (hubName.toLowerCase() === LEGACY_HUB_FILENAME) continue; // a collection called `index` is already named for itself
      if (!hubName) {
        refused.push({ path: toVaultRel(vault, from), error: 'collection name is not a safe filename' });
      } else if (fs.existsSync(to)) {
        refused.push({ path: toVaultRel(vault, from), error: `${toVaultRel(vault, to)} already exists` });
      } else {
        git ??= isGitRealm(realmDir, runGit);
        const fromRealm = `${collection}/${LEGACY_HUB_FILENAME}`;
        const method = git && isTracked(realmDir, fromRealm, runGit) ? 'git mv' : 'rename';
        moves.push({ area, collection, realmDir, fromRealm, toRealm: `${collection}/${hubName}`, file: from, toFile: to,
          from: toVaultRel(vault, from), to: toVaultRel(vault, to), method });
        targets.add(`${area}/${collection}`);
      }
    }
  }
  return { moves, refused, targets };
}

/** Every note whose `up:` names a hub in `targets`, with its new text. */
function planRewrites(vault, targets) {
  const rewrites = [];
  const unreadable = [];
  for (const { file, rel } of listRealmNotes(vault, unreadable)) {
    const note = readNoteText(file);
    if (note.error) {
      unreadable.push({ path: rel, error: note.error });
      continue;
    }
    const result = rewriteUpLines(note.text, targets);
    if (result.changes.length) rewrites.push({ path: rel, file, text: result.text, changes: result.changes });
  }
  return { rewrites, unreadable };
}

/** One move, or why not. The destination is checked again: `renameSync` would replace it. */
function moveHub(move, runGit) {
  if (fs.existsSync(move.toFile)) return `${move.to} already exists`;
  if (move.method === 'git mv') {
    const result = runGit(['mv', '--', move.fromRealm, move.toRealm], {
      cwd: move.realmDir,
      timeoutMs: RENAME_GIT_TIMEOUT_MS,
      captureStderr: true,
    });
    return result.ok ? '' : `git mv failed (${[result.error, result.stderr].filter(Boolean).join(': ')})`;
  }
  try {
    fs.renameSync(move.file, move.toFile);
    return '';
  } catch (err) {
    return `rename failed (${err?.code || err?.message || 'unknown'})`;
  }
}

/** Write one rewritten note; the error, or `''`. */
function writeNote(file, text) {
  try {
    fs.writeFileSync(file, text, 'utf8');
    return '';
  } catch (err) {
    return `write failed (${err?.code || err?.message || 'unknown'})`;
  }
}

/**
 * Plan the rename and, with `apply`, carry it out: every move first, then the
 * links of the collections whose hub now sits at its new name. A link is never
 * pointed at a hub whose move failed.
 *
 * `log` receives one line per move and rewrite, as planned or as done;
 * refusals are in the report, for the caller to print once.
 *
 * @returns {{moves: object[], rewrites: object[], refused: object[], unreadable: object[]}}
 */
export function renameHubs({ vault, apply = false, runGit = runGitSync, log = () => {} }) {
  const { moves, refused, targets } = planHubs(vault, runGit);
  const { rewrites, unreadable } = planRewrites(vault, targets);
  const done = { moves: [], rewrites: [], refused: [...refused] };
  const failed = new Set();

  for (const move of moves) {
    if (!apply) {
      log(`${move.from} -> ${move.to} (${move.method})`);
      done.moves.push(move);
      continue;
    }
    const error = moveHub(move, runGit);
    if (error) {
      failed.add(`${move.area}/${move.collection}`);
      done.refused.push({ path: move.from, error });
    } else {
      done.moves.push(move);
      log(`${move.from} -> ${move.to}: moved (${move.method})`);
    }
  }

  // A moved hub's own path changed under the plan; its text goes to the new one.
  const movedTo = new Map(done.moves.map((move) => [move.file, move.toFile]));
  for (const rewrite of rewrites) {
    const blocked = rewrite.changes.find((change) => failed.has(change.target));
    const error = blocked ? `hub move failed for ${blocked.target}` : apply ? writeNote(movedTo.get(rewrite.file) ?? rewrite.file, rewrite.text) : '';
    if (error) {
      done.refused.push({ path: rewrite.path, error });
      continue;
    }
    done.rewrites.push(rewrite);
    for (const change of rewrite.changes) log(`${rewrite.path}: up: ${change.old} -> ${change.new}`);
  }

  return { ...done, unreadable };
}

/** `up`'s value as text. A bare `[[x]]` parses as a YAML flow list, `[['x']]`. */
function upText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return `[${value[0]}]`;
  return '';
}

/** A session id, exactly: the stem a worker's bare `[[<uuid>]]` link names. */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The parent session a worker link names, or `''` for a hub or other link.
 * A worker link is a bare UUID (the old form) or a path into a `sessions/`
 * folder (R-N2's form); everything else is judged as a hub link.
 */
function workerParent(target) {
  const parts = target.split('/');
  if (parts.length === 1) return SESSION_UUID.test(target) ? target : '';
  return parts.at(-2) === SESSIONS_DIR ? parts.at(-1) : '';
}

/** `[{parent, count}]`, most workers first, then by id so the order is stable. */
function tallyByParent(pending) {
  const counts = new Map();
  for (const { parent } of pending) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  return [...counts]
    .map(([parent, count]) => ({ parent, count }))
    .sort((a, b) => b.count - a.count || a.parent.localeCompare(b.parent));
}

/**
 * Every `up:` link under the realms that names a missing file, in two kinds.
 *
 * A path-qualified link must exist at `<vault>/<path>.md`. A bare `[[<stem>]]`
 * must be a note in a `sessions/` folder or a hub. A value that is not a
 * wikilink is not a link, and is not judged.
 *
 * An unresolved hub link is breakage. An unresolved worker link is `pending`:
 * a worker's note is written when it stops, long before the session that
 * spawned it ends and is captured, so a parent that is not there yet is the
 * ordinary state and not something this script, or anyone, should fix.
 *
 * @returns {{checked: number, broken: object[], pending: object[],
 *            pendingByParent: object[], unreadable: object[]}}
 */
export function checkUpLinks({ vault }) {
  const unreadable = [];
  const notes = listRealmNotes(vault, unreadable);
  const stems = new Set();
  for (const { rel } of notes) {
    const parts = rel.split('/');
    const stem = parts.at(-1).slice(0, -'.md'.length);
    if (parts.at(-2) === SESSIONS_DIR || (parts.length === 3 && parts[1] === stem)) stems.add(stem);
  }

  const broken = [];
  const pending = [];
  let checked = 0;
  for (const { file, rel } of notes) {
    const note = readNoteText(file);
    if (note.error) {
      unreadable.push({ path: rel, error: note.error });
      continue;
    }
    const value = upText(note.fields.up);
    const target = value.match(WIKILINK)?.[1].trim();
    if (!target) continue;
    checked += 1;
    const exists = target.includes('/') ? isFile(path.join(vault, `${target}.md`)) : stems.has(target);
    if (exists) continue;
    const parent = workerParent(target);
    if (parent) pending.push({ path: rel, value, parent });
    else broken.push({ path: rel, value });
  }
  return { checked, broken, pending, pendingByParent: tallyByParent(pending), unreadable };
}
