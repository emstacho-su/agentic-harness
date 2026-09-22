import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENV_FILE_VAR, MACHINE_ENV_VAR, loadEnvFiles, parseEnvText } from '../src/env-file.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'env-file-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parseEnvText', () => {
  it('reads KEY=value with export prefixes, quotes and comments', () => {
    expect(parseEnvText('# c\nA=1\nexport B="two words"\nC=\'x\'\nD=\n')).toEqual({
      A: '1',
      B: 'two words',
      C: 'x',
      D: '',
    });
  });

  it('refuses a line that is not a pair, by number', () => {
    expect(() => parseEnvText('A=1\nnope\n')).toThrow(/line 2/);
  });
});

describe('loadEnvFiles', () => {
  it('fills in the .env at the repo root and the machine file; the environment wins', () => {
    writeFileSync(path.join(root, '.env'), 'DATABASE_URL=postgresql://from-file\nDATABASE_CA_CERT=/ca\n');
    mkdirSync(path.join(root, 'home', '.harness'), { recursive: true });
    writeFileSync(path.join(root, 'home', '.harness', 'machine.env'), 'DATABASE_SSL=disable\nDATABASE_CA_CERT=/machine-ca\n');

    const env = loadEnvFiles({ DATABASE_URL: 'postgresql://from-shell' }, { repoRoot: root, home: path.join(root, 'home') });

    expect(env.DATABASE_URL).toBe('postgresql://from-shell');
    expect(env.DATABASE_CA_CERT).toBe('/ca');
    expect(env.DATABASE_SSL).toBe('disable');
  });

  it(`${ENV_FILE_VAR} and ${MACHINE_ENV_VAR} relocate the files`, () => {
    writeFileSync(path.join(root, 'elsewhere.env'), 'DATABASE_URL=postgresql://elsewhere\n');
    writeFileSync(path.join(root, 'm.env'), 'FASTEMBED_CACHE_DIR=/cache\n');
    const env = loadEnvFiles(
      { [ENV_FILE_VAR]: path.join(root, 'elsewhere.env'), [MACHINE_ENV_VAR]: path.join(root, 'm.env') },
      { repoRoot: path.join(root, 'nowhere'), home: root },
    );
    expect(env.DATABASE_URL).toBe('postgresql://elsewhere');
    expect(env.FASTEMBED_CACHE_DIR).toBe('/cache');
  });

  it('a missing file is nothing; a malformed one is reported and skipped', () => {
    const problems: string[] = [];
    const clean = loadEnvFiles({ A: '1' }, { repoRoot: root, home: root, report: (m) => problems.push(m) });
    expect(clean).toEqual({ A: '1' });
    expect(problems).toEqual([]);

    writeFileSync(path.join(root, '.env'), 'garbage\n');
    const env = loadEnvFiles({ A: '1' }, { repoRoot: root, home: root, report: (m) => problems.push(m) });
    expect(env).toEqual({ A: '1' });
    expect(problems[0]).toMatch(/line 1/);
  });
});
