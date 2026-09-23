/**
 * How this package spawns a child process.
 *
 * One rule, and it is a Windows rule. `execFileSync('git', …, { cwd })` looks
 * for `git` **in the child's working directory before `PATH`**: that is libuv's
 * `search_path()`, and Node does not opt out of it. The working directory here
 * is a repository the user cloned, so a file called `git.exe` sitting in a
 * checkout root would run — unattended, at session exit, with the user's
 * privileges, hidden window, output swallowed.
 *
 * So no spawn in this package ever uses an untrusted directory as its working
 * directory. The repository is passed to git as `-C <path>`, an argument, and
 * the process itself starts in the user's home directory with
 * `NoDefaultCurrentDirectoryInExePath` set — the documented Windows switch that
 * removes the current directory from executable search entirely.
 *
 * Neither part is sufficient alone: the environment variable is Windows-only
 * and version-dependent, and a trusted cwd would not help if a future caller
 * passed a repository path back in. Both together mean program resolution never
 * consults a directory anybody else can write to.
 *
 * A caller may add environment for one spawn (`extraEnv`): the realm sync sets
 * git's identity and turns off credential prompts per call rather than touching
 * the user's global config. The hardening key is merged after it, so no caller
 * can switch the search-path rule back off by passing it in.
 */

import os from 'node:os';

/** The Windows switch that drops the current directory from program search. */
const HARDENED_ENV = Object.freeze({ NoDefaultCurrentDirectoryInExePath: '1' });

/**
 * Base options for `execFileSync`: a trusted working directory, a hardened
 * search path, no inherited stdin, no console window, bounded output.
 *
 * stderr is discarded unless `captureStderr` asks for it, so a caller that
 * wants git's error line can have it without every other spawn buffering noise.
 *
 * @param {number} timeoutMs
 * @param {number} maxBuffer
 * @param {{ extraEnv?: Record<string, string>, captureStderr?: boolean }} [options]
 */
export function trustedSpawnOptions(timeoutMs, maxBuffer, { extraEnv = {}, captureStderr = false } = {}) {
  return {
    cwd: os.homedir(),
    env: { ...process.env, ...extraEnv, ...HARDENED_ENV },
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer,
    stdio: ['ignore', 'pipe', captureStderr ? 'pipe' : 'ignore'],
    windowsHide: true,
  };
}

/**
 * `-C <repoRoot>` if there is one, else nothing.
 *
 * Safe in option position because every caller builds `repoRoot` with
 * `path.join` / `path.dirname` from an absolute path, so it can never begin
 * with `-` and be re-read by git as a flag.
 */
export function repoArgs(repoRoot) {
  return repoRoot ? ['-C', repoRoot] : [];
}
