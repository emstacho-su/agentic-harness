/**
 * The nightly transcript sweep: sessions the hook never saw become notes
 * through the same capture code, and live sessions are left alone.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CAPTURED_BY_SWEEP, SWEEP_EXCLUDED_CWD_SEGMENTS } from '../lib/constants.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';
import {
  excludedBy,
  indexNotedSessions,
  listCandidateTranscripts,
  readTranscriptHead,
  runSweep,
  sessionIdFromNoteName,
} from '../lib/sweep.mjs';
import { EXIT_OK, EXIT_USAGE, LOG_ENV_VAR, parseArgs } from '../sweep-transcripts.mjs';
import { createSandbox, installTranscript, noGit, readNote } from './helpers/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'sweep-transcripts.mjs');

const HOUR_MS = 60 * 60 * 1000;
const IDLE_MS = 6 * HOUR_MS;
const NOW = Date.parse('2026-09-17T03:00:00.000Z');

const MAIN = '11111111-1111-4111-8111-111111111111';
const SDK = '22222222-2222-4222-8222-222222222222';
const FRESH = '33333333-3333-4333-8333-333333333333';
const GARBAGE = '44444444-4444-4444-8444-444444444444';

/** Push a transcript's mtime back so the sweep treats it as idle. */
function age(file, hours) {
  const when = new Date(NOW - hours * HOUR_MS);
  fs.utimesSync(file, when, when);
}

function sweep(sandbox, overrides = {}) {
  return runSweep({
    projectsRoot: sandbox.projectsRoot,
    vaultRoot: sandbox.vaultRoot,
    minIdleMs: IDLE_MS,
    now: NOW,
    runGit: noGit,
    ...overrides,
  });
}

function fields(sandbox, relativePath) {
  const parsed = parseFrontmatter(readNote(sandbox, relativePath));
  assert.ok(parsed.ok, `frontmatter parses: ${relativePath}`);
  return parsed.fields;
}

test('an idle transcript with no note becomes a note marked captured_by: sweep, workers included', () => {
  const sandbox = createSandbox();
  try {
    age(installTranscript(sandbox, 'plain-main', MAIN), 12);

    const summary = sweep(sandbox);

    assert.equal(summary.written, 1);
    assert.equal(summary.childNotes, 2, 'both worker transcripts under <id>/subagents/ got notes');
    assert.equal(summary.errors, 0);

    const parent = fields(sandbox, `projects/bb2dash/sessions/${MAIN}.md`);
    assert.equal(parent.captured_by, CAPTURED_BY_SWEEP);
    assert.equal(parent.origin, '', 'the fixture carries no entrypoint, so nothing is claimed');
    assert.equal(parent.status, 'concluded');
    assert.deepEqual(parent.child_sessions, [`session-${MAIN}--aaa111`, `session-${MAIN}--bbb222`]);

    const worker = fields(sandbox, `projects/bb2dash/sessions/${MAIN}--aaa111.md`);
    assert.equal(worker.parent_session, MAIN);
    assert.equal(worker.captured_by, CAPTURED_BY_SWEEP);

    assert.equal(summary.touchedPaths.length, 3, 'the session note and two worker notes, each once');
  } finally {
    sandbox.cleanup();
  }
});

test('an SDK worker transcript (promptSource sdk, entrypoint sdk-py) is captured with its origin', () => {
  const sandbox = createSandbox();
  try {
    age(installTranscript(sandbox, 'sdk-review', SDK), 24);

    const summary = sweep(sandbox);
    assert.equal(summary.written, 1);

    const note = fields(sandbox, `projects/bb2dash/sessions/${SDK}.md`);
    assert.equal(note.origin, 'sdk-py');
    assert.equal(note.captured_by, CAPTURED_BY_SWEEP);
    assert.equal(note.prompt_count, 1, 'the review prompt counts; the tool result does not');
    assert.equal(note.collection, 'bb2dash');
    assert.ok(note.tools_used.Read >= 1);
  } finally {
    sandbox.cleanup();
  }
});

