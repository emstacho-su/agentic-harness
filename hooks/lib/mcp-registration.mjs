/**
 * The `rag` MCP server's user-scope registration, built from this machine's
 * configuration and written through `claude mcp add-json`.
 *
 * `~/.claude.json` is Claude Code's own file and is never edited here; the CLI
 * is the sanctioned writer. The entry names an absolute node and an absolute
 * `dist/index.js`, which is why it could not live in the repo and used to be
 * typed by hand on each machine.
 */

import { spawnSync } from 'node:child_process';

export const SERVER_NAME = 'rag';
export const SCOPE = 'user';

/**
 * The non-secret variables the server reads (mcp-server/src/config.ts).
 *
 * DATABASE_URL is deliberately not among them. `claude mcp get` prints a
 * server's env block in clear text, so the registration carries the *path* to
 * the secrets file (HARNESS_ENV_FILE) and the server reads it at start.
 */
const SERVER_ENV = Object.freeze(['DATABASE_CA_CERT', 'DATABASE_SSL', 'FASTEMBED_CACHE_DIR']);
export const ENV_FILE_VAR = 'HARNESS_ENV_FILE';

const CLI_TIMEOUT_MS = 30_000;

/**
 * @param {{node: string, distIndex: string, envFile: string, env: NodeJS.ProcessEnv}} options
 *        `env` is the merged environment (repo .env + machine file) used only
 *        to check that a DATABASE_URL exists; its value never enters the config.
 */
export function buildRagServerConfig({ node, distIndex, envFile, env }) {
  if (!String(env?.DATABASE_URL ?? '').trim()) {
    throw new Error(`DATABASE_URL is not set in ${envFile} or the environment: nothing to register the rag server against`);
  }
  const serverEnv = { [ENV_FILE_VAR]: envFile };
  for (const name of SERVER_ENV) {
    const value = String(env?.[name] ?? '').trim();
    if (value) serverEnv[name] = value;
  }
  return { type: 'stdio', command: node, args: [distIndex], env: serverEnv };
}

/** Default runner: `claude` on PATH, no shell, bounded. */
export function runClaude(bin, args) {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Register (or replace) the server. Returns `{ok, error}`; never throws.
 *
 * `add-json` refuses a name that exists, so the previous entry is removed
 * first; a remove that finds nothing is the ordinary first-run case.
 */
export function registerRagServer({ config, run = runClaude, claudeBin = 'claude' }) {
  try {
    run(claudeBin, ['mcp', 'remove', '-s', SCOPE, SERVER_NAME]);
    const added = run(claudeBin, ['mcp', 'add-json', '-s', SCOPE, SERVER_NAME, JSON.stringify(config)]);
    if (added.status !== 0) {
      return { ok: false, error: `claude mcp add-json failed: ${scrub(added.stderr || added.stdout, config)}` };
    }
    return { ok: true, error: '' };
  } catch (err) {
    return { ok: false, error: `could not run ${claudeBin} (${err?.code || err?.message}); is Claude Code installed?` };
  }
}

/** The CLI may echo its input; nothing from the env block reaches a log verbatim. */
function scrub(text, config) {
  let out = String(text ?? '').trim().slice(0, 400);
  for (const value of Object.values(config.env)) out = out.split(value).join('[REDACTED]');
  return out.replace(/postgres(?:ql)?:\/\/\S+/g, 'postgresql://[REDACTED]');
}
