/**
 * Claude Code's own folders, turned back into the cwd they were made for (R-H2).
 *
 * Claude Code keeps per-project state in `~/.claude/projects/<encoded>/`
 * (transcripts, `memory/`, workflow agents' folders) and gives each session a
 * scratchpad under `<tmp>/claude/<encoded>/<session>/`. `<encoded>` is the
 * project's cwd with every character that is not a letter or digit replaced
 * by `-`: `C:\Users\estac\agentic-harness` is `C--Users-estac-agentic-harness`.
 * A session that runs in one of these folders belongs to that project, not to
 * a collection named `memory` or `claude`.
 *
 * The encoding loses information (`agentic-harness` and `agentic/harness`
 * encode alike), so decoding asks the disk: from the drive down, the entries
 * whose encoded names are a prefix of what is left, longest first, backing
 * out of any that lead nowhere. Whatever matches nothing (a worktree deleted
 * since) becomes the last segment as it is, and the rules settle it from there.
 */

import fs from 'node:fs';
import os from 'node:os';

import { toPosix } from './text.mjs';

/** Where Claude Code puts folders named after an encoded cwd, relative to home and to the temp dir. */
const HOME_STATE_SEGMENTS = Object.freeze(['.claude', 'projects']);
const TMP_STATE_SEGMENTS = Object.freeze(['claude']);

/** `C--Users-…`: a drive letter, then `:\` encoded as two dashes. */
const WINDOWS_DRIVE = /^([A-Za-z])--(.*)$/;
/** Deeper than any real path; bounds the backtracking. */
const MAX_DECODE_DEPTH = 40;

/** Claude Code's project-folder name for `cwd`. */
export function encodeClaudeProjectName(cwd) {
  return String(cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-');
}

/** Directory names in `dir`; none when it cannot be read. */
function listDirNames(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

const joinPosix = (dir, name) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`);
const trimSlash = (dir) => dir.replace(/\/+$/, '');

/** Windows paths are case-insensitive, and a cwd keeps whatever case it was typed in. */
const CASE_INSENSITIVE = process.platform === 'win32';

/** Entries of `dir` whose encoded name is `rest` or a whole-segment prefix of it, longest first. */
function candidates(dir, rest, listDir, caseInsensitive) {
  const fold = caseInsensitive ? (text) => text.toLowerCase() : (text) => text;
  const folded = fold(rest);
  return listDir(dir)
    .map((name) => ({ name, encoded: encodeClaudeProjectName(name) }))
    .filter(({ encoded }) => fold(encoded) === folded || folded.startsWith(`${fold(encoded)}-`))
    .sort((a, b) => b.encoded.length - a.encoded.length);
}

/** `path` with 8.3 short names (`ESTAC~1`) expanded, as the directory listings spell it; itself when it cannot be read. */
function expandPath(value) {
  try {
    return toPosix(fs.realpathSync.native(value));
  } catch {
    return toPosix(value);
  }
}

/**
 * `rest` decoded below `dir`: the first candidate, longest first, whose own
 * remainder decodes all the way down wins. When none does, the deepest match
 * of the first candidate is kept and what is left becomes its last segment.
 *
 * One ambiguity no directory listing can settle: a deleted `foo-web` beside a
 * live `foo` encodes exactly like a deleted `foo/web`, and decodes as the
 * latter. Deleted worktrees (`<project>-wt-<x>`) decode inside `<project>`,
 * which files them under that project either way. A cwd spelled with an 8.3
 * short name (`RUNNER~1`) inside the encoded part matches no directory listing,
 * which holds long names only; its unmatched rest becomes one segment, as for
 * a deleted folder. Home and the temp dir themselves are expanded first.
 */
function decodeBelow(dir, rest, options, depth) {
  if (!rest) return { path: dir, complete: true };
  let fallback = null;
  if (depth < MAX_DECODE_DEPTH) {
    for (const { name, encoded } of candidates(dir, rest, options.listDir, options.caseInsensitive)) {
      const below = decodeBelow(joinPosix(dir, name), rest.slice(encoded.length + 1), options, depth + 1);
      if (below.complete) return below;
      fallback ??= below;
    }
  }
  return fallback ?? { path: joinPosix(dir, rest), complete: false };
}

/** `C--Users-estac-agentic-harness` -> `C:/Users/estac/agentic-harness`, guided by `listDir`; '' when it names no root. */
export function decodeClaudeProjectName(encoded, { listDir = listDirNames, caseInsensitive = CASE_INSENSITIVE } = {}) {
  const options = { listDir, caseInsensitive };
  const drive = WINDOWS_DRIVE.exec(encoded);
  if (drive) return decodeBelow(`${drive[1].toUpperCase()}:/`, drive[2], options, 0).path;
  if (encoded.startsWith('-')) return decodeBelow('/', encoded.slice(1), options, 0).path;
  return '';
}

/**
 * The cwd a Claude Code state folder or scratchpad was made for, or '' when
 * `cwd` is not inside one. The prefix is compared without case: Windows
 * spells the same temp dir both ways.
 */
export function decodeClaudeStateCwd(
  cwd,
  { home = os.homedir(), tmp = os.tmpdir(), listDir = listDirNames, caseInsensitive = CASE_INSENSITIVE, realpath = expandPath } = {},
) {
  const posix = toPosix(cwd);
  if (!posix) return '';
  // Each base as given and expanded: os.tmpdir() can be an 8.3 short path
  // while the cwd Claude Code reports is the long one, or the other way round.
  const bases = [
    ...[home, realpath(home)].map((base) => [trimSlash(toPosix(base)), ...HOME_STATE_SEGMENTS].join('/')),
    ...[tmp, realpath(tmp)].map((base) => [trimSlash(toPosix(base)), ...TMP_STATE_SEGMENTS].join('/')),
  ];
  for (const root of new Set(bases)) {
    if (!posix.toLowerCase().startsWith(`${root.toLowerCase()}/`)) continue;
    const encoded = posix.slice(root.length + 1).split('/')[0];
    if (encoded) return decodeClaudeProjectName(encoded, { listDir, caseInsensitive });
  }
  return '';
}