test('a session that already has a note is skipped, so a second sweep writes nothing', () => {
  const sandbox = createSandbox();
  try {
    age(installTranscript(sandbox, 'plain-main', MAIN), 12);
    age(installTranscript(sandbox, 'sdk-review', SDK), 12);

    const first = sweep(sandbox);
    assert.equal(first.written, 2);

    const second = sweep(sandbox);
    assert.equal(second.skippedNoted, 2);
    assert.equal(second.candidates.length, 0);
    assert.equal(second.written, 0);
  } finally {
    sandbox.cleanup();
  }
});

test('a transcript modified inside the idle window is a live session and is left alone', () => {
  const sandbox = createSandbox();
  try {
    age(installTranscript(sandbox, 'worktree', FRESH), 1);

    const summary = sweep(sandbox);
    assert.equal(summary.skippedActive, 1);
    assert.equal(summary.written, 0);
    assert.ok(!fs.existsSync(path.join(sandbox.vaultRoot, 'projects', 'bb2dash', 'sessions', `${FRESH}.md`)));
  } finally {
    sandbox.cleanup();
  }
});

test('a dry run lists the candidates and writes nothing', () => {
  const sandbox = createSandbox();
  try {
    age(installTranscript(sandbox, 'plain-main', MAIN), 12);

    const summary = sweep(sandbox, { dryRun: true });
    assert.equal(summary.candidates.length, 1);
    assert.equal(summary.candidates[0].sessionId, MAIN);
    assert.equal(summary.written, 0);
    assert.equal(fs.readdirSync(path.join(sandbox.vaultRoot, 'projects', 'bb2dash', 'sessions')).length, 0);
  } finally {
    sandbox.cleanup();
  }
});

test('a transcript of garbage is a logged skip, and the sweep carries on to the next one', () => {
  const sandbox = createSandbox();
  try {
    const garbage = path.join(sandbox.transcriptsDir, `${GARBAGE}.jsonl`);
    fs.writeFileSync(garbage, 'not json\n\u0000\u0001{"type":', 'utf8');
    age(garbage, 12);
    age(installTranscript(sandbox, 'plain-main', MAIN), 12);

    const lines = [];
    const summary = sweep(sandbox, { log: (line) => lines.push(line) });

    assert.equal(summary.errors, 0, 'garbage is a skip, never a throw');
    assert.equal(summary.skipped, 1);
    assert.equal(summary.written, 1);
    assert.ok(lines.some((line) => line.startsWith(`skip ${GARBAGE}`)), 'the skip is logged with its reason');
  } finally {
    sandbox.cleanup();
  }
});

test('`only` restricts the walk to the named sessions and `limit` caps the run', () => {
  const sandbox = createSandbox();
  try {
    age(installTranscript(sandbox, 'plain-main', MAIN), 12);
    age(installTranscript(sandbox, 'sdk-review', SDK), 12);

    const only = sweep(sandbox, { only: new Set([SDK]) });
    assert.equal(only.candidates.length, 1);
    assert.equal(only.candidates[0].sessionId, SDK);
    assert.equal(only.written, 1);

    const limited = sweep(sandbox, { limit: 1 });
    assert.equal(limited.candidates.length, 1, 'only MAIN is left');
    assert.equal(limited.selected, 1);
  } finally {
    sandbox.cleanup();
  }
});

test('a transcript whose cwd is excluded is skipped by rule, before any note is written', () => {
  const sandbox = createSandbox();
  try {
    // The fixture's cwd is <sandbox>/repos/bb2dash; exclude on the repo name.
    age(installTranscript(sandbox, 'sdk-review', SDK), 12);

    const lines = [];
    const summary = sweep(sandbox, { excludes: ['repos/bb2dash'], log: (line) => lines.push(line) });
    assert.equal(summary.skipped, 1);
    assert.equal(summary.written, 0);
    assert.ok(lines.some((line) => line.includes('excluded cwd (repos/bb2dash)')));
    assert.ok(!fs.existsSync(path.join(sandbox.vaultRoot, 'projects', 'bb2dash', 'sessions', `${SDK}.md`)));

    // The built-in list is the default; the observer sessions never come through.
    const cwd = `${sandbox.root}/AppData/Local/claude-mem/observer-sessions`;
    assert.equal(excludedBy(cwd, undefined) || excludedBy(cwd, SWEEP_EXCLUDED_CWD_SEGMENTS), 'claude-mem/observer-sessions');
    assert.equal(excludedBy('C:/Users/x/projects/bb2dash', SWEEP_EXCLUDED_CWD_SEGMENTS), '');
  } finally {
    sandbox.cleanup();
  }
});

