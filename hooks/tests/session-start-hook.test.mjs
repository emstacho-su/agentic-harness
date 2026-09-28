/**
 * R-H4: the SessionStart hook as Claude Code runs it. Whatever happens, the
 * answer is one valid JSON document on stdout and exit 0: a brief when one
 * could be built in time, an empty `additionalContext` otherwise. The log gets
 * the reason and the input's key names, never a value and never the brief.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { STATE_DIR_ENV_VAR, readSessionStartRecord } from '../lib/session-start.mjs';
import { LOG_ENV_VAR as START_LOG_ENV_VAR, DISABLE_ENV_VAR as START_DISABLE_ENV_VAR, SESSION_START_EVENT } from '../lib/start-brief.mjs';
import { EMPTY_OUTPUT, run } from '../session-start.mjs';
import { createSandbox } from './helpers/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, '..', 'session-start.mjs');
const SESSION = '5e551011-0000-4000-8000-000000000001';

function setup(t) {
  const sandbox = createSandbox();
  t.after(() => sandbox.cleanup());
  const vault = sandbox.vaultRoot;
  fs.mkdirSync(path.join(vault, 'harness', 'agentic-harness', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'harness', '.realm'), 'harness\n', 'utf8');
  fs.writeFileSync(
    path.join(vault, 'harness', 'agentic-harness', 'status.md'),
    "---\nid: 'status-agentic-harness'\ntype: status\n---\n\n# Status\n\n- BRIEF-BODY-MARKER R-H4 in progress\n",
    'utf8',
  );
  const stateDir = path.join(sandbox.root, 'state', 'session-start');
  const env = {
    HARNESS_VAULT: vault,
    [STATE_DIR_ENV_VAR]: path.join(sandbox.root, 'state'),
    HARNESS_MACHINE_ENV: path.join(sandbox.root, 'absent-machine.env'),
  };
  return { sandbox, vault, stateDir, env };
}

function payload(sandbox, overrides = {}) {
  return JSON.stringify({
    session_id: SESSION,
    transcript_path: `${sandbox.root}/projects/fixture/${SESSION}.jsonl`,
    cwd: `${sandbox.root}/repos/agentic-harness`,
    hook_event_name: 'SessionStart',
    ...overrides,
  });
}

function collectLog() {
  const lines = [];
  const log = (line) => lines.push(line);
  return { log, lines, text: () => lines.join('\n') };
}

function context(stdout) {
  const parsed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.equal(parsed.hookSpecificOutput.hookEventName, SESSION_START_EVENT);
  assert.equal(typeof parsed.hookSpecificOutput.additionalContext, 'string');
  return parsed.hookSpecificOutput.additionalContext;
}

test('EMPTY_OUTPUT is the valid empty answer', () => {
  assert.equal(context(EMPTY_OUTPUT), '');
});

test('happy path: the brief goes out, the SC-2 record round-trips to one SC-1 entry', async (t) => {
  const { sandbox, stateDir, env } = setup(t);
  const logged = collectLog();
  const result = await run({ raw: payload(sandbox), env, home: path.join(sandbox.root, 'home'), log: logged.log, stateDir });

  const brief = context(result.stdout);
  assert.match(brief, /BRIEF-BODY-MARKER/);
  assert.match(brief, /collection: "agentic-harness"/);

  const { record, reason } = readSessionStartRecord({ sessionId: SESSION, stateDir, env: {} });
  assert.equal(reason, 'ok');
  assert.equal(record.channel, 'session-start');
  assert.deepEqual(record.results, ['obsidian:status-agentic-harness']);
  assert.equal(record.filters.source, 'status');
  assert.equal(record.filters.realm, 'harness');
  assert.equal(record.filters.collection, 'agentic-harness');
  assert.ok(record.filters.tokens > 0);

  assert.doesNotMatch(logged.text(), /BRIEF-BODY-MARKER/, 'the brief never reaches the log');
  assert.match(logged.text(), /harness\/agentic-harness source=status/);
});

test('the input\'s key names are logged once, sorted, and never a value', async (t) => {
  const { sandbox, stateDir, env } = setup(t);
  const logged = collectLog();
  const raw = payload(sandbox, { startup_reason: 'VALUE-XYZ', 'bad\nkey': 'x', source: 'resume' });
  await run({ raw, env, home: path.join(sandbox.root, 'home'), log: logged.log, stateDir });

  const keyLines = logged.lines.filter((line) => line.startsWith('debug input-keys:'));
  assert.equal(keyLines.length, 1);
  assert.equal(keyLines[0], 'debug input-keys: cwd,hook_event_name,session_id,source,startup_reason,transcript_path (+1 unprintable)');
  assert.doesNotMatch(logged.text(), /VALUE-XYZ|resume/);
});

test('a build that does not finish before the deadline yields the empty answer', async (t) => {
  const { sandbox, stateDir, env } = setup(t);
  const logged = collectLog();
  const never = () => new Promise(() => {});
  const result = await run({ raw: payload(sandbox), env, home: path.join(sandbox.root, 'home'), log: logged.log, stateDir, timeoutMs: 20, build: never });
  assert.equal(result.stdout, EMPTY_OUTPUT);
  assert.match(logged.text(), /empty: timeout/);
  assert.equal(fs.existsSync(path.join(stateDir, `${SESSION}.json`)), false, 'nothing injected, nothing recorded');
});

test('a build that trips the injected clock is a timeout too', async (t) => {
  const { sandbox, stateDir, env } = setup(t);
  const logged = collectLog();
  let clock = 0;
  const io = {
    readText: async (file) => {
      clock += 5000;
      return fs.promises.readFile(file, 'utf8').catch(() => null);
    },
    listDir: (dir) => fs.promises.readdir(dir),
    isDirectory: async () => true,
  };
  const result = await run({ raw: payload(sandbox), env, home: path.join(sandbox.root, 'home'), log: logged.log, stateDir, now: () => clock, io });
  assert.equal(result.stdout, EMPTY_OUTPUT);
  assert.match(logged.text(), /empty: timeout/);
});

test('a thrown error yields the empty answer, and its message stays out of the log', async (t) => {
  const { sandbox, stateDir, env } = setup(t);
  const logged = collectLog();
  const boom = async () => {
    throw new TypeError('SECRET-BRIEF-TEXT leaked');
  };
  const result = await run({ raw: payload(sandbox), env, home: path.join(sandbox.root, 'home'), log: logged.log, stateDir, build: boom });
  assert.equal(result.stdout, EMPTY_OUTPUT);
  assert.match(logged.text(), /empty: error TypeError/);
  assert.doesNotMatch(logged.text(), /SECRET-BRIEF-TEXT/);
});

test('stdin that is not a JSON object, or has no cwd, yields the empty answer', async (t) => {
  const { stateDir, env, sandbox } = setup(t);
  for (const raw of ['', 'not json', '[1,2]', JSON.stringify({ session_id: SESSION })]) {
    const logged = collectLog();
    const result = await run({ raw, env, home: path.join(sandbox.root, 'home'), log: logged.log, stateDir });
    assert.equal(result.stdout, EMPTY_OUTPUT, raw);
    assert.match(logged.text(), /empty: /);
  }
});

test('a session id that is not a UUID still gets its brief; only the record is skipped', async (t) => {
  const { sandbox, stateDir, env } = setup(t);
  const logged = collectLog();
  const result = await run({ raw: payload(sandbox, { session_id: 'not-a-uuid' }), env, home: path.join(sandbox.root, 'home'), log: logged.log, stateDir });
  assert.match(context(result.stdout), /BRIEF-BODY-MARKER/);
  assert.match(logged.text(), /record skipped: bad session id/);
  assert.equal(fs.existsSync(stateDir), false);
});

test('a record that cannot be written is logged and does not change the output', async (t) => {
  const { sandbox, env } = setup(t);
  const blocker = path.join(sandbox.root, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const logged = collectLog();
  const result = await run({ raw: payload(sandbox), env, home: path.join(sandbox.root, 'home'), log: logged.log, stateDir: path.join(blocker, 'session-start') });
  assert.match(context(result.stdout), /BRIEF-BODY-MARKER/);
  assert.match(logged.text(), /record skipped: write failed/);
});

test('the kill switch gives the empty answer', async (t) => {
  const { sandbox, stateDir, env } = setup(t);
  const logged = collectLog();
  const result = await run({ raw: payload(sandbox), env: { ...env, [START_DISABLE_ENV_VAR]: '0' }, home: path.join(sandbox.root, 'home'), log: logged.log, stateDir });
  assert.equal(result.stdout, EMPTY_OUTPUT);
});

// ------------------------------------------------------------------ the process

function spawnHook(input, env) {
  try {
    const stdout = execFileSync(process.execPath, [HOOK], { input, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
    return { status: 0, stdout };
  } catch (err) {
    return { status: typeof err?.status === 'number' ? err.status : 1, stdout: String(err?.stdout ?? '') };
  }
}

test('process: one JSON document on stdout, exit 0, the brief in it, a log line written', (t) => {
  const { sandbox, env, stateDir } = setup(t);
  const logPath = path.join(sandbox.root, 'session-start.log');
  const { status, stdout } = spawnHook(payload(sandbox), { ...env, [START_LOG_ENV_VAR]: logPath });
  assert.equal(status, 0);
  assert.match(context(stdout), /BRIEF-BODY-MARKER/);
  assert.ok(fs.existsSync(path.join(stateDir, `${SESSION}.json`)));
  const log = fs.readFileSync(logPath, 'utf8');
  assert.match(log, /debug input-keys: /);
  assert.match(log, / ms=\d+$/m);
  assert.doesNotMatch(log, /BRIEF-BODY-MARKER/);
});

test('process: garbage on stdin is still valid empty JSON and exit 0', (t) => {
  const { sandbox, env } = setup(t);
  const logPath = path.join(sandbox.root, 'session-start.log');
  const { status, stdout } = spawnHook('{{{ not json', { ...env, [START_LOG_ENV_VAR]: logPath });
  assert.equal(status, 0);
  assert.equal(stdout, EMPTY_OUTPUT);
});

// ------------------------------------------------------------------ a throw from outside run()

/**
 * Spawn the hook with a preload (`--import`) that injects a throw the hook's
 * own code never sees coming: before it has answered, or after. No test seam
 * in the hook itself; the preload is the only thing that differs.
 */
