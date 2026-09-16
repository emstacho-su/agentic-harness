/**
 * `node --test hooks/tests/`
 *
 * Nothing here starts a real process: `spawn` is injected, so the tests assert
 * the exact argument array, the detach flags and every refusal path without
 * ever loading the embedding model.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  DEFAULT_PROJECT_DIR,
  ENV_ENABLED,
  ENV_PROJECT_DIR,
  ENV_RUN_LOG,
  ENV_UV_BIN,
  Reason,
  enqueueIngest,
  resolveProjectDir,
  resolveRunLog,
  resolveUv,
  ingestEntry,
  WINDOWLESS_ENTRY,
} from '../lib/enqueue-ingest.mjs';

let workspace;
let vault;
let note;
let projectDir;
let runLog;
let uvBin;
let lines;

/** The name a real `uv` has on this platform. */
const UV_EXECUTABLE = process.platform === 'win32' ? 'uv.exe' : 'uv';

/**
 * A stand-in for ChildProcess. `pid` is part of it because the enqueue reads
 * `pid` to tell a spawn that was accepted from one that failed synchronously,
 * and a fake without it would hide exactly that check.
 */
function recordingSpawn(overrides = {}) {
  // `'pid' in overrides`, not a default parameter: a default would turn an
  // explicit `pid: undefined` — the shape this is here to model — back into a
  // number, and the test would pass without exercising anything.
  const pid = 'pid' in overrides ? overrides.pid : 4242;
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { pid, unref() { this.unreffed = true; }, on() { return this; }, unreffed: false };
  };
  spawn.calls = calls;
  return spawn;
}

function baseEnv(overrides = {}) {
  return {
    [ENV_PROJECT_DIR]: projectDir,
    [ENV_UV_BIN]: uvBin,
    [ENV_RUN_LOG]: runLog,
    ...overrides,
  };
}

function call(overrides = {}) {
  const spawn = overrides.spawn ?? recordingSpawn();
  const result = enqueueIngest({
    vaultRoot: vault,
    notePaths: [note],
    log: (line) => lines.push(line),
    env: baseEnv(overrides.env),
    spawn,
    ...(overrides.args ?? {}),
  });
  return { result, spawn };
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'enqueue-'));
  vault = path.join(workspace, 'vault');
  projectDir = path.join(workspace, 'ingest');
  runLog = path.join(workspace, 'logs', 'ingest-on-capture.log');
  note = path.join(vault, 'projects', 'bb2dash', 'sessions', 'abc.md');

  uvBin = path.join(workspace, 'bin', UV_EXECUTABLE);

  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.dirname(uvBin), { recursive: true });
  // A real file: HARNESS_UV_BIN is checked for existence like every other
  // candidate, so a made-up path is refused rather than spawned.
  fs.writeFileSync(uvBin, '', 'utf8');
  fs.writeFileSync(note, '---\ntype: session\n---\n\nbody\n', 'utf8');
  lines = [];
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('enqueueIngest — the command it builds', () => {
  it('runs uv with the single-note ingest arguments', () => {
    const { result, spawn } = call();

    assert.equal(result.enqueued, true);
    assert.equal(result.reason, Reason.ENQUEUED);
    assert.equal(spawn.calls.length, 1);

    const { command, args } = spawn.calls[0];
    assert.equal(command, path.resolve(uvBin));
    assert.deepEqual(args, [
      '--directory',
      path.resolve(projectDir),
      'run',
      ...ingestEntry(process.platform),
      '--source',
      'obsidian',
      '--path',
      path.resolve(vault),
      '--only',
      path.resolve(note),
    ]);
  });

  it('never hands spawn a bare command name', () => {
    // On Windows libuv resolves a bare name against the child's cwd BEFORE
    // PATH, so a uv.exe dropped in the project directory would win.
    const { spawn } = call();
    assert.ok(path.isAbsolute(spawn.calls[0].command));
  });

  it('passes the project with --directory instead of spawning with cwd', () => {
    const { spawn } = call();
    assert.equal(spawn.calls[0].options.cwd, undefined);
    assert.equal(spawn.calls[0].args[0], '--directory');
    assert.equal(spawn.calls[0].args[1], path.resolve(projectDir));
  });

  it('passes the note as one argument, never as shell text', () => {
    const { spawn } = call();
    const { args, options } = spawn.calls[0];

    assert.equal(options.shell, false);
    assert.equal(args.filter((value) => value === path.resolve(note)).length, 1);
  });

  it('survives a note path holding shell metacharacters', () => {
    const nasty = path.join(vault, 'projects', 'x', 'sessions', 'a b & rm -rf $(x) `y`.md');
    fs.mkdirSync(path.dirname(nasty), { recursive: true });
    fs.writeFileSync(nasty, 'body', 'utf8');

    const spawn = recordingSpawn();
    const result = enqueueIngest({
      vaultRoot: vault,
      notePaths: [nasty],
      log: (line) => lines.push(line),
      env: baseEnv(),
      spawn,
    });

    assert.equal(result.enqueued, true);
    assert.equal(spawn.calls[0].options.shell, false);
    assert.equal(spawn.calls[0].args.at(-1), path.resolve(nasty));
  });

  it('refuses when uv cannot be found anywhere', () => {
    const { result, spawn } = call({
      env: {
        [ENV_UV_BIN]: '',
        USERPROFILE: path.join(workspace, 'nohome'),
        HOME: path.join(workspace, 'nohome'),
        PATH: path.join(workspace, 'empty'),
      },
    });

    assert.equal(result.enqueued, false);
    assert.equal(result.reason, Reason.NO_UV);
    assert.equal(spawn.calls.length, 0);
    assert.ok(lines.some((line) => line.includes(ENV_UV_BIN)));
  });
});

