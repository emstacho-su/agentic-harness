/**
 * `PAT` in a key name: a personal access token, or the letters inside `path`?
 *
 * Every `pat` counts as a token name except inside a known lookalike word
 * (`path`, `pattern`, `dispatch`, `compat`, `patient`, `patch`). Reading it the
 * other way round (a word only at a separator or camelCase boundary) leaked
 * `GHPAT=…`, `mypat=…` and `PATS=…`, so the lookalikes are the list, not the
 * tokens.
 *
 * The last test is a differential against the redaction that shipped before
 * the fix (`fixtures/redact-baseline/redact.mjs`, frozen from 00539be): no
 * probe may leak a secret the baseline caught, except a shapeless value after
 * a lookalike key, which is the point of the fix.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BUDGET_MS } from '../lib/constants.mjs';
import * as current from '../lib/redact.mjs';
import * as baseline from './fixtures/redact-baseline/redact.mjs';

const { findSecretMatches, findSecretValues, redact, redactLiterals } = current;

const TOKEN_VALUE = 'Sup3rS3cretTok3nValue99';

const REAL_PAT_KEYS = [
  'PAT', 'pat', 'GH_PAT', 'GITHUB_PAT', 'githubPat', 'GITHUBPAT', 'GHPAT', 'ADOPAT', 'AZDOPAT',
  'ghpat', 'githubpat', 'mypat', 'my_pat', 'PATS', 'PATs', 'pats', 'GH_PATS', 'githubPATs',
  'PATKEY', 'patkey', 'GHPat', 'ADOPat', 'PAT2', 'patValue', 'PAT_VALUE', 'AZURE_DEVOPS_EXT_PAT',
  'PATTOKEN', 'x_pat',
  // A `pat` followed by letters that only start a lookalike word is still a token.
  'PATTKN', 'GHPATTKN', 'patTkn', 'GH_PATTOK', 'PATTEST', 'patTest', 'PATTMP', 'GHPATTMP', 'ghPatTmp',
  'PATTEMP', 'ghpatText', 'GHPATTXT', 'PATTTL',
  // A camelCase word after `pat` is not the rest of `path` or `patch`.
  'patHeader', 'patHash', 'patChain',
];

const LOOKALIKE_KEYS = [
  'path', 'PATH', 'Pattern', 'pattern', 'patterns', 'dispatch', 'dispatcher', 'DISPATCH', 'compat',
  'COMPATIBILITY', 'output_path', 'videosPath', 'spatial', 'patient', 'patch', 'PATCH', 'filepath',
  'xpath', 'classpath', 'PATHEXT', 'paths', 'Paths', 'patches', 'PATCHES', 'compatibility',
];

const FORMS = [
  (key, value) => `${key}=${value}`,
  (key, value) => `${key}: ${value}`,
  (key, value) => `"${key}": "${value}"`,
  (key, value) => `export ${key}="${value}"`,
];

const fullPass = (redaction, text) => redaction.redactLiterals(redaction.redact(text), redaction.findSecretValues(text));

test('every PAT key name, in every assignment form, is found, redacted and flagged by the scan', () => {
  for (const key of REAL_PAT_KEYS) {
    for (const form of FORMS) {
      const line = form(key, TOKEN_VALUE);
      assert.ok(findSecretValues(line).includes(TOKEN_VALUE), `not collected: ${line}`);
      assert.ok(!redact(line).includes(TOKEN_VALUE), `not redacted: ${line}`);
      assert.ok(findSecretMatches(line).length > 0, `not flagged by the scan: ${line}`);
    }
  }
});

test('a PAT value named without a separator is removed from later prose too', () => {
  for (const key of ['GHPAT', 'PATTKN', 'patTest', 'GHPATTXT', 'patHeader']) {
    const text = `${key}=${TOKEN_VALUE}\nLater: rotate ${TOKEN_VALUE}`;
    assert.equal(fullPass(current, text), `${key}=[REDACTED]\nLater: rotate [REDACTED]`);
  }
});

test('a long chain of lookalike assignments is bounded: fast, and the real secret stays redacted', () => {
  const text = `API_TOKEN=${TOKEN_VALUE}\n${'path='.repeat(100_000)}`;
  const started = performance.now();
  const out = fullPass(current, text);
  const elapsed = performance.now() - started;
  assert.ok(!out.includes(TOKEN_VALUE));
  assert.ok(elapsed < BUDGET_MS / 4, `took ${Math.round(elapsed)} ms`);
});

test('a secret nested a few lookalike assignments deep is still caught', () => {
  const text = `path=pattern=dispatch=PASSWORD=${TOKEN_VALUE}`;
  assert.ok(!redact(text).includes(TOKEN_VALUE));
  assert.deepEqual(findSecretValues(text), [TOKEN_VALUE]);
});

test('a lookalike key is not a secret: its value is neither collected, redacted nor flagged', () => {
  for (const key of LOOKALIKE_KEYS) {
    for (const form of FORMS) {
      const line = form(key, 'web/src/lib/progress-status.ts');
      assert.deepEqual(findSecretValues(line), [], line);
      assert.equal(redact(line), line, line);
      assert.deepEqual(findSecretMatches(line), [], line);
    }
  }
});

// ---- differential against the pre-fix redaction ---------------------------

const SHAPED = Object.freeze({
  github: 'ghp_ABCdefGHIjklMNOpqrSTUvwx12',
  fineGrained: 'github_pat_11ABCDEFG0123456789_abcdefghijKLMNOP',
  supabase: 'sb_secret_ABCDEFGHIJKLMNOPqrst',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.abcdEFGHijkl',
  connection: 'postgres://postgres:Hunter2Hunter2x@db.example.co:5432/postgres',
  aws: 'AKIAABCDEFGHIJKLMNOP',
  openai: 'sk-ABCDEFGHIJKLMNOPQRSTUVWXyz12',
});
const SECRETS = [TOKEN_VALUE, SHAPED.github, SHAPED.fineGrained, SHAPED.supabase, SHAPED.jwt,
  'Hunter2Hunter2x', SHAPED.aws, SHAPED.openai];

function differentialProbes() {
  const keys = [...REAL_PAT_KEYS, 'Pat', 'pat_', '_pat', 'personal_access_token', 'patToken', 'pat-token',
    'x-pat', '--pat', 'githubPAT', 'GitHubPAT', 'adoPat', 'AzureDevOpsPAT', 'VSTS_PAT', 'PAT_TOKEN', 'patsecret'];
  const probes = keys.flatMap((key) => FORMS.map((form) => ({ text: form(key, TOKEN_VALUE) })));
  probes.push(...[`--pat=${TOKEN_VALUE}`, `gh auth --pat=${TOKEN_VALUE}`, `x-pat: ${TOKEN_VALUE}`,
    `{"pat":"${TOKEN_VALUE}"}`, `pat:\n  ${TOKEN_VALUE}`].map((text) => ({ text })));
  const values = [...Object.values(SHAPED), `TOKEN=${TOKEN_VALUE}`, `password=${TOKEN_VALUE}`,
    `"a b token: ${TOKEN_VALUE}"`];
  for (const key of ['path', 'pattern', 'Pattern', 'dispatch', 'compat', 'output_path', 'PATH']) {
    for (const value of values) probes.push({ text: `${key}: ${value}` }, { text: `${key}=${value}` });
    // A shapeless value after a lookalike key: the one thing the fix stops redacting.
    probes.push({ text: `${key}: '${TOKEN_VALUE}'`, exempt: true }, { text: `${key}='${TOKEN_VALUE}'`, exempt: true });
  }
  probes.push(...[`path=TOKEN=${TOKEN_VALUE}`, `dispatch: password=${TOKEN_VALUE}`,
    `pattern=GITHUB_PAT=${TOKEN_VALUE}`, `path=a,token=${TOKEN_VALUE}`, `path: "x" token=${TOKEN_VALUE}`,
    `path: /tmp/x\npassword: ${TOKEN_VALUE}\n`, `PATH=/usr/bin:/bin GITHUB_TOKEN=${TOKEN_VALUE}`,
    `path=${TOKEN_VALUE}password=${TOKEN_VALUE}`, `dispatch=${SHAPED.connection}`,
    `path=https://user:${TOKEN_VALUE}@github.com/x.git`].map((text) => ({ text })));
  // Each probe again with its secrets repeated in later prose, for the literal pass.
  return probes.flatMap((probe) => [probe,
    { ...probe, text: `${probe.text}\nLater: rotate ${TOKEN_VALUE} and ${SHAPED.github} now.` }]);
}

test('no probe leaks a secret the pre-fix redaction caught, except a shapeless value after a lookalike key', () => {
  const regressions = [];
  let exempted = 0;
  for (const probe of differentialProbes()) {
    const before = fullPass(baseline, probe.text);
    const after = fullPass(current, probe.text);
    const newLeaks = SECRETS.filter((secret) => after.includes(secret) && !before.includes(secret));
    if (newLeaks.length === 0) continue;
    if (probe.exempt && newLeaks.every((secret) => secret === TOKEN_VALUE)) {
      exempted += 1;
      continue;
    }
    regressions.push({ text: probe.text, after });
  }
  assert.deepEqual(regressions, []);
  assert.ok(exempted > 0, 'the exempt probes should show the fix at work');
});
