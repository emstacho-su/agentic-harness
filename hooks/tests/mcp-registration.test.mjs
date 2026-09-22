/**
 * Registering the `rag` MCP server from the machine's own configuration.
 *
 * Nothing here runs `claude`: the runner is injected, so the tests assert the
 * exact argument arrays and every refusal without touching ~/.claude.json.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRagServerConfig, registerRagServer } from '../lib/mcp-registration.mjs';

const NODE = 'C:/Users/x/AppData/Local/node/node.exe';
const DIST = 'C:/Users/x/agentic-harness/mcp-server/dist/index.js';

function fakeRunner(results = {}) {
  const calls = [];
  const run = (bin, args) => {
    calls.push([bin, ...args]);
    const key = args.slice(0, 2).join(' ');
    return results[key] ?? { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('the config carries only the variables the server reads, and only when set', () => {
  const config = buildRagServerConfig({
    node: NODE,
    distIndex: DIST,
    env: { DATABASE_URL: 'postgresql://u:p@h/db', DATABASE_CA_CERT: 'C:/ca.crt', UNRELATED: 'x', DATABASE_SSL: '' },
  });
  assert.deepEqual(config, {
    type: 'stdio',
    command: NODE,
    args: [DIST],
    env: { DATABASE_URL: 'postgresql://u:p@h/db', DATABASE_CA_CERT: 'C:/ca.crt' },
  });
});

test('no DATABASE_URL means nothing to register', () => {
  assert.throws(() => buildRagServerConfig({ node: NODE, distIndex: DIST, env: {} }), /DATABASE_URL/);
});

test('registration removes any previous user-scope entry, then adds the new one', () => {
  const { run, calls } = fakeRunner();
  const config = buildRagServerConfig({ node: NODE, distIndex: DIST, env: { DATABASE_URL: 'postgresql://u:p@h/db' } });
  const result = registerRagServer({ config, run, claudeBin: 'claude' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ['claude', 'mcp', 'remove', '-s', 'user', 'rag']);
  assert.deepEqual(calls[1].slice(0, 6), ['claude', 'mcp', 'add-json', '-s', 'user', 'rag']);
  assert.deepEqual(JSON.parse(calls[1][6]), config);
});

test('a remove that finds nothing is fine; an add that fails is not', () => {
  const { run } = fakeRunner({
    'mcp remove': { status: 1, stdout: '', stderr: 'No MCP server found with name: rag' },
    'mcp add-json': { status: 1, stdout: '', stderr: 'boom' },
  });
  const config = buildRagServerConfig({ node: NODE, distIndex: DIST, env: { DATABASE_URL: 'postgresql://u:p@h/db' } });
  const result = registerRagServer({ config, run, claudeBin: 'claude' });
  assert.equal(result.ok, false);
  assert.match(result.error, /boom/);
});

test('a runner that throws (claude not installed) is a refusal, not a crash', () => {
  const run = () => {
    throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  };
  const config = buildRagServerConfig({ node: NODE, distIndex: DIST, env: { DATABASE_URL: 'postgresql://u:p@h/db' } });
  const result = registerRagServer({ config, run, claudeBin: 'claude' });
  assert.equal(result.ok, false);
  assert.match(result.error, /claude/);
});

test('the error never carries the connection string', () => {
  const { run } = fakeRunner({
    'mcp add-json': { status: 1, stdout: '', stderr: 'rejected postgresql://u:p@h/db' },
  });
  const config = buildRagServerConfig({ node: NODE, distIndex: DIST, env: { DATABASE_URL: 'postgresql://u:p@h/db' } });
  const result = registerRagServer({ config, run, claudeBin: 'claude' });
  assert.ok(!result.error.includes('u:p@h'));
});
