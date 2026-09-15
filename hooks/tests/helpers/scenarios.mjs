/**
 * The fixture scenarios, shared by the golden test and `update-goldens.mjs`.
 *
 * One list, two readers: the test asserts the rendered note equals the golden,
 * the script rewrites the golden. Keeping the scenarios here is what makes a
 * schema change a one-command regeneration plus a diff a human reads.
 */

import { capture } from '../../lib/capture.mjs';
import { captureSubagent } from '../../lib/subagent.mjs';
import { expand, installTranscript, noGit } from './sandbox.mjs';

export const SCENARIOS = Object.freeze([
  {
    name: 'plain-main',
    description: 'a main checkout: collection from the git remote, PR number from gh output',
    fixture: 'plain-main',
    sessionId: '11111111-1111-4111-8111-111111111111',
    cwd: '__SANDBOX__/repos/bb2dash',
    reason: 'clear',
    note: 'projects/bb2dash/sessions/11111111-1111-4111-8111-111111111111.md',
  },
  {
    name: 'worktree',
    description: 'a worktree cwd: same collection as the main repo, worktree recorded',
    fixture: 'worktree',
    sessionId: '22222222-2222-4222-8222-222222222222',
    cwd: '__SANDBOX__/repos/bb2dash-wt-sl',
    reason: 'logout',
    note: 'projects/bb2dash/sessions/22222222-2222-4222-8222-222222222222.md',
  },
  {
    name: 'subagent',
    description: 'a subagent transcript: parent_session from the transcript path',
    fixture: 'subagent',
    sessionId: '44444444-4444-4444-8444-444444444444',
    cwd: '__SANDBOX__/repos/agentic-harness',
    reason: 'other',
    note: 'projects/agentic-harness/sessions/44444444-4444-4444-8444-444444444444.md',
    transcriptUnder: 'a1b2c3d4-0000-4000-8000-000000000001',
  },
  {
    name: 'cross-repo',
    description: 'one session editing two repositories: one note, repos_touched populated',
    fixture: 'cross-repo',
    sessionId: '55555555-5555-4555-8555-555555555555',
    cwd: '__SANDBOX__/repos/bb2dash',
    reason: 'prompt_input_exit',
    note: 'projects/bb2dash/sessions/55555555-5555-4555-8555-555555555555.md',
  },
  {
    name: 'credentials',
    description: 'prompts and commands seeded with a JWT, an sb_ key and a connection string',
    fixture: 'credentials',
    sessionId: '66666666-6666-4666-8666-666666666666',
    cwd: '__SANDBOX__/repos/agentic-harness',
    reason: 'clear',
    note: 'projects/agentic-harness/sessions/66666666-6666-4666-8666-666666666666.md',
  },
  {
    name: 'subagent-parent',
    description: 'a parent session whose two workers each get their own note',
    fixture: 'subagent-parent',
    sessionId: '88888888-8888-4888-8888-888888888888',
    cwd: '__SANDBOX__/repos/bb2dash',
    reason: 'clear',
    note: 'projects/bb2dash/sessions/88888888-8888-4888-8888-888888888888.md',
  },
  {
    name: 'class',
    description: 'a class folder under OneDrive: classes/<course id>, collection_source folder',
    fixture: 'class',
    sessionId: '77777777-7777-4777-8777-777777777777',
    cwd: '__SANDBOX__/onedrive/.fall2026/ist323',
    reason: 'clear',
    note: 'classes/ist323/sessions/77777777-7777-4777-8777-777777777777.md',
  },
]);

/**
 * Run one scenario against a prepared sandbox.
 *
 * `git` is stubbed out: the sandbox checkouts have `.git` metadata but no
 * objects, so a real `git log` would only add latency and a platform
 * dependency. `git-log.test.mjs` covers the parsing separately.
 */
/**
 * The workers of the `subagent-parent` fixture, each with a golden note.
 *
 * `c0ffee01` opens its transcript with the task prompt, the ordinary shape.
 * `c0ffee02` has no user turn at all, so its task has to come from the meta
 * file the parent's Agent call wrote beside the transcript.
 */
export const SUBAGENT_SCENARIOS = Object.freeze([
  {
    name: 'subagent-worker',
    description: 'a worker with its own task prompt: one note, linked to its parent',
    parent: 'subagent-parent',
    sessionId: '88888888-8888-4888-8888-888888888888',
    agentId: 'c0ffee01',
    agentType: 'general-purpose',
    cwd: '__SANDBOX__/repos/bb2dash',
    note: 'projects/bb2dash/sessions/88888888-8888-4888-8888-888888888888--c0ffee01.md',
  },
  {
    name: 'subagent-worker-no-prompt',
    description: 'a worker that only ran tools: the task comes from the meta file',
    parent: 'subagent-parent',
    sessionId: '88888888-8888-4888-8888-888888888888',
    agentId: 'c0ffee02',
    agentType: 'feature-dev:code-reviewer',
    cwd: '__SANDBOX__/repos/bb2dash',
    note: 'projects/bb2dash/sessions/88888888-8888-4888-8888-888888888888--c0ffee02.md',
  },
]);

/** Install the parent fixture, then stop one of its workers. */
export function runSubagentScenario(sandbox, scenario) {
  const transcriptPath = installTranscript(sandbox, scenario.parent, scenario.sessionId);
  return runSubagentStop(sandbox, { ...scenario, transcriptPath });
}

/**
 * Drive `SubagentStop` for one worker of an already-installed parent fixture.
 *
 * Returns the outcome; the caller decides whether the parent note existed
 * first, which is what the two link orders come down to.
 */
export function runSubagentStop(sandbox, { sessionId, agentId, agentType, cwd, transcriptPath }) {
  return captureSubagent({
    input: {
      sessionId,
      endReason: 'other',
      hookEventName: 'SubagentStop',
      cwd: expand(cwd, sandbox),
      transcriptPath,
      agentId,
      agentType: agentType ?? '',
      agentTranscriptPath: '',
      parentSession: '',
    },
    vaultRoot: sandbox.vaultRoot,
    projectsRoot: sandbox.projectsRoot,
    runGit: noGit,
  });
}

export function runScenario(sandbox, scenario, overrides = {}) {
  const transcriptPath = installTranscript(
    sandbox,
    scenario.fixture,
    scenario.transcriptUnder ? `${scenario.transcriptUnder}/subagents/agent-c0ffee01` : scenario.sessionId,
  );

  return capture({
    input: {
      sessionId: scenario.sessionId,
      endReason: scenario.reason,
      cwd: expand(scenario.cwd, sandbox),
      transcriptPath,
      agentId: '',
      agentType: '',
      parentSession: '',
      ...overrides.input,
    },
    vaultRoot: sandbox.vaultRoot,
    projectsRoot: sandbox.projectsRoot,
    runGit: noGit,
    ...overrides.capture,
  });
}
