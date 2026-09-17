/**
 * `skills/checkpoint/build-note.mjs`: the deterministic half of /checkpoint.
 *
 * It runs inside a cloud sandbox with no access to hooks/lib, so it carries a
 * copy of the frontmatter serializer. The first test here is the one that
 * matters most: that copy must stay byte-identical in behaviour to the hook's.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { FIELD_SPEC as HOOK_FIELD_SPEC, parseFrontmatter, serializeFrontmatter as hookSerialize } from '../lib/frontmatter.mjs';
import { slugify as hookSlugify } from '../lib/text.mjs';
import {
  FIELD_SPEC,
  REQUIRED_HEADINGS,
  buildNote,
  countRequests,
  main,
  resolveSessionId,
  serializeFrontmatter,
  slugify,
  validateBody,
} from '../../skills/checkpoint/build-note.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', '..', 'skills', 'checkpoint', 'build-note.mjs');

const BODY = [
  '## What I asked for',
  '1. Build the checkpoint skill.',
  '2. Push back on feasibility.',
  '',
  '## What was done',
  '- Wrote build-note.mjs.',
  '',
  '## Decisions',
  '- Frontmatter from git, body from the model.',
  '',
  '## Open questions / next steps',
  '- none',
  '',
].join('\n');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A real repository: one commit on main, a feature branch with one more commit and a dirty file. */
function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/emstacho-su/bb2dash.git']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
  git(repo, ['checkout', '-q', '-b', 'feat/thing']);
  fs.mkdirSync(path.join(repo, 'web'));
  fs.writeFileSync(path.join(repo, 'web', 'a.ts'), 'export const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'docs.md'), 'notes\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'feat: thing']);
  fs.writeFileSync(path.join(repo, 'web', 'dirty.ts'), 'export const b = 2;\n', 'utf8');
  return { root, repo, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('the serializer copy matches hooks/lib/frontmatter.mjs field for field and byte for byte', () => {
  assert.deepEqual(FIELD_SPEC, HOOK_FIELD_SPEC, 'field order and kinds are the frozen v2 contract');

  const sample = Object.fromEntries(
    FIELD_SPEC.map(([key, kind]) => {
      if (kind === 'list') return [key, [`it's ${key}`, 'C:\\path\\with\\backslashes']];
      if (kind === 'numlist') return [key, [6, 12]];
      if (kind === 'map') return [key, { Edit: 3, 'bad key\n': 1, Bash: 0 }];
      if (kind === 'plain') return [key, key === 'date' ? '2026-09-16' : 7];
      return [key, `value: with 'quotes'\nand a newline`];
    }),
  );
  assert.equal(serializeFrontmatter(sample), hookSerialize(sample));
});

test('a body without the four headings is refused, never padded', () => {
  for (const heading of REQUIRED_HEADINGS) {
    const broken = BODY.replace(heading, '## Something else');
    const result = validateBody(broken);
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(heading.replace(/[/]/g, '\\/')));
  }
  assert.equal(validateBody('').ok, false);
  assert.equal(validateBody(BODY).ok, true);
});

test('prompt_count is the number of items under "What I asked for"', () => {
  assert.equal(countRequests(BODY), 2);
  assert.equal(countRequests('## What I asked for\n\n(nothing listed)\n\n## What was done\n- x\n'), 0);
});

test('the session id is cp- plus the environment id when it is safe, else cp- plus a fresh UUID', () => {
  assert.equal(resolveSessionId({ explicit: 'abc-123', env: {} }), 'abc-123', 'an explicit id is used as given (tests, --session-id)');
  assert.equal(resolveSessionId({ env: { CLAUDE_CODE_REMOTE_SESSION_ID: 'sess_42' } }), 'cp-sess_42');

  const claim = Buffer.from(JSON.stringify({ 'ccr:session_id': 'from-jwt' })).toString('base64url');
  assert.equal(resolveSessionId({ env: { CLAUDE_CODE_SESSION_ACCESS_TOKEN: `h.${claim}.s` } }), 'cp-from-jwt');

  assert.match(resolveSessionId({ env: { CLAUDE_CODE_REMOTE_SESSION_ID: '../escape' } }), /^cp-[0-9a-f-]{36}$/, 'an unsafe id is ignored');
  assert.match(resolveSessionId({ env: {} }), /^cp-[0-9a-f-]{36}$/);
});

