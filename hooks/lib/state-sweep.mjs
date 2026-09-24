/**
 * The nightly sweep of a hook state folder (SC-2).
 *
 * The SessionStart hook leaves one `<session_id>.json` per session under
 * `~/.harness/state/session-start/`, and capture reads it without deleting it
 * (a re-captured note must still find its record). This removes the ones old
 * enough that no capture will ask again.
 *
 * Deliberately narrow: only regular files named `*.json`, directly inside
 * the folder, judged by `lstat` so a symlink is never followed or removed,
 * and never recursive. A folder that does not exist yet (the hook has not run
 * on this machine) is a result, not an error.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_STATE_MAX_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECORD_SUFFIX = '.json';

/**
 * Returns `{ swept, kept, missing, errors }`: `swept` names the files removed
 * (or, on a dry run, the ones that would be), `kept` counts the `*.json`
 * files young enough to stay, `errors` lists `{ name, code }` for any file
 * that could not be judged or removed. Throws only on bad arguments or a
 * state path that exists but cannot be listed.
 */
export function sweepState({ stateDir, maxAgeDays = DEFAULT_STATE_MAX_AGE_DAYS, now = Date.now(), dryRun = false } = {}) {
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('sweepState: stateDir must be a non-empty path');
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) throw new RangeError(`sweepState: maxAgeDays must be > 0, got ${maxAgeDays}`);

  let entries;
  try {
    entries = fs.readdirSync(stateDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { swept: [], kept: 0, missing: true, errors: [] };
    throw error;
  }

  const cutoff = now - maxAgeDays * DAY_MS;
  const swept = [];
  const errors = [];
  let kept = 0;

  for (const entry of entries) {
    if (!entry.name.endsWith(RECORD_SUFFIX)) continue;
    const verdict = judge(path.join(stateDir, entry.name), cutoff);
    if (verdict.error) {
      errors.push({ name: entry.name, code: verdict.error });
    } else if (verdict.old) {
      const removed = dryRun ? null : remove(path.join(stateDir, entry.name));
      if (removed) errors.push({ name: entry.name, code: removed });
      else swept.push(entry.name);
    } else if (verdict.candidate) {
      kept += 1;
    }
  }
  return { swept, kept, missing: false, errors };
}

/** `{ candidate, old }` for a regular file, `{}` for anything else. */
function judge(file, cutoff) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    // Gone between the listing and now: another sweep, or the hook replacing it.
    if (error?.code === 'ENOENT') return {};
    return { error: error?.code || 'error' };
  }
  if (!stat.isFile()) return {};
  return { candidate: true, old: stat.mtimeMs < cutoff };
}

/** Remove one file; returns an error code, or null when it is gone. */
function remove(file) {
  try {
    fs.unlinkSync(file);
    return null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return error?.code || 'error';
  }
}
