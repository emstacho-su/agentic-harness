#!/usr/bin/env node
/**
 * What this machine's harness resolved to, in one screen.
 *
 *   node hooks/doctor.mjs
 *
 * Read-only. Every path below is what the hook, the sweep and the ingest would
 * use right now, after ~/.harness/machine.env is loaded; a wrong one here is a
 * wrong one at 03:00. Secrets are reported as present or absent, never shown.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_VAULT_SEGMENTS,
  MACHINE_NAME_VAR,
  VAULT_ENV_VAR,
} from './lib/constants.mjs';
import { DEFAULT_PROJECT_DIR, ENV_PROJECT_DIR, resolveUv } from './lib/enqueue-ingest.mjs';
import { MACHINE_ENV_SEGMENTS, MACHINE_ENV_VAR, loadMachineEnv, loadRepoEnv, machineName } from './lib/machine-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Realm folders on disk: every top-level folder (or the root) carrying `.realm`. */
export function realmsOnDisk(vaultRoot) {
  if (!fs.existsSync(vaultRoot)) return [];
  const read = (dir) => {
    try {
      return fs.readFileSync(path.join(dir, '.realm'), 'utf8').trim();
    } catch {
      return '';
    }
  };
  const root = read(vaultRoot);
  if (root) return [{ folder: '.', name: root }];
  return fs
    .readdirSync(vaultRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ folder: entry.name, name: read(path.join(vaultRoot, entry.name)) }))
    .filter((entry) => entry.name);
}

/** The report as rows; `main` prints them. Exported for the tests. */
export function diagnose(env = process.env, home = os.homedir()) {
  const machineFile = env[MACHINE_ENV_VAR] || path.join(home, ...MACHINE_ENV_SEGMENTS);
  const merged = loadMachineEnv(loadRepoEnv(env, path.resolve(HERE, '..')), home);
  const vaultRoot = merged[VAULT_ENV_VAR] || path.join(home, ...DEFAULT_VAULT_SEGMENTS);
  const projectDir = merged[ENV_PROJECT_DIR] || DEFAULT_PROJECT_DIR;
  const realms = realmsOnDisk(vaultRoot);
  const listed = String(merged.HARNESS_REALMS ?? '')
    .split(',')
    .map((entry) => entry.trim().split(':')[0])
    .filter(Boolean);
  const unlisted = realms.map((r) => r.name).filter((name) => listed.length && !listed.includes(name));
  const uv = resolveUv(merged);
  const distIndex = path.resolve(HERE, '..', 'mcp-server', 'dist', 'index.js');

  return [
    ['machine file', fs.existsSync(machineFile) ? machineFile : `${machineFile} (absent: defaults apply)`],
    ['machine', machineName(merged) || '(unset: notes carry machine: \'\')'],
    ['vault', `${vaultRoot} ${fs.existsSync(vaultRoot) ? '' : '(MISSING)'}`.trim()],
    ['realms on disk', realms.length ? realms.map((r) => `${r.folder}=${r.name}`).join(', ') : '(none: legacy layout)'],
    ['realms listed', listed.length ? listed.join(', ') : '(HARNESS_REALMS unset: any realm on disk is accepted)'],
    ['realms unlisted', unlisted.length ? `${unlisted.join(', ')} — ingest will refuse` : 'none'],
    ['ingest project', `${projectDir} ${fs.existsSync(path.join(projectDir, 'pyproject.toml')) ? '' : '(MISSING pyproject.toml)'}`.trim()],
    ['uv', uv || '(not found: ~/.local/bin or PATH)'],
    ['node', process.execPath],
    ['mcp-server build', fs.existsSync(distIndex) ? distIndex : `${distIndex} (not built: npm run build)`],
    ['DATABASE_URL', merged.DATABASE_URL ? 'set' : 'ABSENT'],
    ['DATABASE_CA_CERT', merged.DATABASE_CA_CERT ? `${merged.DATABASE_CA_CERT} ${fs.existsSync(merged.DATABASE_CA_CERT) ? '' : '(MISSING)'}`.trim() : '(unset)'],
    ['DATABASE_SSL', merged.DATABASE_SSL || '(default: verify-full)'],
    ['transcripts', path.join(home, '.claude', 'projects')],
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const rows = diagnose();
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) console.log(`${label.padEnd(width)}  ${value}`);
}
