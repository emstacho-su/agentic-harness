/**
 * The hook's only untrusted input: the JSON Claude Code writes to stdin.
 *
 * `session_id` becomes a **filename** in the vault, so it is validated as
 * strictly as anything in this repo: an allow-list of characters, no separators,
 * no dots that could climb a directory. Everything else is normalised to a known
 * shape or dropped. Nothing here throws; a malformed payload is a logged skip.
 */

import fs from 'node:fs';

import { END_REASONS, PARENT_SESSION_ENV_VAR } from './constants.mjs';
import { pick, toPosix } from './text.mjs';

/** Session ids are UUIDs today; the allow-list is a little wider and no wider. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PATH_CLIMB = /(^|[/\\])\.\.([/\\]|$)/;

/**
 * Read stdin without ever blocking session exit.
 *
 * `fs.readFileSync(0)` works for a file redirect but returns nothing on some
 * Windows pipe handles — verified: `node hook.mjs < payload.json` reads fine
 * while `echo … | node hook.mjs` does not. A hook that silently reads nothing
 * captures nothing forever, so the fallback is a chunked `readSync` loop that
 * tolerates EAGAIN on a non-blocking pipe and is bounded by the deadline.
 */
export function readStdin(deadlineAt) {
  try {
    const direct = fs.readFileSync(0, 'utf8');
    if (direct && direct.trim()) return direct;
  } catch {
    /* fall through to the chunked reader */
  }

  const chunks = [];
  const buf = Buffer.alloc(64 * 1024);
  while (Date.now() < deadlineAt) {
    let read;
    try {
      read = fs.readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      if (err && err.code === 'EAGAIN') continue; // pipe not ready yet
      break; // EOF, EBADF, or a closed handle
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Validate and normalise the payload.
 *
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function parseHookInput(raw, env = process.env) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'stdin was not JSON' };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'stdin was not an object' };
  }

  const sessionId = pick(input, 'session_id', 'sessionId');
  if (!sessionId) return { ok: false, error: 'no session_id' };
  if (!SAFE_ID.test(sessionId) || PATH_CLIMB.test(sessionId)) {
    return { ok: false, error: `session_id is not a safe filename: ${JSON.stringify(sessionId.slice(0, 64))}` };
  }

  const reasonRaw = pick(input, 'reason', 'end_reason');
  const endReason = END_REASONS.has(reasonRaw) ? reasonRaw : 'other';

  const parentFromEnv = String(env?.[PARENT_SESSION_ENV_VAR] ?? '').trim();
  const parentSession = pick(input, 'parent_session_id', 'parentSessionId', 'parent_session') || parentFromEnv;

  return {
    ok: true,
    value: {
      sessionId,
      endReason,
      cwd: toPosix(pick(input, 'cwd')),
      transcriptPath: toPosix(pick(input, 'transcript_path', 'transcriptPath')),
      agentId: pick(input, 'agent_id', 'agentId'),
      agentType: pick(input, 'agent_type', 'agentType'),
      parentSession: SAFE_ID.test(parentSession) ? parentSession : '',
    },
  };
}
