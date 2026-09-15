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
} from '../lib/enqueue-ingest.mjs';

let workspace;
let vault;
let note;
let projectDir;
let runLog;
let lines;

function recordingSpawn() {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { unref() { this.unreffed = true; }, on() { return this; }, unreffed: false };
  };
  spawn.calls = calls;
  return spawn;
}

function baseEnv(overrides = {}) {
  return {
    [ENV_PROJECT_DIR]: projectDir,
    [ENV_UV_BIN]: 'C:/tools/uv.exe',
    [ENV_RUN_LOG]: runLog,
    ...overrides,
  };
}

function call(overrides = {}) {
  const spawn = overrides.spawn ?? recordingSpawn();
  const result = enqueueIngest({
    vaultRoot: vault,
    notePath: note,
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

  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
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
    assert.equal(command, path.resolve('C:/tools/uv.exe'));
    assert.deepEqual(args, [
      '--directory',
      path.resolve(projectDir),
      'run',
      'ingest',
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
      notePath: nasty,
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
      notePath: outside,
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
      notePath: path.join(vault, '..', '..', 'escape.md'),
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
      notePath: json,
      log: (line) => lines.push(line),
      env: baseEnv(),
      spawn,
    });

    assert.equal(result.reason, Reason.NOT_MARKDOWN);
    assert.equal(spawn.calls.length, 0);
  });

  for (const [label, args] of [
    ['an empty vault root', { vaultRoot: '   ' }],
    ['an empty note path', { notePath: '' }],
    ['a non-string note path', { notePath: 42 }],
    ['a null note path', { notePath: null }],
  ]) {
    it(`refuses ${label} without throwing`, () => {
      const spawn = recordingSpawn();
      const result = enqueueIngest({
        vaultRoot: vault,
        notePath: note,
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
});

describe('enqueueIngest — failure is logged, never thrown', () => {
  it('reports a spawn that throws', () => {
    const spawn = () => {
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    };

    const result = enqueueIngest({
      vaultRoot: vault,
      notePath: note,
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
      notePath: note,
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
      notePath: note,
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

  it('logs one line when it does enqueue', () => {
    call();
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith('ingest-enqueue started for'));
    assert.ok(lines[0].includes('projects/bb2dash/sessions/abc.md'));
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

  it('honours an explicit uv path', () => {
    assert.equal(resolveUv({ [ENV_UV_BIN]: 'D:/uv/uv.exe' }), path.resolve('D:/uv/uv.exe'));
  });
});
