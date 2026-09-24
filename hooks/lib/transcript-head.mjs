/**
 * What a transcript declares about itself in its first records.
 *
 * Three readers need this and none may need the whole file: the sweep, which
 * stands in for the stdin a hook would have had; every capture, which files a
 * note by the directory its transcript started in; and `SubagentStop`, which
 * files a worker by the directory its *parent* session started in. Only the
 * head is read, so a transcript of hundreds of megabytes costs one small read.
 */

import fs from 'node:fs';
import path from 'node:path';

import { SUBAGENTS_DIR } from './constants.mjs';
import { toPosix } from './text.mjs';

/** How much of a transcript is read to learn its `cwd` and `entrypoint`. */
export const TRANSCRIPT_HEAD_BYTES = 64 * 1024;

const TRANSCRIPT_SUFFIX = '.jsonl';

/**
 * The `cwd` and `entrypoint` a transcript declares, from its first records.
 *
 * A transcript whose head holds neither yields empty strings, and so does one
 * that cannot be read: the caller decides what to fall back to.
 */
export function readTranscriptHead(transcriptPath) {
  let cwd = '';
  let entrypoint = '';
  for (const line of readHeadLines(transcriptPath)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && typeof entry?.cwd === 'string') cwd = toPosix(entry.cwd);
    if (!entrypoint && typeof entry?.entrypoint === 'string') entrypoint = entry.entrypoint;
    if (cwd && entrypoint) break;
  }
  return { cwd, entrypoint };
}

/**
 * The parent session's transcript for a worker transcript, by Claude Code's
 * layout: `<project dir>/<session id>/subagents/agent-<id>.jsonl` belongs to
 * `<project dir>/<session id>.jsonl`. `''` when the worker transcript does not
 * sit in that layout, so nothing is guessed from a path that merely resembles it.
 */
export function parentTranscriptBeside(agentTranscriptPath, sessionId) {
  if (!agentTranscriptPath || !sessionId) return '';
  const subagentsDir = path.dirname(agentTranscriptPath);
  const sessionDir = path.dirname(subagentsDir);
  if (path.basename(subagentsDir) !== SUBAGENTS_DIR || path.basename(sessionDir) !== sessionId) return '';
  return toPosix(path.join(path.dirname(sessionDir), `${sessionId}${TRANSCRIPT_SUFFIX}`));
}

function readHeadLines(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, read).toString('utf8').split('\n');
  } catch {
    return [];
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