test('the vault index counts session notes and resume notes, never worker notes alone', () => {
  assert.equal(sessionIdFromNoteName(`${MAIN}.md`), MAIN);
  assert.equal(sessionIdFromNoteName(`${MAIN}-r2.md`), MAIN);
  assert.equal(sessionIdFromNoteName(`${MAIN}--aaa111.md`), '', 'a worker note is not the session note');
  assert.equal(sessionIdFromNoteName('README.txt'), '');

  const sandbox = createSandbox();
  try {
    const dir = path.join(sandbox.vaultRoot, 'classes', 'ist323', 'sessions');
    fs.writeFileSync(path.join(dir, `${SDK}-r3.md`), '---\n---\n', 'utf8');
    fs.writeFileSync(path.join(dir, `${MAIN}--aaa111.md`), '---\n---\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'README.txt'), 'not a note', 'utf8');
    const noted = indexNotedSessions(sandbox.vaultRoot);
    assert.deepEqual([...noted], [SDK]);
  } finally {
    sandbox.cleanup();
  }
});

test('a session killed with its terminal — worker notes on disk, no parent note — is still swept', () => {
  const sandbox = createSandbox();
  try {
    age(installTranscript(sandbox, 'plain-main', MAIN), 12);
    // SubagentStop already wrote one worker note while the session was alive.
    const sessionsDir = path.join(sandbox.vaultRoot, 'projects', 'bb2dash', 'sessions');
    fs.writeFileSync(path.join(sessionsDir, `${MAIN}--aaa111.md`), '---\nid: x\n---\n', 'utf8');

    const summary = sweep(sandbox);
    assert.equal(summary.skippedNoted, 0);
    assert.equal(summary.written, 1, 'the parent note is written');
    assert.ok(fs.existsSync(path.join(sessionsDir, `${MAIN}.md`)));
  } finally {
    sandbox.cleanup();
  }
});

test('the exclusion also matches the project directory name, so a transcript with no cwd in its head is still excluded', () => {
  const sandbox = createSandbox();
  try {
    // Claude Code's spelling of C:/Users/x/AppData/Local/claude-mem/observer-sessions.
    const dir = path.join(sandbox.projectsRoot, 'C--Users-x-AppData-Local-claude-mem-observer-sessions');
    fs.mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, `${GARBAGE}.jsonl`);
    // A record with no cwd at all in the head.
    fs.writeFileSync(transcript, '{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"2026-09-09T14:45:00.000Z"}\n', 'utf8');
    age(transcript, 12);

    const summary = sweep(sandbox);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.results[0].detail, 'excluded cwd (claude-mem/observer-sessions)');
  } finally {
    sandbox.cleanup();
  }
});

test('the capture budget is per session: a run-level clock far in the past changes nothing', () => {
  const sandbox = createSandbox();
  try {
    age(installTranscript(sandbox, 'plain-main', MAIN), 12);
    // `now` only decides the idle window; if it also set the deadline, every
    // optional step (subagent folding, git) would already be over budget.
    const summary = sweep(sandbox, { now: Date.now() - 31_000, minIdleMs: 0 });
    assert.equal(summary.childNotes, 2);
    const parent = fields(sandbox, `projects/bb2dash/sessions/${MAIN}.md`);
    assert.equal(parent.files_modified.length, 5, 'the workers\u2019 edits were folded into the parent');
  } finally {
    sandbox.cleanup();
  }
});

