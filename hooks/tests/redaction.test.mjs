/**
 * The hook never writes a credential.
 *
 * Two layers, deliberately independent. The unit tests check each rule against
 * the shape it is for; the fixture test renders a whole note from a transcript
 * seeded with a live-looking JWT, an `sb_` key, a GitHub token, an OpenAI key
 * and a connection string, and then greps the rendered bytes with patterns that
 * know nothing about the rules. A rule that stops matching fails the second
 * check even if someone edited the first.
 *
 * (Every secret in the fixture is synthetic: invented strings in the right
 * shape, never a credential that existed.)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { looksRedacted, redact } from '../lib/redact.mjs';
import { GOLDEN_DIR, createSandbox, readNote } from './helpers/sandbox.mjs';
import { SCENARIOS, runScenario } from './helpers/scenarios.mjs';

const CREDENTIAL_SCENARIO = SCENARIOS.find((scenario) => scenario.name === 'credentials');

test('a note rendered from a credential-seeded transcript carries no secret', () => {
  const sandbox = createSandbox();
  try {
    const outcome = runScenario(sandbox, CREDENTIAL_SCENARIO);
    assert.equal(outcome.written, true);

    const note = readNote(sandbox, CREDENTIAL_SCENARIO.note);
    assert.ok(looksRedacted(note), 'a credential shape survived into the note');

    for (const secret of [
      'Sup3rSecretPassw0rd',
      'sb_secret_9aQZ1kLmNOPqrstuvwxyz0123456789ab',
      'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
      'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
      'hunter2hunter2',
      'QmFkU2lnbmF0dXJlRm9yVGVzdHM',
    ]) {
      assert.ok(!note.includes(secret), `the note contains ${secret.slice(0, 12)}…`);
    }

    // The non-secret context around it is still readable — redaction that eats
    // the sentence is redaction nobody can review.
    assert.ok(note.includes('aws-0-us-east-1.pooler.supabase.com'));
    assert.ok(note.includes('[REDACTED-JWT]'));
  } finally {
    sandbox.cleanup();
  }
});

test('no golden note anywhere carries a credential shape', () => {
  for (const scenario of SCENARIOS) {
    const raw = fs.readFileSync(path.join(GOLDEN_DIR, `${scenario.name}.md`), 'utf8');
    assert.ok(looksRedacted(raw), `${scenario.name} looks like it carries a credential`);
  }
});

test('each rule redacts the shape it is for', () => {
  const cases = [
    ['SUPABASE_SERVICE_ROLE_KEY=abc123def456', /\[REDACTED\]/],
    ['api_key: "wq8fh38fh3f8h3"', /\[REDACTED\]/],
    ['postgresql://user:p%40ssw0rd@host:5432/db', /user:\[REDACTED\]@/],
    ['eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSM', /\[REDACTED-JWT\]/],
    ['sb_publishable_AbCdEfGhIjKlMnOpQrSt', /\[REDACTED-KEY\]/],
    ['ghp_0123456789abcdefghijABCDEFGHIJ', /\[REDACTED-KEY\]/],
    ['sk-abcdefghijklmnopqrstuvwxyz', /\[REDACTED-KEY\]/],
    ['AKIAIOSFODNN7EXAMPLE', /\[REDACTED-KEY\]/],
    ['xoxb-123456789012-abcdefghij', /\[REDACTED-KEY\]/],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz', /\[REDACTED\]/],
    [
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpQIB\n-----END RSA PRIVATE KEY-----',
      /\[REDACTED-PRIVATE-KEY\]/,
    ],
  ];
  for (const [input, expected] of cases) {
    assert.match(redact(input), expected, `not redacted: ${input.slice(0, 40)}`);
  }
});

test('redaction leaves ordinary text alone', () => {
  const plain = 'cd ingest && uv run pytest -q  # 261 passed';
  assert.equal(redact(plain), plain);
  assert.equal(redact('https://github.com/emstacho-su/bb2dash/pull/6'), 'https://github.com/emstacho-su/bb2dash/pull/6');
});

test('redact never throws on non-strings', () => {
  assert.equal(redact(null), '');
  assert.equal(redact(undefined), '');
  assert.equal(redact(42), '');
  assert.equal(redact(''), '');
});
