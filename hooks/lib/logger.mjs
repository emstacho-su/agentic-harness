/**
 * The hook's only output channel.
 *
 * `SessionEnd` has nowhere to print: stdout is swallowed and a non-zero exit
 * surfaces as an error on the user's way out of the session. So every decision
 * the hook makes — including every skip — goes to one append-only log that
 * rotates itself.
 */

import fs from 'node:fs';
import path from 'node:path';

import { LOG_KEEP_LINES, LOG_MAX_BYTES } from './constants.mjs';

/**
 * Build a logger writing to `logPath`.
 *
 * Every failure is swallowed on purpose: logging must never be the thing that
 * breaks the hook. The returned function also records nothing when `logPath` is
 * falsy, which is how the tests run silently.
 */
export function createLogger(logPath, { now = () => new Date() } = {}) {
  if (!logPath) return () => {};

  return function log(line) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      rotateIfLarge(logPath);
      fs.appendFileSync(logPath, `${now().toISOString()} ${line}\n`, 'utf8');
    } catch {
      /* deliberately silent — see the module comment */
    }
  };
}

function rotateIfLarge(logPath) {
  let stat = null;
  try {
    stat = fs.statSync(logPath);
  } catch {
    return; // first write
  }
  if (!stat || stat.size <= LOG_MAX_BYTES) return;

  const kept = fs.readFileSync(logPath, 'utf8').split('\n').slice(-LOG_KEEP_LINES).join('\n');
  fs.writeFileSync(logPath, kept, 'utf8');
}