test('a missing projects or vault root is refused, never reported as nothing to do', () => {
  const sandbox = createSandbox();
  try {
    assert.throws(() => sweep(sandbox, { projectsRoot: path.join(sandbox.root, 'nope') }), /projectsRoot is not a directory/);
    assert.throws(() => sweep(sandbox, { vaultRoot: `${sandbox.vaultRoot}-typo` }), /vaultRoot is not a directory/);
    assert.ok(!fs.existsSync(`${sandbox.vaultRoot}-typo`), 'no vault was grown at the typo');
  } finally {
    sandbox.cleanup();
  }
});

test('the transcript head yields cwd and entrypoint, or empty strings, without reading the whole file', () => {
  const sandbox = createSandbox();
  try {
    const sdk = installTranscript(sandbox, 'sdk-review', SDK);
    assert.deepEqual(readTranscriptHead(sdk), { cwd: `${sandbox.root}/repos/bb2dash`, entrypoint: 'sdk-py' });

    const plain = installTranscript(sandbox, 'plain-main', MAIN);
    assert.equal(readTranscriptHead(plain).entrypoint, '');

    const missing = path.join(sandbox.transcriptsDir, 'missing.jsonl');
    assert.deepEqual(readTranscriptHead(missing), { cwd: '', entrypoint: '' });
  } finally {
    sandbox.cleanup();
  }
});

test('only top-level transcripts are candidates; worker transcripts are reached through their parent', () => {
  const sandbox = createSandbox();
  try {
    age(installTranscript(sandbox, 'plain-main', MAIN), 12);
    const listed = listCandidateTranscripts({ projectsRoot: sandbox.projectsRoot, noted: new Set(), minIdleMs: IDLE_MS, now: NOW });
    assert.deepEqual(listed.candidates.map((c) => c.sessionId), [MAIN]);
  } finally {
    sandbox.cleanup();
  }
});

test('argument parsing: defaults, values, and refusals', () => {
  const env = { [process.env.HARNESS_VAULT ? 'x' : 'y']: '' };
  const parsed = parseArgs(['--min-idle-hours', '2', '--limit', '5', '--session', MAIN, '--dry-run'], env, 'C:/home');
  assert.ok(parsed.ok);
  assert.equal(parsed.options.minIdleHours, 2);
  assert.equal(parsed.options.limit, 5);
  assert.deepEqual([...parsed.options.only], [MAIN]);
  assert.equal(parsed.options.dryRun, true);
  assert.equal(parsed.options.projectsRoot, path.join('C:/home', '.claude', 'projects'));

  assert.equal(parseArgs(['--limit', '-1'], env, 'C:/home').ok, false);
  assert.equal(parseArgs(['--session', '../etc/passwd'], env, 'C:/home').ok, false);
  assert.equal(parseArgs(['--bogus'], env, 'C:/home').ok, false);
  assert.equal(parseArgs(['--vault'], env, 'C:/home').ok, false);
});

test('the CLI process: a dry run exits 0 and reports, bad usage exits 2', () => {
  const sandbox = createSandbox();
  try {
    age(installTranscript(sandbox, 'sdk-review', SDK), 12);
    const logPath = path.join(sandbox.root, 'sweep.log');

    const stdout = execFileSync(
      process.execPath,
      [CLI, '--dry-run', '--vault', sandbox.vaultRoot, '--projects', sandbox.projectsRoot],
      { encoding: 'utf8', env: { ...process.env, [LOG_ENV_VAR]: logPath } },
    );
    assert.match(stdout, new RegExp(`candidate ${SDK}`));
    assert.match(stdout, /sweep dry-run: transcripts=1 noted=0 active=0 candidates=1/);
    assert.match(fs.readFileSync(logPath, 'utf8'), /sweep finished \(dry-run\)/);

    const exitOf = (args) => {
      try {
        execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, [LOG_ENV_VAR]: logPath } });
        return EXIT_OK;
      } catch (err) {
        return err.status;
      }
    };
    assert.equal(exitOf(['--limit', 'many']), EXIT_USAGE);
    assert.equal(
      exitOf(['--dry-run', '--vault', sandbox.vaultRoot, '--projects', path.join(sandbox.root, 'definitely', 'not', 'here')]),
      EXIT_USAGE,
      'a mistyped --projects is refused, not reported as zero transcripts',
    );
  } finally {
    sandbox.cleanup();
  }
});
