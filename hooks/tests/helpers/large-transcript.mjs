/**
 * Build a transcript big enough to be the worst case, without committing one.
 *
 * The largest real transcript on this machine is 4.6 MB with ~60 MB of subagent
 * files beside it. Committing that would be both a privacy problem and a 60 MB
 * repository, so the budget test generates a bigger one instead: same entry
 * shapes, synthetic content, sized by the caller.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Roughly this many bytes of filler per assistant turn. */
const FILLER_CHARS = 900;

const FILLER =
  'The transform driver folds each crawl into the typed tables, quarantining ' +
  'rows whose course id the folder rule cannot map. '.repeat(12);

function line(object) {
  return `${JSON.stringify(object)}\n`;
}

/**
 * @param {object} options
 * @param {string} options.sessionId
 * @param {string} options.cwd        a real checkout, so git resolution is real
 * @param {string} options.branch
 * @param {number} options.targetBytes
 */
export function buildTranscript({ sessionId, cwd, branch, targetBytes }) {
  const parts = [];
  let bytes = 0;
  let index = 0;
  const started = Date.parse('2026-09-11T09:00:00.000Z');

  const stamp = () => new Date(started + index * 1000).toISOString();

  while (bytes < targetBytes) {
    index += 1;
    const timestamp = stamp();
    const common = { cwd, gitBranch: branch, sessionId, version: '2.1.267', timestamp };

    if (index % 25 === 1) {
      parts.push(
        line({
          type: 'user',
          isSidechain: false,
          origin: { kind: 'human' },
          message: { role: 'user', content: [{ type: 'text', text: `Step ${index}: ${FILLER.slice(0, 200)}` }] },
          uuid: `u${index}`,
          ...common,
        }),
      );
    } else if (index % 3 === 0) {
      parts.push(
        line({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: `toolu_${index}`,
                name: index % 6 === 0 ? 'Bash' : 'Edit',
                input:
                  index % 6 === 0
                    ? { command: `uv run pytest -q tests/test_${index}.py`, description: `Run suite ${index}` }
                    : { file_path: `${cwd}/ingest/src/ingest/module_${index % 40}.py` },
              },
            ],
          },
          uuid: `a${index}`,
          ...common,
        }),
      );
    } else {
      parts.push(
        line({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: FILLER.slice(0, FILLER_CHARS) }] },
          uuid: `a${index}`,
          ...common,
        }),
      );
    }
    bytes += parts[parts.length - 1].length;
  }
  return parts.join('');
}

/**
 * Write a large main transcript plus `subagentCount` subagent transcripts.
 *
 * @returns {{transcriptPath: string, totalBytes: number}}
 */
export function installLargeTranscript({
  dir,
  sessionId,
  cwd,
  branch,
  mainBytes,
  subagentCount,
  subagentBytes,
}) {
  fs.mkdirSync(dir, { recursive: true });
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  const main = buildTranscript({ sessionId, cwd, branch, targetBytes: mainBytes });
  fs.writeFileSync(transcriptPath, main, 'utf8');
  let totalBytes = main.length;

  const subagentDir = path.join(dir, sessionId, 'subagents');
  fs.mkdirSync(subagentDir, { recursive: true });
  for (let index = 0; index < subagentCount; index += 1) {
    const body = buildTranscript({ sessionId, cwd, branch, targetBytes: subagentBytes });
    fs.writeFileSync(path.join(subagentDir, `agent-${String(index).padStart(4, '0')}.jsonl`), body, 'utf8');
    totalBytes += body.length;
  }
  return { transcriptPath, totalBytes };
}
