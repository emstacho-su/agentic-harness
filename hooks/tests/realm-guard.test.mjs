/**
 * The pre-commit guard (R-A3, R-A4): a name one platform rejects, or a file
 * git hosting rejects, is refused before it can block every later pull.
 *
 * Pure functions, so the whole table runs without a filesystem; sizes come
 * from an injected stat.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ATTACHMENTS_DIR,
  ATTACHMENT_REFUSE_BYTES,
  ATTACHMENT_REPORT_BYTES,
  PATH_REPORT_CHARS,
  checkName,
  checkSize,
  scanRealm,
} from '../lib/realm-guard.mjs';

const MIB = 1024 * 1024;

// ------------------------------------------------------------------- names

test('R-A3: names one platform rejects are refused with the reason', () => {
  const table = [
    ['a:b.md', /reserved character ':'/],
    ['q?.md', /reserved character '\?'/],
    ['notes/<draft>.md', /reserved character '<'/],
    ['pipe|name.md', /reserved character '\|'/],
    ['tab\tname.md', /control character/],
    ['note. ', /ends in a space/],
    ['notes.', /ends in a period/],
    ['trailing./x.md', /ends in a period/],
    ['dir. /x.md', /ends in a space/],
    ['CON.md', /Windows device name 'CON'/],
    ['nul', /Windows device name 'NUL'/],
    ['com1.txt', /Windows device name 'COM1'/],
    ['lpt9/x.md', /Windows device name 'LPT9'/],
    ['Aux.tar.gz', /Windows device name 'AUX'/],
    ['COM0.md', /Windows device name 'COM0'/],
    ['lpt0', /Windows device name 'LPT0'/],
    ['com¹.md', /Windows device name 'COM¹'/],
    ['a\\b.md', /reserved character '\\'/],
    ['café.md', /not in Unicode NFC/],
    ['sub/résumé/x.md', /not in Unicode NFC/],
  ];
  for (const [name, reason] of table) assert.match(checkName(name), reason, name);
});

test('R-A3: ordinary and accented NFC names pass', () => {
  const good = ['a/b.md', 'note .md', 'note..md', 'dir.d/x.md', 'café.md', 'résumé notes.md', 'console.md', 'nulls.md', 'com.md', 'com10.md', 'notes.v2.md', '.obsidian/app.json', 'attachments/Group 3 IST466.pptx'];
  for (const name of good) assert.equal(checkName(name), '', name);
});

// ------------------------------------------------------------------- sizes

test('R-A4: the ceiling is 25 MiB, the report line is 5 MiB, both exclusive', () => {
  assert.equal(ATTACHMENT_REFUSE_BYTES, 25 * MIB);
  assert.equal(ATTACHMENT_REPORT_BYTES, 5 * MIB);
  const at = (bytes) => checkSize(`${ATTACHMENTS_DIR}/deck.pptx`, bytes);
  assert.equal(at(25 * MIB + 1).level, 'refuse');
  assert.match(at(25 * MIB + 1).reason, /over 25 MiB/);
  assert.equal(at(25 * MIB).level, 'report');
  assert.equal(at(5 * MIB + 1).level, 'report');
  assert.match(at(5 * MIB + 1).reason, /over 5 MiB/);
  assert.equal(at(5 * MIB).level, '');
});

test('R-A4: non-markdown outside attachments/ is reported, the policy files and .obsidian settings are not', () => {
  const stray = checkSize('ist466/ethics-case/Group 3 IST466.pptx', 4_907_186);
  assert.equal(stray.level, 'report');
  assert.match(stray.reason, /outside attachments\//);
  assert.equal(checkSize('attachments/small.png', 1024).level, '');
  assert.equal(checkSize('nested/attachments/x.png', 1024).level, 'report', 'only the realm-level attachments/ folder is the home');
  for (const fine of ['.realm', '.gitignore', '.gitattributes', '.obsidian/app.json', '.obsidian/graph.json', 'a/b/note.md', 'NOTE.MD']) {
    assert.equal(checkSize(fine, 1024).level, '', fine);
  }
  assert.equal(checkSize('.obsidian/plugins/foo/data.json', 1024).level, 'report', 'plugin state is not a setting');
  assert.equal(checkSize('a/huge.md', 25 * MIB + 1).level, 'refuse', 'the ceiling applies to markdown too');
});

// -------------------------------------------------------------------- scan

test('scanRealm sorts refusals and reports, keys them by path, and does not touch its input', () => {
  const sizes = { 'z/big.bin': 25 * MIB + 1, 'attachments/deck.pptx': 5 * MIB + 1, 'a/ok.md': 10, 'CON.md': 10, 'stray.env': 10 };
  const paths = Object.keys(sizes);
  const frozen = Object.freeze([...paths]);
  const result = scanRealm(frozen, (p) => sizes[p]);

  assert.deepEqual(result.refused.map((r) => r.path), ['CON.md', 'z/big.bin']);
  assert.match(result.refused[0].reason, /device name/);
  assert.match(result.refused[1].reason, /over 25 MiB/);
  assert.deepEqual(result.reported.map((r) => r.path), ['attachments/deck.pptx', 'stray.env']);
  assert.deepEqual([...frozen], paths);
  assert.ok(Object.isFrozen(result.refused) && Object.isFrozen(result.reported));
});

test('scanRealm: a tracked file deleted from the tree is a deletion to stage, not a refusal', () => {
  const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
  const result = scanRealm(['gone.md', 'a/ok.md'], (p) => {
    if (p === 'gone.md') throw enoent;
    return 10;
  });
  assert.deepEqual(result, { refused: [], reported: [] });
});

test('scanRealm: any other size failure is refused, not skipped', () => {
  const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const result = scanRealm(['locked.md'], () => {
    throw eacces;
  });
  assert.equal(result.refused.length, 1);
  assert.match(result.refused[0].reason, /size unreadable \(EACCES\)/);
});

test('scanRealm on an empty realm is empty', () => {
  assert.deepEqual(scanRealm([], () => 0), { refused: [], reported: [] });
});

test('R-A3: two names that differ only by case are one file on Windows and macOS, so the second is refused', () => {
  const result = scanRealm(['note.md', 'Note.md', 'Sub/A.md', 'sub/a.md', 'other.md'], () => 10);
  assert.deepEqual(result.refused.map((r) => r.path), ['Note.md', 'sub/a.md']);
  assert.match(result.refused[0].reason, /collides with 'note\.md' on a case-insensitive filesystem/);
  assert.match(result.refused[1].reason, /collides with 'Sub\/A\.md'/);
  assert.deepEqual(result.reported, []);
});

test('a path too long for a default Windows checkout is reported, not refused', () => {
  assert.equal(PATH_REPORT_CHARS, 200);
  const long = `${'a'.repeat(PATH_REPORT_CHARS - 2)}.md`;
  assert.equal(long.length, PATH_REPORT_CHARS + 1);
  const result = scanRealm([long, long.slice(1)], () => 10);
  assert.deepEqual(result.refused, []);
  assert.equal(result.reported.length, 1);
  assert.match(result.reported[0].reason, /201 chars.*260/);
});