describe('enqueueIngest — detachment', () => {
  it('uses the windowless interpreter on Windows and the project script elsewhere', () => {
    assert.deepEqual(ingestEntry('win32'), [...WINDOWLESS_ENTRY]);
    assert.deepEqual(ingestEntry('linux'), ['ingest']);
    assert.deepEqual(ingestEntry('darwin'), ['ingest']);

    const { spawn } = call({ args: { platform: 'win32' } });
    const argv = spawn.calls[0].args;
    assert.ok(argv.includes('pythonw'), 'a detached console child would open a visible window');
    assert.ok(!argv.includes('ingest'), 'the console launcher must not be used on Windows');
    assert.equal(argv.indexOf('--only'), argv.length - 2, 'the note stays the last argument');
  });

  it('detaches, hides the window and unrefs the child', () => {
    const { spawn } = call();
    const { options } = spawn.calls[0];

    assert.equal(options.detached, true);
    assert.equal(options.windowsHide, true);
  });

  it('sends the child stdout and stderr to the run log, not to a pipe', () => {
    const { result, spawn } = call();
    const { options } = spawn.calls[0];

    assert.equal(options.stdio[0], 'ignore');
    assert.equal(typeof options.stdio[1], 'number');
    assert.equal(options.stdio[1], options.stdio[2]);
    assert.equal(result.runLog, path.resolve(runLog));
    assert.ok(fs.existsSync(runLog));
  });

  it('disables the kill switch inside the child so it cannot recurse', () => {
    const { spawn } = call();
    assert.equal(spawn.calls[0].options.env[ENV_ENABLED], '0');
  });

  it('costs well under the hook budget', () => {
    const started = Date.now();
    call();
    assert.ok(Date.now() - started < 100, 'enqueue must cost under 100 ms');
  });
});

describe('enqueueIngest — the kill switch', () => {
  for (const value of ['0', 'false', 'off', 'no', 'OFF']) {
    it(`does nothing when ${ENV_ENABLED}=${value}`, () => {
      const { result, spawn } = call({ env: { [ENV_ENABLED]: value } });

      assert.equal(result.enqueued, false);
      assert.equal(result.reason, Reason.DISABLED);
      assert.equal(spawn.calls.length, 0);
    });
  }

  it('stays on when the variable is unset or empty', () => {
    assert.equal(call({ env: { [ENV_ENABLED]: '' } }).result.enqueued, true);
    assert.equal(call().result.enqueued, true);
  });

  it('stays on for any other value', () => {
    assert.equal(call({ env: { [ENV_ENABLED]: '1' } }).result.enqueued, true);
  });
});

