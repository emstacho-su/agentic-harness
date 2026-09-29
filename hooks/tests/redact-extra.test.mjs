/**
 * Per-machine redaction rules (R-106, H-6).
 *
 * `HARNESS_REDACT_EXTRA` names a JSON file of extra patterns. The loader
 * validates and compiles it; a missing file, malformed JSON or a bad pattern is
 * reported once and skipped, never thrown, because the hook must still write
 * its note. `redact()` applies the installed rules after the built-in ones.
 *
 * Every rule in these files is invented: an internal hostname, a ticket prefix.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installExtraRules, installedExtraRules, redact, SECRET_RULES } from '../lib/redact.mjs';
import {
  EXTRA_RULES_ENV_VAR,
  MAX_EXTRA_RULES,
  installExtraRulesFrom,
  loadExtraRules,
} from '../lib/redact-extra.mjs';
import { run as runCollect } from '../collect-checkpoints.mjs';
import { run as runSweep } from '../sweep-transcripts.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'redact-extra-'));
}

function writeRules(dir, content, name = 'extra.json') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return file;
}

/** Collect every report line, so a test can count them. */
function reporter() {
  const lines = [];
  return { lines, report: (line) => lines.push(line) };
}

function withRules(rules, body) {
  installExtraRules(rules);
  try {
    return body();
  } finally {
    installExtraRules([]);
  }
}

test('no variable set: no rules, no report', () => {
  const { lines, report } = reporter();
  assert.deepEqual(loadExtraRules({}, report), []);
  assert.deepEqual(lines, []);
});

