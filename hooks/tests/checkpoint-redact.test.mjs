/**
 * /checkpoint redacts before git sees the note (R-98, H-7).
 *
 * The collector redacts only after a checkpoint note has been pushed, and a
 * secret in a repository's history needs rotation, not a later fix. So
 * `build-note.mjs` carries its own `redact.mjs` and runs the body and every
 * git-derived string through it before writing.
 *
 *   P-57   the payload copy is byte-identical to `hooks/lib/redact.mjs`;
 *   P-113  the same seeded fixture comes out the same through both modules,
 *          and through a built note with nothing left to find.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import * as hookRedact from '../lib/redact.mjs';
import * as checkpointRedact from '../../skills/checkpoint/redact.mjs';
import { buildNote, countRedactions, main } from '../../skills/checkpoint/build-note.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK_COPY = path.resolve(HERE, '..', 'lib', 'redact.mjs');
const CHECKPOINT_COPY = path.resolve(HERE, '..', '..', 'skills', 'checkpoint', 'redact.mjs');

// Fake credentials, one per shape the brief names; none is live.
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLWZvci10ZXN0cw';
const SB_KEY = 'sb_secret_9aQZ1kLmNOPqrstuvwxyz0123456789ab';
const DB_PASSWORD = 'Sup3rSecretPassw0rd';
const CONNECTION = `postgresql://postgres.abc:${DB_PASSWORD}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
const SECRETS = Object.freeze([JWT, SB_KEY, DB_PASSWORD]);

/** A checkpoint body a careless session might write: every secret pasted in. */
const SEEDED_BODY = [
  '## What I asked for',
  `1. Wire the edge function; the anon JWT is ${JWT}.`,
  `2. Point the loader at ${CONNECTION}.`,
  '',
  '## What was done',
  `- Set SUPABASE_KEY=${SB_KEY} in the local env.`,
  '',
  '## Decisions',
  `- Rotate the database password ${DB_PASSWORD} after the demo.`,
  '',
  '## Open questions / next steps',
  '- none',
  '',
].join('\n');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A repository whose branch name and a changed file's name carry a secret shape. */
function createSeededRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-redact-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/emstacho-su/bb2dash.git']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
  git(repo, ['checkout', '-q', '-b', `fix/${SB_KEY}`]);
  fs.writeFileSync(path.join(repo, `${JWT}.txt`), 'x\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'add a file']);
  return { root, repo, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('P-57: skills/checkpoint/redact.mjs is a byte copy of hooks/lib/redact.mjs', () => {
  assert.ok(fs.readFileSync(CHECKPOINT_COPY).equals(fs.readFileSync(HOOK_COPY)), 'run: cp hooks/lib/redact.mjs skills/checkpoint/redact.mjs');
});

test('the copy has no imports, so it runs in a repository with no hooks/lib beside it', () => {
  assert.doesNotMatch(fs.readFileSync(CHECKPOINT_COPY, 'utf8'), /^\s*import\b/m);
});

test('P-113: the seeded fixture comes out the same through both modules, with no secret left', () => {
  const fromHook = hookRedact.redact(SEEDED_BODY);
  const fromCheckpoint = checkpointRedact.redact(SEEDED_BODY);
  assert.equal(fromCheckpoint, fromHook);
  assert.ok(checkpointRedact.looksRedacted(fromCheckpoint));
  assert.ok(fromCheckpoint.includes('[REDACTED-JWT]'));
  assert.ok(fromCheckpoint.includes('[REDACTED-KEY]'));
  assert.ok(fromCheckpoint.includes('aws-0-us-east-1.pooler.supabase.com'), 'the context around a secret stays readable');
  assert.deepEqual(checkpointRedact.findSecretValues(SEEDED_BODY), hookRedact.findSecretValues(SEEDED_BODY));
});

test('countRedactions counts markers added, not markers already there', () => {
  assert.equal(countRedactions('a [REDACTED] b', 'a [REDACTED] b'), 0);
  assert.equal(countRedactions('x', '[REDACTED-JWT] and [REDACTED-KEY]'), 2);
  assert.equal(countRedactions('[REDACTED]', '[REDACTED] [REDACTED:mine]'), 1);
});

test('a built note carries no secret from the body, the branch or a file name, and counts what it removed', () => {
  const fixture = createSeededRepo();
  try {
    const note = buildNote({ repo: fixture.repo, body: SEEDED_BODY, sessionId: 'sess-r1', now: new Date('2026-09-29T12:00:00Z'), env: {} });
    assert.equal(note.ok, true, note.error);
    for (const secret of SECRETS) assert.ok(!note.text.includes(secret), `the note contains ${secret.slice(0, 12)}…`);
    assert.ok(hookRedact.looksRedacted(note.text), 'an independent probe finds no credential shape');

    assert.equal(note.fields.branch, 'fix/[REDACTED-KEY]');
    assert.ok(note.fields.files_modified.includes('[REDACTED-JWT].txt'), note.fields.files_modified.join(', '));
    assert.equal(note.fields.repo, 'emstacho-su/bb2dash', 'a clean git fact is left alone');
    // Body: JWT, connection password, SUPABASE_KEY assignment, the password repeated in prose.
    // Git: the branch (frontmatter and body line) and the file name.
    assert.ok(note.redactions >= 6, `redactions ${note.redactions}`);
  } finally {
    fixture.cleanup();
  }
});

test('the CLI JSON line reports redactions, 0 for a clean note', () => {
  const fixture = createSeededRepo();
  try {
    const seeded = path.join(fixture.root, 'seeded.md');
    fs.writeFileSync(seeded, SEEDED_BODY, 'utf8');
    const dirty = main(['--repo', fixture.repo, '--body', seeded, '--session-id', 'sess-r2'], {});
    assert.equal(dirty.code, 0, JSON.stringify(dirty.output));
    assert.ok(dirty.output.redactions >= 6);
    const written = fs.readFileSync(path.join(fixture.repo, '.harness', 'sessions', 'sess-r2.md'), 'utf8');
    for (const secret of SECRETS) assert.ok(!written.includes(secret), `the written note contains ${secret.slice(0, 12)}…`);

    git(fixture.repo, ['checkout', '-q', 'main']);
    fs.rmSync(path.join(fixture.repo, '.harness'), { recursive: true, force: true });
    const clean = path.join(fixture.root, 'clean.md');
    fs.writeFileSync(clean, SEEDED_BODY.replace(/^.*(?:eyJ|postgresql|SUPABASE_KEY|Rotate).*$/gm, '- nothing secret'), 'utf8');
    const quiet = main(['--repo', fixture.repo, '--body', clean, '--session-id', 'sess-r3'], {});
    assert.equal(quiet.code, 0, JSON.stringify(quiet.output));
    assert.equal(quiet.output.redactions, 0);
  } finally {
    fixture.cleanup();
  }
});
