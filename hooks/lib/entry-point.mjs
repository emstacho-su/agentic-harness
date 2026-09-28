/**
 * Is this module the script node was started with?
 *
 * Every CLI in hooks/ runs its main only when it is the process's entry point,
 * so a test (or a reviewer) can import it for its exports without it acting.
 * `install.mjs` once had no such guard, and importing it for a look ran a real
 * install against `~/.claude`.
 *
 * Compared through `realpath`, with case folded on Windows, because the same
 * file has many spellings there: `c:\users\…` from a shell, `C:/Users/…` from
 * a settings.json command, an 8.3 short name, a junction. A guard that misses
 * one of those would silently turn a hook into a no-op, which is worse than
 * the bug it fixes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function canonical(file, platform) {
  const resolved = path.resolve(file);
  let real = resolved;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    /* not on disk (or unreadable): compare the resolved spelling */
  }
  const posix = real.replace(/\\/g, '/');
  return platform === 'win32' ? posix.toLowerCase() : posix;
}

/**
 * @param {string} moduleUrl  the caller's `import.meta.url`
 * @param {string|undefined} [scriptPath]  defaults to `process.argv[1]`
 * @param {string} [platform]  defaults to `process.platform`; a parameter for the tests
 */
export function isEntryPoint(moduleUrl, scriptPath = process.argv[1], platform = process.platform) {
  if (typeof scriptPath !== 'string' || scriptPath === '') return false;
  let modulePath;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
  return canonical(modulePath, platform) === canonical(scriptPath, platform);
}
