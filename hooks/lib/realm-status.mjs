/**
 * Reading `git status --porcelain=v1 -z --untracked-files=all` (R-B2).
 *
 * The sync stages only the sync set, so it needs to know what changed, which
 * of it travels, and whether a person staged something outside that set by
 * hand — a commit would carry it along, so the sync refuses instead.
 *
 * Pure functions over git's output; the caller runs git.
 */

/**
 * Porcelain v1 codes, in either column, that carry the original path in the
 * next field. A worktree rename (` R`) comes from `git add -N`.
 */
const TWO_PATH_CODES = new Set(['R', 'C']);
/** `XY` then a space: the shortest record with a one-character path. */
const MIN_RECORD_CHARS = 4;
const PATH_OFFSET = 3;
/** Index states that mean nothing is staged for this path: unmodified, untracked. */
const UNSTAGED_INDEX = new Set([' ', '?']);

/**
 * One frozen `{ x, y, path, from }` per changed path. `from` is the original
 * path of a rename or copy, '' otherwise. A record git would never write is
 * an error naming its index, not something to skip.
 *
 * @param {string} stdout
 * @returns {readonly {x: string, y: string, path: string, from: string}[]}
 */
export function parsePorcelainZ(stdout) {
  const text = String(stdout ?? '');
  if (!text.trim()) return Object.freeze([]);
  const fields = text.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  const records = [];
  for (let at = 0; at < fields.length; at += 1) {
    const field = fields[at];
    const index = records.length;
    if (field.length < MIN_RECORD_CHARS || field[2] !== ' ') {
      throw new Error(`git status record ${index} is malformed: ${JSON.stringify(field)}`);
    }
    const x = field[0];
    let from = '';
    if (TWO_PATH_CODES.has(x) || TWO_PATH_CODES.has(field[1])) {
      at += 1;
      if (at >= fields.length || !fields[at]) throw new Error(`git status record ${index} has no original path`);
      from = fields[at];
    }
    records.push(Object.freeze({ x, y: field[1], path: field.slice(PATH_OFFSET), from }));
  }
  return Object.freeze(records);
}

/**
 * The records the sync stages, and the rest. A rename counts by its new
 * path: that is the file that would land in the commit.
 */
export function splitBySyncPath(records, isSyncPath) {
  const sync = records.filter((record) => isSyncPath(record.path));
  const leftover = records.filter((record) => !isSyncPath(record.path));
  return Object.freeze({ sync: Object.freeze(sync), leftover: Object.freeze(leftover) });
}

/** Leftover records with something in the index: staged by hand outside the sync set. */
export function stagedOutsideSync(records, isSyncPath) {
  const { leftover } = splitBySyncPath(records, isSyncPath);
  return Object.freeze(leftover.filter((record) => !UNSTAGED_INDEX.has(record.x)));
}