test('slugify is the hook’s slugify, so a repository files under the same project as its local sessions', () => {
  for (const name of ['my.repo', 'My_Repo', 'IST 323', 'con', '--weird--', '', 'a'.repeat(80)]) {
    assert.equal(slugify(name), hookSlugify(name), `slugify(${JSON.stringify(name)})`);
  }
});

test('buildNote takes every fact from git and the argument, and the body from the file', () => {
  const fixture = createRepo();
  try {
    const now = new Date('2026-09-16T23:59:00.000Z');
    const note = buildNote({ repo: fixture.repo, body: BODY, sessionId: 'sess-1', now, env: {} });
    assert.ok(note.ok, note.error);

    const f = note.fields;
    assert.equal(f.id, 'session-sess-1');
    assert.equal(f.collection, 'bb2dash');
    assert.equal(f.collection_source, 'git');
    assert.equal(f.repo, 'emstacho-su/bb2dash');
    assert.equal(f.branch, 'feat/thing');
    assert.equal(f.commits.length, 1, 'the one commit past main');
    assert.deepEqual(f.files_modified, ['docs.md', 'web/a.ts', 'web/dirty.ts'], 'committed and uncommitted, sorted');
    assert.deepEqual(f.docs_touched, ['docs.md']);
    assert.equal(f.prompt_count, 2);
    assert.equal(f.origin, 'cloud');
    assert.equal(f.captured_by, 'skill');
    assert.equal(f.date, '2026-09-16');
    assert.equal(f.status, 'concluded');

    const parsed = parseFrontmatter(note.text);
    assert.ok(parsed.ok, parsed.error);
    assert.equal(Object.keys(parsed.fields).length, FIELD_SPEC.length, 'every v2 field is present');
    assert.match(parsed.body.trimStart(), /^# Session 2026-09-16 — bb2dash/);
    assert.match(parsed.body, /## Open questions \/ next steps/);

    const classed = buildNote({ repo: fixture.repo, body: BODY, collection: 'IST 323', sessionId: 'sess-2', now, env: {} });
    assert.equal(classed.fields.collection, 'ist-323', 'the argument is slugified, never trusted raw');
    assert.equal(classed.fields.collection_source, 'argument');
  } finally {
    fixture.cleanup();
  }
});

test('outside any repository the note still builds, with empty git facts and collection misc', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-norepo-'));
  try {
    const note = buildNote({ repo: root, body: BODY, sessionId: 'sess-3', env: {} });
    assert.ok(note.ok, note.error);
    assert.equal(note.fields.repo, '');
    assert.equal(note.fields.collection, 'misc');
    assert.deepEqual(note.fields.commits, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('main() writes <repo>/.harness/sessions/<id>.md and reports it; bad input exits 2', () => {
  const fixture = createRepo();
  try {
    const bodyPath = path.join(fixture.root, 'body.md');
    fs.writeFileSync(bodyPath, BODY, 'utf8');

    const ok = main(['--repo', fixture.repo, '--body', bodyPath, '--session-id', 'sess-9'], {});
    assert.equal(ok.code, 0);
    assert.equal(ok.output.ok, true);
    assert.equal(ok.output.id, 'session-sess-9');
    assert.ok(fs.existsSync(path.join(fixture.repo, '.harness', 'sessions', 'sess-9.md')));

    assert.equal(main(['--repo', fixture.repo], {}).code, 2, '--body is required');
    assert.equal(main(['--repo', fixture.repo, '--body', path.join(fixture.root, 'missing.md')], {}).code, 2);
    fs.writeFileSync(bodyPath, '## What I asked for\n- x\n', 'utf8');
    const refused = main(['--repo', fixture.repo, '--body', bodyPath], {});
    assert.equal(refused.code, 2);
    assert.match(refused.output.error, /missing heading/);

    // The real process, as the skill runs it.
    fs.writeFileSync(bodyPath, BODY, 'utf8');
    const stdout = execFileSync(process.execPath, [SCRIPT, '--repo', fixture.repo, '--body', bodyPath, '--session-id', 'sess-10'], { encoding: 'utf8' });
    assert.equal(JSON.parse(stdout.trim()).id, 'session-sess-10');
  } finally {
    fixture.cleanup();
  }
});