describe('enqueueIngest — input validation at the boundary', () => {
  it('refuses a note outside the vault', () => {
    const outside = path.join(workspace, 'elsewhere.md');
    fs.writeFileSync(outside, 'body', 'utf8');

    const spawn = recordingSpawn();
    const result = enqueueIngest({
      vaultRoot: vault,
      notePaths: [outside],
      log: (line) => lines.push(line),
      env: baseEnv(),
      spawn,
    });

    assert.equal(result.reason, Reason.OUTSIDE_VAULT);
    assert.equal(spawn.calls.length, 0);
    assert.ok(lines.some((line) => line.includes('outside')));
  });

  it('refuses a traversal out of the vault', () => {
    const spawn = recordingSpawn();
    const result = enqueueIngest({
      vaultRoot: vault,
      notePaths: [path.join(vault, '..', '..', 'escape.md')],
      log: (line) => lines.push(line),
      env: baseEnv(),
      spawn,
    });

    assert.equal(result.reason, Reason.OUTSIDE_VAULT);
    assert.equal(spawn.calls.length, 0);
  });

  it('refuses a non-markdown file', () => {
    const json = path.join(vault, 'data.json');
    fs.writeFileSync(json, '{}', 'utf8');

    const spawn = recordingSpawn();
    const result = enqueueIngest({
      vaultRoot: vault,
      notePaths: [json],
      log: (line) => lines.push(line),
      env: baseEnv(),
      spawn,
    });

    assert.equal(result.reason, Reason.NOT_MARKDOWN);
    assert.equal(spawn.calls.length, 0);
  });

  for (const [label, args] of [
    ['an empty vault root', { vaultRoot: '   ' }],
    ['an empty note path', { notePaths: [''] }],
    ['a non-string note path', { notePaths: [42] }],
    ['a null note path', { notePaths: [null] }],
    ['a note path that is not an array', { notePaths: 'one/note.md' }],
    ['no note paths at all', { notePaths: undefined }],
  ]) {
    it(`refuses ${label} without throwing`, () => {
      const spawn = recordingSpawn();
      const result = enqueueIngest({
        vaultRoot: vault,
        notePaths: [note],
        log: (line) => lines.push(line),
        env: baseEnv(),
        spawn,
        ...args,
      });

      assert.equal(result.enqueued, false);
      assert.equal(result.reason, Reason.BAD_ARGUMENTS);
      assert.equal(spawn.calls.length, 0);
    });
  }

  it('refuses when the ingest project directory does not exist', () => {
    const { result, spawn } = call({ env: { [ENV_PROJECT_DIR]: path.join(workspace, 'gone') } });

    assert.equal(result.reason, Reason.NO_PROJECT);
    assert.equal(spawn.calls.length, 0);
    assert.ok(lines.some((line) => line.includes(ENV_PROJECT_DIR)));
  });

  it('never throws when called with nothing at all', () => {
    const result = enqueueIngest();
    assert.equal(result.enqueued, false);
  });

  it('an empty list is nothing to do, not a bad argument', () => {
    // The capture ran and found the note on disk already byte-identical to what
    // it would have written. Nothing changed, so there is nothing to ingest.
    const { result, spawn } = call({ args: { notePaths: [] } });

    assert.equal(result.enqueued, false);
    assert.equal(result.reason, Reason.NOTHING_TO_DO);
    assert.equal(spawn.calls.length, 0);
    assert.ok(lines.some((line) => line.includes('no note changed on disk')));
  });
});

