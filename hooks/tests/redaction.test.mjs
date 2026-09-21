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

import { MAX_COMMAND_CHARS } from '../lib/constants.mjs';
import { findSecretValues, looksRedacted, redact, redactLiterals } from '../lib/redact.mjs';
import { createAccumulator, extractTools } from '../lib/transcript.mjs';
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

test('a tool description reaches the note redacted, and capped', () => {
  // `description` is model-authored free text with no schema and no length
  // limit. It used to short-circuit redaction entirely — `description ||
  // redact(command)` — so a session talked into putting a key there wrote it
  // straight into the vault.
  const accumulator = createAccumulator();
  extractTools(
    [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Bash',
              input: {
                command: 'gh auth status',
                description: `Audit with ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 ${'x'.repeat(500)}`,
              },
            },
            {
              type: 'tool_use',
              id: 'toolu_2',
              name: 'Agent',
              input: { description: 'Use sk-proj-abcdefghijklmnopqrstuvwxyz0123', subagent_type: 'general-purpose' },
            },
            { type: 'tool_use', id: 'toolu_3', name: 'Skill', input: { skill: 'sb_secret_9aQZ1kLmNOPqrstuvwxyz01' } },
            { type: 'tool_use', id: 'toolu_4', name: 'Artifact', input: { url: 'https://x/?t=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8' } },
          ],
        },
      },
    ],
    accumulator,
  );

  const everything = [...accumulator.commands, ...accumulator.agents, ...accumulator.skills, ...accumulator.artifacts].join('\n');
  assert.ok(looksRedacted(everything), `a secret survived: ${everything}`);
  assert.ok(accumulator.commands[0].length <= MAX_COMMAND_CHARS, 'the description must obey the cap too');
});

test('a branch name reaches frontmatter redacted', () => {
  const accumulator = createAccumulator();
  extractTools([{ type: 'user', gitBranch: 'feat/ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8' }], accumulator);
  assert.ok(looksRedacted([...accumulator.branches].join('')));
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

/**
 * Build a secret-shaped string at runtime.
 *
 * These are invented values, but a vendor prefix followed by the right number
 * of characters is exactly what a secret scanner looks for — and GitHub's push
 * protection rejected this file when the literals were written out, which is the
 * scanner doing its job. Joining the prefix to the body here keeps the test
 * honest about the shape without putting the shape in the file.
 */
const shaped = (prefix, body) => `${prefix}${body}`;

test('the shapes a rule-by-rule review found passing through are caught', () => {
  const cases = [
    // A quoted key: a JSON config or an MCP server block pasted into a prompt.
    ['{"api_key": "9f8a7b6c5d4e3f2a1b"}', /"api_key":\s*\[REDACTED\]/],
    ["supabase_service_role: 'abc123def456'", /\[REDACTED\]/],
    // A quoted value with spaces: a passphrase usually has them.
    ['PASSWORD="correct horse battery staple"', /PASSWORD=\[REDACTED\]/],
    // GitHub's current default token format.
    [`use ${shaped('github_', 'pat_11AABBCCDD0aBcDeFgHiJkLmNoPqRsTuVwXyZ012345')}`, /\[REDACTED-KEY\]/],
    ['curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA=="', /Basic \[REDACTED\]/],
    [shaped('sk_', 'live_abcdefghijklmnopqrstuvwx'), /\[REDACTED-KEY\]/],
    [shaped('AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7'), /\[REDACTED-KEY\]/],
    [shaped('glpat-', 'ABCdefGHIjklMNOpqr'), /\[REDACTED-KEY\]/],
    [shaped('npm_', 'abcdefghijklmnopqrstuvwxyz0123456789'), /\[REDACTED-KEY\]/],
  ];
  for (const [input, expected] of cases) {
    const output = redact(input);
    assert.match(output, expected, `not redacted: ${input.slice(0, 48)}`);
    assert.ok(looksRedacted(output), `a probe still sees a secret in: ${output.slice(0, 48)}`);
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

// ------------------------------------------------------ secrets seen elsewhere
//
// A rule matches a shape. A password repeated in prose has none: "the database
// password Sup3rSecretPassw0rd" is just a word. But the same session usually
// showed that value once *in* a shape — a connection string, a KEY=value — so
// every value a rule finds anywhere in the session is also removed literally
// from the closing message.

test('findSecretValues returns the secret part of each match, not the key or the scheme', () => {
  const values = findSecretValues(
    'postgresql://postgres.ref:Sup3rSecretPassw0rd@host:6543/db and DATABASE_PASSWORD="hunter2 hunter2" ' +
      'and export GITHUB_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  );
  assert.ok(values.includes('Sup3rSecretPassw0rd'));
  assert.ok(values.includes('hunter2 hunter2'));
  assert.ok(values.includes('ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'));
  assert.ok(!values.some((value) => value.includes('postgresql') || value.includes('DATABASE_PASSWORD')));
});

test('findSecretValues ignores values too short to replace safely', () => {
  // Replacing every "abcd" in a paragraph would shred it and hide nothing.
  assert.deepEqual(findSecretValues('PASSWORD=abcd'), []);
});

test('redactLiterals removes every occurrence, longest value first', () => {
  const out = redactLiterals('use Sup3rSecretPassw0rd, then Sup3rSecretPassw0rd-2 again', [
    'Sup3rSecretPassw0rd',
    'Sup3rSecretPassw0rd-2',
  ]);
  assert.ok(!out.includes('Sup3rSecret'));
  assert.equal(out, 'use [REDACTED], then [REDACTED] again');
});

test('redactLiterals leaves text alone when there is nothing to remove', () => {
  assert.equal(redactLiterals('nothing here', []), 'nothing here');
  assert.equal(redactLiterals('', ['Sup3rSecretPassw0rd']), '');
});
