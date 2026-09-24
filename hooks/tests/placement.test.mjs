/**
 * Where a session note is filed: by the directory its transcript declares.
 *
 * The stdin `cwd` is wherever the session happened to be when it ended — the
 * vault, the home folder, another repository it `cd`'d into. The transcript's
 * first record says where it started, and that is the session's collection.
 * A worker already filed by its parent's transcript; a session filed by its
 * stdin, so the two could land in different collections and the worker's `up`
 * link pointed at a note in another folder.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { capture } from '../lib/capture.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';
import { collectionsHolding, createSandbox, expand, installTranscript, noGit, toPosix } from './helpers/sandbox.mjs';
import { SCENARIOS, runScenario, runSubagentStop } from './helpers/scenarios.mjs';

const PLAIN = SCENARIOS.find((scenario) => scenario.name === 'plain-main');
const PARENT = SCENARIOS.find((scenario) => scenario.name === 'subagent-parent');
const VAULT_CWD = '__SANDBOX__/vault';
const RESUMED_ID = '33333333-3333-4333-8333-333333333333';

function fieldsAt(sandbox, relativePath) {
  const parsed = parseFrontmatter(fs.readFileSync(path.join(sandbox.vaultRoot, relativePath), 'utf8'));
  assert.equal(parsed.ok, true, parsed.error);
  return parsed.fields;
}

/** Rewrite an installed transcript with every record's `cwd` removed. */
function stripCwd(transcriptPath) {
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  const stripped = lines.map((line) => {
    const { cwd: _dropped, ...rest } = JSON.parse(line);
    return JSON.stringify(rest);
  });
  fs.writeFileSync(transcriptPath, `${stripped.join('\n')}\n`, 'utf8');
}

/** A `git log` that answers with one commit and remembers which repository it was asked about. */
function scriptedGit() {
  const asked = [];
  const runGit = (args, { cwd } = {}) => {
    asked.push(toPosix(cwd));
    return { ok: true, stdout: `${COMMIT_SHA}\x1fdocs: scripted commit\x1f\x1e` };
  };
  return { asked, runGit };
}

const COMMIT_SHA = 'abcdef0123456789abcdef0123456789abcdef01';

test("a session that ended in the vault is filed under the repo its transcript started in", () => {
  const sandbox = createSandbox();
  try {
    const git = scriptedGit();
    const outcome = runScenario(sandbox, { ...PLAIN, cwd: VAULT_CWD }, { capture: { runGit: git.runGit } });
    assert.equal(outcome.written, true, `${outcome.action}: ${outcome.skip}`);

    const note = fieldsAt(sandbox, PLAIN.note);
    assert.equal(note.collection, 'bb2dash');
    assert.equal(note.collection_source, 'git');
    // Repository, branch and commits follow the same directory as the collection.
    assert.equal(note.repo, 'emstacho-su/bb2dash');
    assert.equal(note.branch, 'feat/phase7-retrieval');
    assert.deepEqual(git.asked, [`${sandbox.root}/repos/bb2dash`]);
    assert.deepEqual(note.commits, [COMMIT_SHA.slice(0, 12)]);
    // Where the session ended stays on the note: that is provenance.
    assert.equal(note.cwd, `${sandbox.root}/vault`);
    assert.deepEqual(note.cwds_seen, [`${sandbox.root}/repos/bb2dash`]);
    assert.equal(fs.existsSync(path.join(sandbox.vaultRoot, 'projects', 'vault')), false, 'no folder-named collection was grown');
  } finally {
    sandbox.cleanup();
  }
});

test('a transcript that declares no cwd is filed by the stdin cwd, as before', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installTranscript(sandbox, PLAIN.fixture, PLAIN.sessionId);
    stripCwd(transcriptPath);

    const outcome = capture({
      input: {
        sessionId: PLAIN.sessionId,
        endReason: PLAIN.reason,
        cwd: expand('__SANDBOX__/repos/agentic-harness', sandbox),
        transcriptPath,
        agentId: '',
        agentType: '',
        parentSession: '',
      },
      vaultRoot: sandbox.vaultRoot,
      projectsRoot: sandbox.projectsRoot,
      runGit: noGit,
    });
    assert.equal(outcome.written, true, `${outcome.action}: ${outcome.skip}`);

    const filename = `${PLAIN.sessionId}.md`;
    assert.deepEqual(collectionsHolding(sandbox.vaultRoot, filename), ['projects/agentic-harness']);
    const note = fieldsAt(sandbox, `projects/agentic-harness/sessions/${filename}`);
    assert.equal(note.collection_source, 'git');
    assert.deepEqual(note.cwds_seen, []);
    // Today's values: everything from the stdin cwd.
    assert.equal(note.repo, 'emstacho-su/agentic-harness');
    assert.equal(note.branch, 'feat/session-context');
  } finally {
    sandbox.cleanup();
  }
});

test('a resumed session that ended in another directory lands with its chain', () => {
  const sandbox = createSandbox();
  try {
    const base = { sessionId: RESUMED_ID, cwd: '__SANDBOX__/repos/agentic-harness', note: '' };
    const first = runScenario(sandbox, { ...base, fixture: 'resume-first', reason: 'clear' });
    assert.equal(first.action, 'create');

    const resumed = runScenario(sandbox, { ...base, fixture: 'resume-second', reason: 'logout', cwd: VAULT_CWD });
    assert.equal(resumed.action, 'resume', `${resumed.action}: ${resumed.skip}`);
    assert.equal(
      path.relative(sandbox.vaultRoot, resumed.notePath).replace(/\\/g, '/'),
      `projects/agentic-harness/sessions/${RESUMED_ID}-r2.md`,
    );
    assert.equal(fieldsAt(sandbox, `projects/agentic-harness/sessions/${RESUMED_ID}.md`).status, 'superseded');
    assert.equal(fs.existsSync(path.join(sandbox.vaultRoot, 'projects', 'vault')), false);
  } finally {
    sandbox.cleanup();
  }
});

test('a worker and its parent, both ending in the vault, land in one collection and the link resolves', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installTranscript(sandbox, PARENT.fixture, PARENT.sessionId);
    const worker = runSubagentStop(sandbox, {
      sessionId: PARENT.sessionId,
      agentId: 'c0ffee01',
      agentType: 'general-purpose',
      cwd: VAULT_CWD,
      transcriptPath,
    });
    assert.equal(worker.written, true, `${worker.action}: ${worker.skip}`);
    const parent = runScenario(sandbox, { ...PARENT, cwd: VAULT_CWD });
    assert.equal(parent.written, true, `${parent.action}: ${parent.skip}`);

    const workerFile = `${PARENT.sessionId}--c0ffee01.md`;
    const parentFile = `${PARENT.sessionId}.md`;
    const [home] = collectionsHolding(sandbox.vaultRoot, workerFile);
    assert.deepEqual(collectionsHolding(sandbox.vaultRoot, parentFile), [home]);

    const child = fieldsAt(sandbox, `${home}/sessions/${workerFile}`);
    assert.equal(child.up, `[[${PARENT.sessionId}]]`);
    assert.ok(fs.existsSync(path.join(sandbox.vaultRoot, home, 'sessions', parentFile)), 'the up link names a note beside it');
    assert.ok(fieldsAt(sandbox, `${home}/sessions/${parentFile}`).child_sessions.includes(child.id));
  } finally {
    sandbox.cleanup();
  }
});