describe('enqueueIngest — more than one note in one process', () => {
  /** A second note beside the first, as a resume or a SubagentStop produces. */
  function secondNote(name = 'def.md') {
    const target = path.join(path.dirname(note), name);
    fs.writeFileSync(target, 'body', 'utf8');
    return target;
  }

  it('passes every note as its own --only, in one spawn', () => {
    const other = secondNote();
    const { result, spawn } = call({ args: { notePaths: [note, other] } });

    assert.equal(result.enqueued, true);
    assert.equal(spawn.calls.length, 1, 'one process, so the model loads once');
    assert.deepEqual(spawn.calls[0].args.slice(-4), [
      '--only',
      path.resolve(note),
      '--only',
      path.resolve(other),
    ]);
  });

  it('names every note in the one log line', () => {
    const other = secondNote();
    call({ args: { notePaths: [note, other] } });

    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('sessions/abc.md'), lines[0]);
    assert.ok(lines[0].includes('sessions/def.md'), lines[0]);
  });

  it('ingests a note named twice only once', () => {
    const { spawn } = call({ args: { notePaths: [note, note] } });

    const only = spawn.calls[0].args.filter((value) => value === '--only');
    assert.equal(only.length, 1);
  });

  it('drops one unusable path without costing the others their ingest', () => {
    const outside = path.join(workspace, 'elsewhere.md');
    fs.writeFileSync(outside, 'body', 'utf8');

    const { result, spawn } = call({ args: { notePaths: [outside, note] } });

    assert.equal(result.enqueued, true);
    assert.deepEqual(spawn.calls[0].args.slice(-2), ['--only', path.resolve(note)]);
    assert.ok(lines.some((line) => line.includes('outside')), lines.join('\n'));
  });

  it('refuses with the first reason when no path survives', () => {
    const outside = path.join(workspace, 'elsewhere.md');
    const json = path.join(vault, 'data.json');
    fs.writeFileSync(outside, 'body', 'utf8');
    fs.writeFileSync(json, '{}', 'utf8');

    const { result, spawn } = call({ args: { notePaths: [outside, json] } });

    assert.equal(result.enqueued, false);
    assert.equal(result.reason, Reason.OUTSIDE_VAULT);
    assert.equal(spawn.calls.length, 0);
  });
});

describe('enqueueIngest — failure is logged, never thrown', () => {
  it('reports a spawn that throws', () => {
    const spawn = () => {
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    };

    const result = enqueueIngest({
      vaultRoot: vault,
      notePaths: [note],
      log: (line) => lines.push(line),
      env: baseEnv(),
      spawn,
    });

    assert.equal(result.enqueued, false);
    assert.equal(result.reason, Reason.SPAWN_FAILED);
    assert.ok(lines.some((line) => line.includes('ENOENT')));
  });

  it('releases the run-log descriptor when the spawn throws', () => {
    enqueueIngest({
      vaultRoot: vault,
      notePaths: [note],
      log: (line) => lines.push(line),
      env: baseEnv(),
      spawn: () => {
        throw new Error('boom');
      },
    });

    // A leaked descriptor is invisible until something else needs the file, so
    // the check is that the very next enqueue still opens and uses the log.
    const { result, spawn } = call();
    assert.equal(result.enqueued, true);
    assert.equal(typeof spawn.calls[0].options.stdio[1], 'number');
    assert.ok(fs.existsSync(runLog));
  });

  it('survives a logger that throws', () => {
    const result = enqueueIngest({
      vaultRoot: vault,
      notePaths: [note],
      log: () => {
        throw new Error('log is read-only');
      },
      env: baseEnv(),
      spawn: recordingSpawn(),
    });

    assert.equal(result.enqueued, true);
  });

  it('still enqueues when the run log cannot be opened', () => {
    const { result, spawn } = call({
      // A path whose parent is a file, so mkdir and open both fail.
      env: { [ENV_RUN_LOG]: path.join(note, 'nested', 'run.log') },
    });

    assert.equal(result.enqueued, true);
    assert.equal(spawn.calls[0].options.stdio, 'ignore');
  });

  it('logs one line when it does enqueue, and claims only that it asked', () => {
    // "started" was a claim this process cannot make: a child that fails to
    // start reports it through an asynchronous 'error' event, and the hook
    // calls process.exit(0) before the next tick ever runs.
    call();
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith('ingest-enqueue spawn requested for'), lines[0]);
    assert.ok(lines[0].includes('projects/bb2dash/sessions/abc.md'));
    assert.match(lines[0], /\(pid=\d+\)$/);
  });

  it('reports a spawn that came back without a pid', () => {
    // libuv leaves pid undefined when the process could not be created at all.
    const { result } = call({ spawn: recordingSpawn({ pid: undefined }) });

    assert.equal(result.enqueued, false);
    assert.equal(result.reason, Reason.SPAWN_FAILED);
    assert.ok(lines.some((line) => line.includes('no pid')), lines.join('\n'));
    assert.ok(!lines.some((line) => line.includes('spawn requested')));
  });

  it('refuses before spawning when the configured uv is gone', () => {
    const { result, spawn } = call({
      env: { [ENV_UV_BIN]: path.join(workspace, 'gone', UV_EXECUTABLE) },
    });

    assert.equal(result.enqueued, false);
    assert.equal(result.reason, Reason.NO_UV);
    assert.equal(spawn.calls.length, 0);
  });
});

