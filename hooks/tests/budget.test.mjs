/**
 * The deadline (R-27, "never block session exit").
 *
 * SessionEnd hooks share about 1.5 s. The hook's own budget is 1,200 ms, and
 * this test holds it to that on a transcript larger than the largest one on
 * this machine — with the *real* `git log` running against a *real* repository,
 * because a stubbed subprocess would measure everything except the part that
 * can actually be slow.
 *
 * It asserts a wall-clock time, so it is the one test here that could go amber
 * on a loaded machine. That is the trade: an unmeasured budget is not a budget.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { capture } from '../lib/capture.mjs';
import { BUDGET_MS } from '../lib/constants.mjs';
import { resolveRepo } from '../lib/repo.mjs';
import { installExtraRules } from '../lib/redact.mjs';
import { EXTRA_RULES_ENV_VAR, loadExtraRules } from '../lib/redact-extra.mjs';
import { TRANSCRIPTS_DIR, createSandbox, toPosix } from './helpers/sandbox.mjs';
import { installLargeTranscript } from './helpers/large-transcript.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = toPosix(path.resolve(HERE, '..', '..'));

const SESSION_ID = '99999999-9999-4999-8999-999999999999';
const MAIN_BYTES = 6 * 1024 * 1024;
const SUBAGENT_COUNT = 24;
const SUBAGENT_BYTES = 512 * 1024;

/**
 * Capture the largest transcript against the real repository and return the
 * wall-clock milliseconds. `label` goes into the printed line only.
 */
function captureLargest(label) {
  const sandbox = createSandbox();
  try {
    const repo = resolveRepo(REPO_ROOT);
    const collection = repo.repoSlug || 'agentic-harness';
    fs.mkdirSync(path.join(sandbox.vaultRoot, 'projects', collection, 'sessions'), { recursive: true });

    const { transcriptPath, totalBytes } = installLargeTranscript({
      dir: sandbox.transcriptsDir,
      sessionId: SESSION_ID,
      cwd: REPO_ROOT,
      branch: repo.branch || 'feat/session-context',
      mainBytes: MAIN_BYTES,
      subagentCount: SUBAGENT_COUNT,
      subagentBytes: SUBAGENT_BYTES,
    });

    const startedAtMs = Date.now();
    const outcome = capture({
      input: {
        sessionId: SESSION_ID,
        endReason: 'clear',
        cwd: REPO_ROOT,
        transcriptPath,
        agentId: '',
        agentType: '',
        parentSession: '',
      },
      vaultRoot: sandbox.vaultRoot,
      projectsRoot: sandbox.projectsRoot,
      startedAtMs,
      // No `runGit` override: the real one runs, against this real repository.
    });
    const elapsed = Date.now() - startedAtMs;

    assert.equal(outcome.written, true, `expected a note, got ${outcome.action}: ${outcome.skip}`);
    assert.ok(
      elapsed < BUDGET_MS,
      `capture${label} took ${elapsed} ms over ${(totalBytes / 1024 / 1024).toFixed(1)} MB; budget is ${BUDGET_MS} ms`,
    );

    // Printed so the number lands in CI output and in the PR evidence.
    console.log(
      `    budget${label}: ${elapsed} ms for ${(totalBytes / 1024 / 1024).toFixed(1)} MB ` +
        `(${SUBAGENT_COUNT} subagent transcripts)`,
    );
    return elapsed;
  } finally {
    sandbox.cleanup();
  }
}

test('the hook stays inside its budget on the largest transcript', () => {
  captureLargest('');
});

/**
 * Twenty per-machine rules (R-106, P-112) of the kind a work machine would
 * carry: hostnames, ticket prefixes, a customer list, case-insensitive. Every
 * one is invented.
 */
const EXTRA_RULE_COUNT = 20;
function extraRulesFile(dir) {
  const rules = Array.from({ length: EXTRA_RULE_COUNT }, (_, i) => ({
    name: `work-${i}`,
    pattern: i % 2 === 0
      ? String.raw`\b(?:intranet|build|wiki)-${i}\.corp\.example\b`
      : String.raw`\b(?:ACME|GLOBEX|INITECH)-${i}[0-9]{3,}\b`,
    flags: 'i',
  }));
  const file = path.join(dir, 'redact-extra.json');
  fs.writeFileSync(file, JSON.stringify({ rules }), 'utf8');
  return file;
}

test('the hook stays inside its budget with a 20-rule extras file installed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-extra-'));
  const problems = [];
  const installed = installExtraRules(
    loadExtraRules({ [EXTRA_RULES_ENV_VAR]: extraRulesFile(dir) }, (line) => problems.push(line)),
  );
  try {
    assert.deepEqual(problems, []);
    assert.equal(installed, EXTRA_RULE_COUNT);
    captureLargest(` with ${EXTRA_RULE_COUNT} extra rules`);
  } finally {
    installExtraRules([]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the generated transcript really is larger than every committed fixture', () => {
  const largest = fs
    .readdirSync(TRANSCRIPTS_DIR)
    .filter((name) => name.endsWith('.jsonl'))
    .reduce((max, name) => Math.max(max, fs.statSync(path.join(TRANSCRIPTS_DIR, name)).size), 0);
  assert.ok(
    MAIN_BYTES > largest,
    `the budget fixture (${MAIN_BYTES} B) must exceed the largest committed fixture (${largest} B)`,
  );
});

test('a session that ran past the deadline still gets its note written', () => {
  const sandbox = createSandbox();
  try {
    const repo = resolveRepo(REPO_ROOT);
    const collection = repo.repoSlug || 'agentic-harness';
    fs.mkdirSync(path.join(sandbox.vaultRoot, 'projects', collection, 'sessions'), { recursive: true });

    const { transcriptPath } = installLargeTranscript({
      dir: sandbox.transcriptsDir,
      sessionId: SESSION_ID,
      cwd: REPO_ROOT,
      branch: 'feat/session-context',
      mainBytes: 256 * 1024,
      subagentCount: 4,
      subagentBytes: 64 * 1024,
    });

    // A deadline already in the past: every optional step must bail out and the
    // write must still happen. The alternative — no note — is the failure mode
    // this whole design exists to avoid.
    const outcome = capture({
      input: {
        sessionId: SESSION_ID,
        endReason: 'clear',
        cwd: REPO_ROOT,
        transcriptPath,
        agentId: '',
        agentType: '',
        parentSession: '',
      },
      vaultRoot: sandbox.vaultRoot,
      projectsRoot: sandbox.projectsRoot,
      startedAtMs: Date.now() - 10_000,
      deadlineAt: Date.now() - 5_000,
    });

    assert.equal(outcome.written, true, `${outcome.action}: ${outcome.skip}`);
    const note = fs.readFileSync(outcome.notePath, 'utf8');
    assert.ok(note.includes('commits: []'), 'the optional git step was skipped, as designed');
  } finally {
    sandbox.cleanup();
  }
});
