/**
 * Path filtering and the fields lifted out of it (R-27.3).
 *
 * The v1 note's `files_modified` was mostly scratchpad paths, which link a
 * session to nothing. These rules are what turn it back into a list of work.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { classifyPaths, isNoisePath, makeRepoResolver, toRepoRelative } from '../lib/paths.mjs';
import { createSandbox } from './helpers/sandbox.mjs';

const LIMITS = { maxFiles: 60, maxDocs: 40, maxMemory: 20, maxRepos: 10 };

test('machinery paths are noise; work paths are not', () => {
  const noise = [
    'C:/Users/estac/AppData/Local/Temp/claude/C--x/abc/scratchpad/patch.mjs',
    'C:/Users/estac/.claude/projects/C--x/abc.jsonl',
    'C:/repo/node_modules/left-pad/index.js',
    'C:/repo/.venv/lib/site.py',
    'C:/repo/web/.next/server/page.js',
    'C:/repo/.git/COMMIT_EDITMSG',
    '',
  ];
  for (const candidate of noise) assert.equal(isNoisePath(candidate), true, candidate);

  const work = [
    'C:/repo/ingest/src/ingest/cli.py',
    'C:/repo/db/migrations/035_x.sql',
    'C:/Users/estac/projects/bb2dash/web/src/app/page.tsx',
  ];
  for (const candidate of work) assert.equal(isNoisePath(candidate), false, candidate);
});

test('a repository checked out under Temp is still work', () => {
  // The suite itself runs from a sandbox under the system temp directory, so a
  // blanket "anything under Temp is noise" rule would make every test vacuous.
  assert.equal(isNoisePath('C:/Users/estac/AppData/Local/Temp/session-capture-x/repos/bb2dash/db/a.sql'), false);
});

test('paths become relative to the repository that owns them', () => {
  const sandbox = createSandbox();
  try {
    const repoFor = makeRepoResolver();
    const file = `${sandbox.root}/repos/bb2dash/db/migrations/035_x.sql`;
    assert.equal(toRepoRelative(file, repoFor(file)), 'db/migrations/035_x.sql');

    const outside = `${sandbox.root}/onedrive/.fall2026/ist323/notes.md`;
    assert.equal(toRepoRelative(outside, repoFor(outside)), outside, 'no repo means no rewrite');
  } finally {
    sandbox.cleanup();
  }
});

test('two worktrees of one repo produce one entry with the counts summed', () => {
  const sandbox = createSandbox();
  try {
    const result = classifyPaths(
      [
        [`${sandbox.root}/repos/bb2dash/web/src/app/page.tsx`, 2],
        [`${sandbox.root}/repos/bb2dash-wt-sl/web/src/app/page.tsx`, 3],
      ],
      { repoFor: makeRepoResolver(), ...LIMITS },
    );
    assert.deepEqual(result.files, [{ path: 'web/src/app/page.tsx', count: 5, repo: 'bb2dash' }]);
    assert.deepEqual(result.reposTouched, ['bb2dash']);
  } finally {
    sandbox.cleanup();
  }
});

test('plans, memory files and docs are lifted into their own fields', () => {
  const sandbox = createSandbox();
  try {
    const result = classifyPaths(
      [
        [`${sandbox.root}/home/.claude/plans/abundant-gathering-wirth.md`, 1],
        [`${sandbox.root}/home/.claude/projects/C--x/memory/pm-worker-arrangement.md`, 1],
        [`${sandbox.root}/home/.claude/projects/C--x/memory/bb2dash-phase7.md`, 1],
        [`${sandbox.root}/repos/agentic-harness/docs/ingestion.md`, 4],
        [`${sandbox.root}/repos/agentic-harness/ingest/src/ingest/cli.py`, 1],
      ],
      { repoFor: makeRepoResolver(), ...LIMITS },
    );

    assert.equal(result.planFile, 'abundant-gathering-wirth');
    assert.deepEqual(result.memoryFiles, ['pm-worker-arrangement', 'bb2dash-phase7']);
    assert.deepEqual(result.docsTouched, ['docs/ingestion.md']);
    assert.deepEqual(
      result.files.map((file) => file.path),
      ['docs/ingestion.md', 'ingest/src/ingest/cli.py'],
    );
    for (const file of result.files) assert.ok(!path.isAbsolute(file.path));
  } finally {
    sandbox.cleanup();
  }
});

test('the file list is capped, most-edited first', () => {
  const sandbox = createSandbox();
  try {
    const entries = Array.from({ length: 20 }, (_, index) => [
      `${sandbox.root}/repos/bb2dash/src/file${String(index).padStart(2, '0')}.ts`,
      index,
    ]);
    const result = classifyPaths(entries, { repoFor: makeRepoResolver(), ...LIMITS, maxFiles: 3 });
    assert.deepEqual(
      result.files.map((file) => file.path),
      ['src/file19.ts', 'src/file18.ts', 'src/file17.ts'],
    );
  } finally {
    sandbox.cleanup();
  }
});