function spawnWithPreload(t, preloadSource, input, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-preload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, 'preload.mjs');
  fs.writeFileSync(preload, preloadSource, 'utf8');
  return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, HOOK], {
    input,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
}

test('process: an uncaught exception before the answer still writes the empty answer once, exit 0', (t) => {
  const { sandbox, env } = setup(t);
  const logPath = path.join(sandbox.root, 'session-start.log');
  const early = "setTimeout(() => { throw new Error('injected early throw'); }, 0);\n";
  const result = spawnWithPreload(t, early, payload(sandbox), { ...env, [START_LOG_ENV_VAR]: logPath });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, EMPTY_OUTPUT, 'exactly one JSON document, and it is the empty answer');
});

test('process: an unhandled rejection before the answer still writes the empty answer once, exit 0', (t) => {
  const { sandbox, env } = setup(t);
  const logPath = path.join(sandbox.root, 'session-start.log');
  const early = "setTimeout(() => { Promise.reject(new Error('injected early rejection')); }, 0);\n";
  const result = spawnWithPreload(t, early, payload(sandbox), { ...env, [START_LOG_ENV_VAR]: logPath });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, EMPTY_OUTPUT);
});

test('process: a throw after the answer is written never adds a second JSON document', (t) => {
  const { sandbox, env } = setup(t);
  const logPath = path.join(sandbox.root, 'session-start.log');
  // Throw right after the first write, while its callback (and so the exit) is held back.
  const late = [
    'const write = process.stdout.write.bind(process.stdout);',
    'process.stdout.write = (chunk, ...rest) => {',
    '  const callback = rest.find((arg) => typeof arg === "function");',
    '  const ok = write(chunk);',
    '  setImmediate(() => { throw new Error("injected late throw"); });',
    '  if (callback) setTimeout(callback, 200);',
    '  return ok;',
    '};',
    '',
  ].join('\n');
  const result = spawnWithPreload(t, late, payload(sandbox), { ...env, [START_LOG_ENV_VAR]: logPath });
  assert.equal(result.status, 0, result.stderr);
  assert.match(context(result.stdout), /BRIEF-BODY-MARKER/, 'the one document is the brief');
});