describe('enqueueIngest — resolution without hardcoded paths', () => {
  it('defaults the project directory to the main checkout, not a worktree', () => {
    assert.equal(resolveProjectDir({}), DEFAULT_PROJECT_DIR);
    assert.ok(DEFAULT_PROJECT_DIR.endsWith(path.join('agentic-harness', 'ingest')));
    assert.ok(!DEFAULT_PROJECT_DIR.includes('-wt-'));
  });

  it('lets the environment override the project directory', () => {
    assert.equal(resolveProjectDir({ [ENV_PROJECT_DIR]: projectDir }), path.resolve(projectDir));
  });

  it('defaults the run log beside the hook log', () => {
    const target = resolveRunLog({});
    assert.ok(target.includes(path.join('.claude', 'hooks')));
    assert.ok(target.endsWith('ingest-on-capture.log'));
  });

  const noHome = () => ({
    USERPROFILE: path.join(workspace, 'nohome'),
    HOME: path.join(workspace, 'nohome'),
  });

  it('resolves uv to an absolute path or to null, never to a bare name', () => {
    const resolved = resolveUv({});
    assert.ok(resolved === null || path.isAbsolute(resolved));
    assert.notEqual(resolved, 'uv');
  });

  it('finds uv on PATH and returns it absolute', () => {
    const binDir = path.join(workspace, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const executable = process.platform === 'win32' ? 'uv.exe' : 'uv';
    fs.writeFileSync(path.join(binDir, executable), '', 'utf8');

    const resolved = resolveUv({
      ...noHome(),
      PATH: `${path.join(workspace, 'nope')}${path.delimiter}${binDir}`,
    });
    assert.equal(resolved, path.join(binDir, executable));
  });

  it('prefers the standalone install over PATH', () => {
    const home = path.join(workspace, 'home');
    const executable = process.platform === 'win32' ? 'uv.exe' : 'uv';
    const standalone = path.join(home, '.local', 'bin', executable);
    fs.mkdirSync(path.dirname(standalone), { recursive: true });
    fs.writeFileSync(standalone, '', 'utf8');

    assert.equal(resolveUv({ USERPROFILE: home, HOME: home, PATH: '' }), standalone);
  });

  it('returns null when PATH holds no uv', () => {
    assert.equal(resolveUv({ ...noHome(), PATH: path.join(workspace, 'nope') }), null);
  });

  it('ignores an empty or quoted PATH entry rather than resolving relative', () => {
    const resolved = resolveUv({ ...noHome(), PATH: `${path.delimiter}""${path.delimiter}` });
    assert.equal(resolved, null);
  });

  it('honours an explicit uv path that exists', () => {
    assert.equal(resolveUv({ [ENV_UV_BIN]: uvBin }), path.resolve(uvBin));
  });

  it('refuses an explicit uv path that does not exist', () => {
    // Returned unchecked, a stale override produced a log line claiming an
    // ingest had started for a spawn that could only ever fail.
    assert.equal(
      resolveUv({ [ENV_UV_BIN]: path.join(workspace, 'gone', UV_EXECUTABLE) }),
      null,
    );
  });
});
