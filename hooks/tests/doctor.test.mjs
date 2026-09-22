import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { diagnose, realmsOnDisk } from '../doctor.mjs';

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('realmsOnDisk reads a root marker, or one per top-level folder', () => {
  const { root, cleanup } = scratch();
  try {
    fs.mkdirSync(path.join(root, 'projects'));
    fs.mkdirSync(path.join(root, 'daily'));
    fs.writeFileSync(path.join(root, 'projects', '.realm'), 'projects\n');
    assert.deepEqual(realmsOnDisk(root), [{ folder: 'projects', name: 'projects' }]);
    fs.writeFileSync(path.join(root, '.realm'), 'personal\n');
    assert.deepEqual(realmsOnDisk(root), [{ folder: '.', name: 'personal' }]);
    assert.deepEqual(realmsOnDisk(path.join(root, 'absent')), []);
  } finally {
    cleanup();
  }
});

test('diagnose reports the machine file, an unlisted realm, and never a secret value', () => {
  const { root, cleanup } = scratch();
  try {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, 'work-vm'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'work-vm', '.realm'), 'work-vm\n');
    const machineFile = path.join(root, 'machine.env');
    fs.writeFileSync(machineFile, `HARNESS_VAULT=${vault}\nHARNESS_MACHINE=vm\nHARNESS_REALMS=projects:push\nDATABASE_URL=postgresql://u:hunter2@h/db\n`);

    const rows = Object.fromEntries(diagnose({ HARNESS_MACHINE_ENV: machineFile }, root));
    assert.equal(rows['machine'], 'vm');
    assert.equal(rows['machine file'], machineFile);
    assert.match(rows['realms unlisted'], /work-vm/);
    assert.equal(rows['DATABASE_URL'], 'set');
    assert.ok(!JSON.stringify(rows).includes('hunter2'));
  } finally {
    cleanup();
  }
});
