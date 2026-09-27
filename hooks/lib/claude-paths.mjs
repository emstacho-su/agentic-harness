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

/** Entries of `dir` whose encoded name is `rest` or a whole-segment prefix of it, longest first. */
function candidates(dir, rest, listDir) {
  return listDir(dir)
    .map((name) => ({ name, encoded: encodeClaudeProjectName(name) }))
    .filter(({ encoded }) => encoded === rest || rest.startsWith(`${encoded}-`))
    .sort((a, b) => b.encoded.length - a.encoded.length);
}

/**
 * `rest` decoded below `dir`: the first candidate, longest first, whose own
 * remainder decodes all the way down wins. When none does, the deepest match
 * of the first candidate is kept and what is left becomes its last segment.
 *
 * One ambiguity no directory listing can settle: a deleted `foo-web` beside a
 * live `foo` encodes exactly like a deleted `foo/web`, and decodes as the
 * latter. Deleted worktrees (`<project>-wt-<x>`) decode inside `<project>`,
 * which files them under that project either way. And a cwd spelled with an
 * 8.3 short name (`RUNNER~1`) matches no directory listing, which holds long
 * names only; its unmatched rest becomes one segment, as for a deleted folder.
 */
function decodeBelow(dir, rest, listDir, depth) {
  if (!rest) return { path: dir, complete: true };
  let fallback = null;
  if (depth < MAX_DECODE_DEPTH) {
    for (const { name, encoded } of candidates(dir, rest, listDir)) {
      const below = decodeBelow(joinPosix(dir, name), rest.slice(encoded.length + 1), listDir, depth + 1);
      if (below.complete) return below;
      fallback ??= below;
    }
  }
  return fallback ?? { path: joinPosix(dir, rest), complete: false };
}

/** `C--Users-estac-agentic-harness` -> `C:/Users/estac/agentic-harness`, guided by `listDir`; '' when it names no root. */
export function decodeClaudeProjectName(encoded, listDir = listDirNames) {
  const drive = WINDOWS_DRIVE.exec(encoded);
  if (drive) return decodeBelow(`${drive[1].toUpperCase()}:/`, drive[2], listDir, 0).path;
  if (encoded.startsWith('-')) return decodeBelow('/', encoded.slice(1), listDir, 0).path;
  return '';
}

/**
 * The cwd a Claude Code state folder or scratchpad was made for, or '' when
 * `cwd` is not inside one. The prefix is compared without case: Windows
 * spells the same temp dir both ways.
 */
export function decodeClaudeStateCwd(cwd, { home = os.homedir(), tmp = os.tmpdir(), listDir = listDirNames } = {}) {
  const posix = toPosix(cwd);
  if (!posix) return '';
  const roots = [
    [trimSlash(toPosix(home)), ...HOME_STATE_SEGMENTS].join('/'),
    [trimSlash(toPosix(tmp)), ...TMP_STATE_SEGMENTS].join('/'),
  ];
  for (const root of roots) {
    if (!posix.toLowerCase().startsWith(`${root.toLowerCase()}/`)) continue;
    const encoded = posix.slice(root.length + 1).split('/')[0];
    if (encoded) return decodeClaudeProjectName(encoded, listDir);
  }
  return '';
}
