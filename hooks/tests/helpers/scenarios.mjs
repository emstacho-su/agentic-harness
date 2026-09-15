/**
 * The fixture scenarios, shared by the golden test and `update-goldens.mjs`.
 *
 * One list, two readers: the test asserts the rendered note equals the golden,
 * the script rewrites the golden. Keeping the scenarios here is what makes a
 * schema change a one-command regeneration plus a diff a human reads.
 */

import { capture } from '../../lib/capture.mjs';
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
