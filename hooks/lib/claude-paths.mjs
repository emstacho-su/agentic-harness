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
 * encode alike), so decoding asks the disk: from the drive down, the entry
 * whose encoded name is the longest prefix of what is left. Whatever matches
 * nothing (a worktree deleted since) becomes the last segment as it is, and the
 * folder rules settle it from there.
 */

import fs from 'node:fs';
import os from 'node:os';

import { toPosix } from './text.mjs';

/** Where Claude Code puts folders named after an encoded cwd, relative to home and to the temp dir. */
const HOME_STATE_SEGMENTS = Object.freeze(['.claude', 'projects']);
const TMP_STATE_SEGMENTS = Object.freeze(['claude']);

/** `C--Users-…`: a drive letter, then `:\` encoded as two dashes. */
const WINDOWS_DRIVE = /^([A-Za-z])--(.*)$/;

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

/** The entry of `dir` whose encoded name is the longest whole-segment prefix of `rest`, or null. */
function longestMatch(dir, rest, listDir) {
  let best = null;
  for (const name of listDir(dir)) {
    const encoded = encodeClaudeProjectName(name);
    const fits = encoded === rest || rest.startsWith(`${encoded}-`);
    if (fits && (!best || encoded.length > best.encoded.length)) best = { name, encoded };
  }
  return best;
}

/** `C--Users-estac-agentic-harness` -> `C:/Users/estac/agentic-harness`, guided by `listDir`; '' when it names no root. */
export function decodeClaudeProjectName(encoded, listDir = listDirNames) {
  const drive = WINDOWS_DRIVE.exec(encoded);
  let dir;
  let rest;
  if (drive) {
    dir = `${drive[1].toUpperCase()}:/`;
    rest = drive[2];
  } else if (encoded.startsWith('-')) {
    dir = '/';
    rest = encoded.slice(1);
  } else {
    return '';
  }
  while (rest) {
    const match = longestMatch(dir, rest, listDir);
    if (!match) return joinPosix(dir, rest);
    dir = joinPosix(dir, match.name);
    rest = rest.slice(match.encoded.length + 1);
  }
  return dir;
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
