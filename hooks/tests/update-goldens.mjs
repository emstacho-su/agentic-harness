#!/usr/bin/env node
/**
 * Regenerate the golden notes.
 *
 * Approval testing only works if regenerating is easy and reviewing the diff is
 * mandatory. Run this, then read `git diff hooks/tests/fixtures/golden/` line by
 * line: every change there is a change to what `ingest` will store.
 *
 *   node hooks/tests/update-goldens.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

import { GOLDEN_DIR, createSandbox, readNote } from './helpers/sandbox.mjs';
import { SCENARIOS, SUBAGENT_SCENARIOS, runScenario, runSubagentScenario } from './helpers/scenarios.mjs';

let written = 0;
fs.mkdirSync(GOLDEN_DIR, { recursive: true });

for (const scenario of SCENARIOS) {
  const sandbox = createSandbox();
  try {
    const outcome = runScenario(sandbox, scenario);
    if (!outcome.written) {
      console.error(`FAILED ${scenario.name}: ${outcome.action} ${outcome.skip}`);
      process.exitCode = 1;
      continue;
    }
    fs.writeFileSync(path.join(GOLDEN_DIR, `${scenario.name}.md`), readNote(sandbox, scenario.note), 'utf8');
    written += 1;
    console.log(`wrote golden/${scenario.name}.md`);
  } finally {
    sandbox.cleanup();
  }
}

for (const scenario of SUBAGENT_SCENARIOS) {
  const sandbox = createSandbox();
  try {
    const outcome = runSubagentScenario(sandbox, scenario);
    if (!outcome.written) {
      console.error(`FAILED ${scenario.name}: ${outcome.action} ${outcome.skip}`);
      process.exitCode = 1;
      continue;
    }
    fs.writeFileSync(path.join(GOLDEN_DIR, `${scenario.name}.md`), readNote(sandbox, scenario.note), 'utf8');
    written += 1;
    console.log(`wrote golden/${scenario.name}.md`);
  } finally {
    sandbox.cleanup();
  }
}

const total = SCENARIOS.length + SUBAGENT_SCENARIOS.length;
console.log(`${written}/${total} goldens written to ${GOLDEN_DIR}`);
