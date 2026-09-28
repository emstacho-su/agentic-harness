/**
 * Every CLI in hooks/ acts only when it is the process's entry point.
 *
 * Importing `install.mjs` for its exports once ran a real install against
 * `~/.claude`, because the module called main() at the top level. Each CLI
 * here is imported in a child process whose home is a scratch folder and whose
 * arguments no CLI accepts, so even a missing guard could only fail to parse
 * them; the test then asserts the import printed nothing, wrote nothing and
 * did not end the process.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isEntryPoint } from '../lib/entry-point.mjs';

const HOOKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMPORTED_MARKER = 'imported:ok';
/** No CLI takes this, so a CLI whose guard is missing stops at its argument parse. */
const UNUSABLE_ARGUMENT = '--no-such-flag-entry-point-test';

/** Every top-level .mjs in hooks/: all of them are CLIs or hooks. */
function cliModules() {
  return fs
    .readdirSync(HOOKS_DIR)
    .filter((name) => name.endsWith('.mjs'))
    .sort();
}

function listTree(dir) {
  return fs.readdirSync(dir, { recursive: true }).map((entry) => String(entry).replace(/\\/g, '/')).sort();
}

test('isEntryPoint: the same file under any spelling is the entry point; another file or none is not', () => {
  const file = fileURLToPath(import.meta.url);
  const url = pathToFileURL(file).href;
  assert.equal(isEntryPoint(url, file), true);
  assert.equal(isEntryPoint(url, file.replace(/\\/g, '/')), true);
  assert.equal(isEntryPoint(url, path.relative(process.cwd(), file)), true);
  if (process.platform === 'win32') {
    assert.equal(isEntryPoint(url, file.toUpperCase()), true, 'Windows paths are case-insensitive');
  }
  assert.equal(isEntryPoint(url, path.join(path.dirname(file), 'other.mjs')), false);
  // `undefined` would take the default, process.argv[1], which here is this very file.
  assert.equal(isEntryPoint(url, null), false, 'node -e has no script');
  assert.equal(isEntryPoint(url, ''), false);
  assert.equal(isEntryPoint('not a url', file), false);
});

test('isEntryPoint folds case only on Windows', () => {
  const file = path.join(os.tmpdir(), 'no-such-dir-entry-point', 'Script.mjs');
  const url = pathToFileURL(file).href;
  const lower = path.join(os.tmpdir(), 'no-such-dir-entry-point', 'script.mjs');
  assert.equal(isEntryPoint(url, lower, 'win32'), true);
  assert.equal(isEntryPoint(url, lower, 'linux'), false);
});

for (const name of cliModules()) {
  test(`importing ${name} runs nothing: no output, no file written, the process carries on`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-point-'));
    try {
      const home = path.join(root, 'home');
      fs.mkdirSync(home);
      const importer = path.join(root, 'importer.mjs');
      const url = pathToFileURL(path.join(HOOKS_DIR, name)).href;
      fs.writeFileSync(importer, `await import(${JSON.stringify(url)});\nconsole.log(${JSON.stringify(IMPORTED_MARKER)});\n`);

      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        HARNESS_MACHINE_ENV: path.join(root, 'absent-machine.env'),
        HARNESS_VAULT: path.join(home, 'vault'),
      };
      const result = spawnSync(process.execPath, [importer, UNUSABLE_ARGUMENT], {
        encoding: 'utf8',
        env,
        input: '',
        timeout: 60_000,
      });

      assert.equal(result.status, 0, `${name}: exit ${result.status}\n${result.stderr}`);
      assert.equal(result.stdout, `${IMPORTED_MARKER}\n`, `${name} printed on import or ended the process`);
      assert.equal(result.stderr, '', `${name} wrote to stderr on import`);
      assert.deepEqual(listTree(home), [], `${name} wrote into the home folder on import`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