test('a valid file compiles to global rules with the default marker', () => {
  const dir = tempDir();
  try {
    const file = writeRules(dir, {
      rules: [
        { name: 'corp-host', pattern: 'intranet\\.acme\\.example', flags: 'i' },
        { name: 'ticket', pattern: 'ACME-[0-9]{4,}', to: '[TICKET]' },
      ],
    });
    const { lines, report } = reporter();
    const rules = loadExtraRules({ [EXTRA_RULES_ENV_VAR]: file }, report);
    assert.deepEqual(lines, []);
    assert.equal(rules.length, 2);
    assert.ok(rules.every((rule) => rule.re.flags.includes('g')), 'g is always added');
    assert.ok(rules[0].re.flags.includes('i'));
    withRules(rules, () => {
      assert.equal(
        redact('see INTRANET.acme.example and intranet.acme.example about ACME-12345'),
        'see [REDACTED:corp-host] and [REDACTED:corp-host] about [TICKET]',
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extras run after the built-in rules', () => {
  // This pattern can only match text a built-in rule produced, so it fires
  // only if the built-ins ran first.
  withRules([{ name: 'order', re: /\[REDACTED-JWT\]/g, to: '[REDACTED:order]' }], () => {
    assert.equal(redact('token eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSM here'), 'token [REDACTED:order] here');
  });
});

test('the marker is literal: $-sequences in "to" are not expanded', () => {
  const dir = tempDir();
  try {
    const file = writeRules(dir, { rules: [{ name: 'dollar', pattern: '(secretword)', to: '[$1 $&]' }] });
    withRules(loadExtraRules({ [EXTRA_RULES_ENV_VAR]: file }), () => {
      assert.equal(redact('a secretword b'), 'a [$1 $&] b');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing file is reported once and skipped', () => {
  const dir = tempDir();
  try {
    const { lines, report } = reporter();
    const rules = loadExtraRules({ [EXTRA_RULES_ENV_VAR]: path.join(dir, 'absent.json') }, report);
    assert.deepEqual(rules, []);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /absent\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed JSON is reported once, without its content, and skipped', () => {
  const dir = tempDir();
  try {
    const file = writeRules(dir, '{"rules": [ {"name": "x", "pattern": "hunter2hunter2" ');
    const { lines, report } = reporter();
    assert.deepEqual(loadExtraRules({ [EXTRA_RULES_ENV_VAR]: file }, report), []);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /not valid JSON/);
    assert.ok(!lines[0].includes('hunter2'), 'the report must not echo the file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file without a rules array is reported once and skipped', () => {
  const dir = tempDir();
  try {
    for (const content of [[], { rules: 'x' }, null, 'plain']) {
      const file = writeRules(dir, content);
      const { lines, report } = reporter();
      assert.deepEqual(loadExtraRules({ [EXTRA_RULES_ENV_VAR]: file }, report), []);
      assert.equal(lines.length, 1, JSON.stringify(content));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a bad pattern is reported once, without the pattern, and only that rule is skipped', () => {
  const dir = tempDir();
  try {
    const file = writeRules(dir, {
      rules: [
        { name: 'broken', pattern: '(hunter2hunter2' },
        { name: 'good', pattern: 'intranet\\.acme\\.example' },
      ],
    });
    const { lines, report } = reporter();
    const rules = loadExtraRules({ [EXTRA_RULES_ENV_VAR]: file }, report);
    assert.deepEqual(rules.map((rule) => rule.name), ['good']);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /broken/);
    assert.ok(!lines[0].includes('hunter2'), 'a RegExp error message quotes the pattern; the report must not');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('each invalid rule shape is refused', () => {
  const dir = tempDir();
  try {
    const bad = [
      { pattern: 'no-name' },
      { name: 'bad name!', pattern: 'x+' },
      { name: 'no-pattern' },
      { name: 'empty-pattern', pattern: '' },
      { name: 'bad-flags', pattern: 'x+', flags: 'gy' },
      { name: 'dup-flags', pattern: 'x+', flags: 'ii' },
      { name: 'matches-empty', pattern: 'x*' },
      { name: 'bad-to', pattern: 'x+', to: 42 },
      { name: 'long', pattern: 'a'.repeat(2000) },
      'not an object',
    ];
    const file = writeRules(dir, { rules: [...bad, { name: 'ok', pattern: 'x+' }, { name: 'ok', pattern: 'y+' }] });
    const { lines, report } = reporter();
    const rules = loadExtraRules({ [EXTRA_RULES_ENV_VAR]: file }, report);
    assert.deepEqual(rules.map((rule) => rule.name), ['ok']);
    assert.equal(lines.length, bad.length + 1, lines.join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a relative path is refused: a hook runs in the session cwd', () => {
  const { lines, report } = reporter();
  assert.deepEqual(loadExtraRules({ [EXTRA_RULES_ENV_VAR]: 'extra.json' }, report), []);
  assert.equal(lines.length, 1);
});

test('more rules than the cap keeps the first MAX_EXTRA_RULES and says so', () => {
  const dir = tempDir();
  try {
    const rules = Array.from({ length: MAX_EXTRA_RULES + 3 }, (_, i) => ({ name: `r${i}`, pattern: `word${i}x` }));
    const file = writeRules(dir, { rules });
    const { lines, report } = reporter();
    assert.equal(loadExtraRules({ [EXTRA_RULES_ENV_VAR]: file }, report).length, MAX_EXTRA_RULES);
    assert.equal(lines.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installExtraRules ignores anything that is not a compiled global rule', () => {
  withRules([null, { name: 'x', re: /x/, to: '' }, { name: 'y', re: 'y', to: '' }, { name: 'z', re: /z/g, to: '[Z]' }], () => {
    assert.deepEqual(installedExtraRules().map((rule) => rule.name), ['z']);
    assert.equal(redact('xyz'), 'xy[Z]');
  });
});

test('installing extras leaves the built-in rules alone', () => {
  const before = SECRET_RULES.length;
  withRules([{ name: 'z', re: /z/g, to: '[Z]' }], () => {
    assert.equal(SECRET_RULES.length, before);
    assert.ok(Object.isFrozen(installedExtraRules()));
  });
  assert.deepEqual(installedExtraRules(), []);
});

test('redact.mjs keeps zero imports (it ships as a /checkpoint payload file)', () => {
  const source = fs.readFileSync(new URL('../lib/redact.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /\brequire\s*\(/);
});

// ------------------------------------------------------------ install points

function extrasEnv(dir) {
  const file = writeRules(dir, { rules: [{ name: 'corp-host', pattern: 'intranet\\.acme\\.example' }] });
  // A machine file that does not exist, so the real one never leaks in.
  return { [EXTRA_RULES_ENV_VAR]: file, HARNESS_MACHINE_ENV: path.join(dir, 'no-machine.env') };
}

test('installExtraRulesFrom installs what it loads and returns the count', () => {
  const dir = tempDir();
  try {
    try {
      assert.equal(installExtraRulesFrom(extrasEnv(dir)), 1);
      assert.equal(redact('intranet.acme.example'), '[REDACTED:corp-host]');
    } finally {
      installExtraRules([]);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, run] of [['sweep-transcripts', runSweep], ['collect-checkpoints', runCollect]]) {
  test(`${name} installs the machine's extra rules before it does anything`, () => {
    const dir = tempDir();
    try {
      try {
        const out = [];
        assert.equal(run(['--help'], { env: extrasEnv(dir), out: (line) => out.push(line), err: () => {} }), 0);
        assert.deepEqual(installedExtraRules().map((rule) => rule.name), ['corp-host']);
      } finally {
        installExtraRules([]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
