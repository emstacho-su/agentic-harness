/**
 * The Obsidian links a session note carries, derived from its relational fields.
 *
 * Obsidian draws a graph edge only for a `[[wikilink]]`. The relational fields —
 * `parent_session`, `resumed_from`, `supersedes` — hold raw ids on purpose: they
 * are what the RAG store filters on, so they stay exactly as they are. `up` and
 * `related` are a projection of them into the one syntax Obsidian reads.
 *
 * Two decisions worth knowing about.
 *
 * The links live in frontmatter, never the body. `ingest` hashes the body to
 * decide whether to re-embed, so a link added here costs a metadata update and
 * nothing else.
 *
 * They are recomputed on every write, never merged. `mergeFields` grows lists
 * and keeps a non-empty scalar, which is right for a fact and wrong for a
 * derivation: a link whose source field changed would stay in the note forever.
 *
 * Nothing here touches the filesystem, so a link may point at a note that does
 * not exist yet. That is the ordinary case — a worker stops long before the
 * session that spawned it is captured — and Obsidian resolves the link the
 * moment the note appears.
 */

import { AREAS, INDEX_NOTE } from './constants.mjs';
import { isSafeFilenameSegment } from './text.mjs';

const NOTE_ID_PREFIX = 'session-';

/**
 * A session id, exactly. `parent_session` is the one link source that can arrive
 * from outside — the hook's stdin, an environment variable, a checkpoint note
 * that came through git — and a merely filename-safe value there would let it
 * name any note in the vault as this note's parent.
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The filename stem a note id or a bare session id names, or `''`.
 *
 * `session-<uuid>`, `session-<uuid>-r2` and `session-<uuid>--<agent>` all file
 * under their id minus the prefix; `parent_session` is a bare session id and
 * files under itself. The allow-list is the one every filename already passes:
 * a parent id can arrive through an environment variable, and `]]` or `|` in it
 * would end the link early and start another.
 */
export function noteStem(idOrSessionId) {
  const text = String(idOrSessionId ?? '');
  const stem = text.startsWith(NOTE_ID_PREFIX) ? text.slice(NOTE_ID_PREFIX.length) : text;
  return isSafeFilenameSegment(stem) ? stem : '';
}

/**
 * `[[<stem>]]` — the short form. A session's stem is a UUID, unique across the
 * vault, so the link resolves even when the target sits in another collection.
 */
export function sessionLink(idOrSessionId) {
  const stem = noteStem(idOrSessionId);
  return stem ? `[[${stem}]]` : '';
}

/** The link to a parent session, or `''` when the value is not a session id. */
function parentLink(parentSession) {
  return SESSION_ID.test(String(parentSession ?? '')) ? sessionLink(parentSession) : '';
}

/**
 * `[[<area>/<collection>/index|<collection>]]` — the full path, because every
 * collection has a note called `index` and a bare `[[index]]` picks one of them.
 */
export function indexLink(area, collection) {
  if (!AREAS.includes(area) || !isSafeFilenameSegment(collection)) return '';
  return `[[${area}/${collection}/${INDEX_NOTE}|${collection}]]`;
}

/**
 * `fields` with `up` and `related` derived afresh. Returns a new object.
 *
 * A worker links up to the session that spawned it and a session links up to
 * its collection index, which keeps the index from becoming a hub for every
 * worker note as well. The graph is undirected, so the parent needs no list of
 * its children to be joined to them.
 *
 * `collection` is where the note is filed. It defaults to the note's own field,
 * which for a capture is the same thing; the backfill passes the folder it
 * found the note in, because that is where the index actually is.
 */
export function withLinks(fields, area, collection = fields.collection) {
  const supersedes = Array.isArray(fields.supersedes) ? fields.supersedes : [];
  const related = [fields.resumed_from, ...supersedes].map(sessionLink).filter(Boolean);
  return {
    ...fields,
    up: parentLink(fields.parent_session) || indexLink(area, collection),
    related: [...new Set(related)],
  };
}
