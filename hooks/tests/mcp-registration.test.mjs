/**
 * Registering the `rag` MCP server from the machine's own configuration.
 *
 * Nothing here runs `claude`: the runner is injected, so the tests assert the
 * exact argument arrays and every refusal without touching ~/.claude.json.
 * The one rule that matters most: the connection string never enters the
 * registration, because `claude mcp get` prints the env block in clear text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ENV_FILE_VAR, buildRagServerConfig, registerRagServer } from '../lib/mcp-registration.mjs';

const NODE = 'C:/Users/x/AppData/Local/node/node.exe';
const DIST = 'C:/Users/x/agentic-harness/mcp-server/dist/index.js';
const ENV_FILE = 'C:/Users/x/agentic-harness/.env';
const SECRET = 'postgresql://u:hunter2hunter2@h/db';

const merged = (extra = {}) => ({ DATABASE_URL: SECRET, ...extra });

function fakeRunner(results = {}) {
  const calls = [];
  const run = (bin, args) => {
    calls.push([bin, ...args]);
    const key = args.slice(0, 2).join(' ');
    return results[key] ?? { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('the registration names the secrets file and never carries the connection string', () => {
  const config = buildRagServerConfig({
    node: NODE,
    distIndex: DIST,
    envFile: ENV_FILE,
    env: merged({ DATABASE_CA_CERT: 'C:/ca.crt', UNRELATED: 'x', DATABASE_SSL: '' }),
  });
  assert.deepEqual(config, {
    type: 'stdio',
    command: NODE,
    args: [DIST],
    env: { [ENV_FILE_VAR]: ENV_FILE, DATABASE_CA_CERT: 'C:/ca.crt' },
  });
  assert.ok(!JSON.stringify(config).includes('hunter2'));
  assert.ok(!('DATABASE_URL' in config.env));
});

test('no DATABASE_URL anywhere means nothing to register', () => {
  assert.throws(() => buildRagServerConfig({ node: NODE, distIndex: DIST, envFile: ENV_FILE, env: {} }), /DATABASE_URL/);
});

test('registration removes any previous user-scope entry, then adds the new one', () => {
  const { run, calls } = fakeRunner();
  const config = buildRagServerConfig({ node: NODE, distIndex: DIST, envFile: ENV_FILE, env: merged() });
  const result = registerRagServer({ config, run, claudeBin: 'claude' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ['claude', 'mcp', 'remove', '-s', 'user', 'rag']);
  assert.deepEqual(calls[1].slice(0, 6), ['claude', 'mcp', 'add-json', '-s', 'user', 'rag']);
  assert.deepEqual(JSON.parse(calls[1][6]), config);
  assert.ok(!calls[1][6].includes('hunter2'));
});

test('a remove that finds nothing is fine; an add that fails is not', () => {
  const { run } = fakeRunner({
    'mcp remove': { status: 1, stdout: '', stderr: 'No MCP server found with name: rag' },
    'mcp add-json': { status: 1, stdout: '', stderr: 'boom' },
  });
  const config = buildRagServerConfig({ node: NODE, distIndex: DIST, envFile: ENV_FILE, env: merged() });
  const result = registerRagServer({ config, run, claudeBin: 'claude' });
  assert.equal(result.ok, false);
  assert.match(result.error, /boom/);
});

test('a runner that throws (claude not installed) is a refusal, not a crash', () => {
  const run = () => {
    throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  };
  const config = buildRagServerConfig({ node: NODE, distIndex: DIST, envFile: ENV_FILE, env: merged() });
  const result = registerRagServer({ config, run, claudeBin: 'claude' });
  assert.equal(result.ok, false);
  assert.match(result.error, /claude/);
});

test('an error the CLI echoes a connection string into is scrubbed', () => {
  const { run } = fakeRunner({
    'mcp add-json': { status: 1, stdout: '', stderr: `rejected ${SECRET} for some reason` },
  });
  const config = buildRagServerConfig({ node: NODE, distIndex: DIST, envFile: ENV_FILE, env: merged() });
  const result = registerRagServer({ config, run, claudeBin: 'claude' });
  assert.ok(!result.error.includes('hunter2'));
  assert.match(result.error, /REDACTED/);
});
