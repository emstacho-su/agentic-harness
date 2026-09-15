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
 */

import os from 'node:os';

/**
 * Base options for `execFileSync`: a trusted working directory, a hardened
 * search path, no inherited stdin, no console window, bounded output.
 *
 * @param {number} timeoutMs
 * @param {number} maxBuffer
 */
export function trustedSpawnOptions(timeoutMs, maxBuffer) {
  return {
    cwd: os.homedir(),
    env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' },
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer,
    stdio: ['ignore', 'pipe', 'ignore'],
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
