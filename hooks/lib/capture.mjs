/**
 * The capture itself: transcript in, one merged note on disk out.
 *
 * Lives beside the hook rather than inside it so the whole pipeline can be
 * driven from a test with a fixture transcript, a fixture vault and a stubbed
 * `git`. `session-capture.mjs` is the thin process wrapper around this.
 *
 * Order of business, and why: every cheap and certain thing happens first
 * (transcript, prompts, paths, collection), the one subprocess happens last and
 * only if the clock allows, and the write happens whatever the clock says. A
 * note missing its `commits:` is worth having; a note that never got written
 * because `git log` was slow is not.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  BUDGET_MS,
  MAIN_TRANSCRIPT_MAX_BYTES,
  MAX_ARTIFACTS,
  MAX_CHILD_SESSIONS,
  MAX_CWDS_SEEN,
  MAX_DOCS_TOUCHED,
  MAX_FILES_LISTED,
  MAX_MEMORY_FILES,
  MAX_PRS,
  MAX_REPOS_TOUCHED,
  RESERVE_MS,
  RESUME_REASON,
  STATUS_ACTIVE,
  STATUS_CONCLUDED,
} from './constants.mjs';
import { deriveCollection } from './collection.mjs';
import { collectCommits, runGitSync } from './git-log.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import {
  ACTION_CREATE,
  ACTION_MERGE,
  ACTION_NOOP,
  ACTION_RESUME,
  markSuperseded,
  planWrite,
} from './merge.mjs';
import { buildFields, noteFilename, noteId, renderBody, renderNote } from './note.mjs';
import { classifyPaths, makeRepoResolver } from './paths.mjs';
import { resolveRepo } from './repo.mjs';
import { classify } from './tags.mjs';
import { isoDate, toPosix, uniqueCapped } from './text.mjs';
import {
  createAccumulator,
  extractPrompts,
  extractSubagentTools,
  extractTools,
  parentSessionFromPath,
  readEntries,
  resolveTranscript,
  scanToolResults,
} from './transcript.mjs';

/** A resume chain longer than this is a bug, not a work pattern. */
const MAX_RESUME_INDEX = 50;

/**
 * Capture one finished session.
 *
 * @returns {{written: boolean, action: string, skip: string, notePath: string,
 *            vaultRoot: string, detail: string}}
 */
export function capture({
  input,
  vaultRoot,
  projectsRoot,
  startedAtMs = Date.now(),
  deadlineAt = startedAtMs + BUDGET_MS,
  runGit = runGitSync,
}) {
  const skip = (reason) => ({ written: false, action: 'skip', skip: reason, notePath: '', vaultRoot, detail: '' });

  const transcriptPath = resolveTranscript({
    declaredPath: input.transcriptPath,
    sessionId: input.sessionId,
    cwd: input.cwd,
    projectsRoot,
    deadlineAt,
  });
  if (!transcriptPath) return skip('no transcript found');

  const entries = readEntries(transcriptPath, MAIN_TRANSCRIPT_MAX_BYTES);
  if (entries.length === 0) return skip('transcript unreadable or empty');

  const prompts = extractPrompts(entries);
  if (prompts.length === 0) return skip('no user prompts (trivial session)');

  if (!vaultAvailable(vaultRoot)) return skip(`vault root unavailable (${vaultRoot})`);

  const accumulator = createAccumulator();
  extractTools(entries, accumulator);
  const subagents = extractSubagentTools({
    transcriptPath,
    sessionId: input.sessionId,
    into: accumulator,
    deadlineAt: deadlineAt - RESERVE_MS,
  });
  scanToolResults(entries, accumulator);

  const timing = deriveTiming(entries);
  const cwdsSeen = uniqueCapped(entries.map((entry) => toPosix(entry.cwd)).filter(Boolean), MAX_CWDS_SEEN);
  const hookCwd = input.cwd || cwdsSeen[cwdsSeen.length - 1] || '';

  const repo = resolveRepo(hookCwd);
  const { area, collection, collectionSource } = deriveCollection({ cwd: hookCwd, vaultRoot, repo });
  const branch = repo.branch || lastBranchSeen(accumulator) || '';

  const paths = classifyPaths(sortedFiles(accumulator), {
    repoFor: makeRepoResolver(),
    maxFiles: MAX_FILES_LISTED,
    maxDocs: MAX_DOCS_TOUCHED,
    maxMemory: MAX_MEMORY_FILES,
    maxRepos: MAX_REPOS_TOUCHED,
  });

  const { tags, phase } = classify({
    files: paths.files,
    docsTouched: paths.docsTouched,
    commandTexts: accumulator.commandTexts,
    promptTexts: prompts.map((prompt) => prompt.text),
    skills: [...accumulator.skills],
    toolNames: [...accumulator.toolCounts.keys()],
    branch,
  });

  const git = deriveCommits({ repo, timing, runGit, deadlineAt });
  const concluded = input.endReason !== RESUME_REASON;

  const context = {
    sessionId: input.sessionId,
    noteId: noteId(input.sessionId),
    collection,
    collectionSource,
    date: isoDate(timing.endedAt) || isoDate(new Date().toISOString()),
    cwd: hookCwd,
    cwdsSeen,
    endReason: input.endReason,
    startedAt: timing.startedAt,
    endedAt: timing.endedAt,
    durationMs: timing.durationMs,
    status: concluded ? STATUS_CONCLUDED : STATUS_ACTIVE,
    concludedAt: concluded ? timing.endedAt : '',
    repo: repo.repoFullName,
    branch,
    worktree: repo.worktree,
    reposTouched: paths.reposTouched,
    phase,
    tags,
    supersedes: [],
    resumedFrom: '',
    parentSession: input.parentSession || parentSessionFromPath(transcriptPath),
    childSessions: uniqueCapped(subagents.agentIds, MAX_CHILD_SESSIONS),
    commits: git.shas,
    prs: uniqueCapped([...accumulator.prNumbers, ...git.prs], MAX_PRS),
    memoryFiles: paths.memoryFiles,
    planFile: paths.planFile,
    docsTouched: paths.docsTouched,
    artifacts: uniqueCapped(accumulator.artifacts, MAX_ARTIFACTS),
    files: paths.files,
    prompts,
    commands: accumulator.commands,
    commandCount: accumulator.commandCount,
    agents: accumulator.agents,
    skills: [...accumulator.skills],
    toolCounts: sortedToolCounts(accumulator),
    subagentFilesRead: subagents.filesRead,
    transcriptPath,
  };

  const sessionsDir = path.join(vaultRoot, area, collection, 'sessions');
  return writeNote({ context, sessionsDir, area, collection, vaultRoot });
}

// -------------------------------------------------------------- the write

function writeNote({ context, sessionsDir, area, collection, vaultRoot }) {
  const next = buildFields(context);
  const targetPath = path.join(sessionsDir, noteFilename(context.sessionId));

  const current = readNote(targetPath);
  if (current.error) {
    // An unreadable note is a note somebody may have hand-edited into a shape
    // this parser does not know. Refusing to write is the only safe answer.
    return { written: false, action: 'skip', skip: `existing note unreadable: ${current.error}`, notePath: targetPath, vaultRoot, detail: '' };
  }

  const plan = planWrite(current.fields, next);
  if (plan.action === ACTION_NOOP) {
    return { written: false, action: ACTION_NOOP, skip: plan.reason, notePath: targetPath, vaultRoot, detail: '' };
  }

  if (plan.action === ACTION_RESUME) {
    return writeResumeNote({ context, sessionsDir, area, collection, vaultRoot, previous: current, plan, previousPath: targetPath });
  }

  const fields = plan.fields;
  const text = renderNote(fields, renderBody(context, fields));
  const result = persist(targetPath, text);
  if (!result.ok) {
    return { written: false, action: 'skip', skip: `write failed (${result.error})`, notePath: targetPath, vaultRoot, detail: '' };
  }

  return {
    written: true,
    action: plan.action === ACTION_CREATE ? ACTION_CREATE : ACTION_MERGE,
    skip: '',
    notePath: targetPath,
    vaultRoot,
    detail: `${area}/${collection}/sessions/${path.basename(targetPath)}`,
  };
}

/**
 * A resume that arrives after the note settled becomes a new note, and the note
 * it continues is marked `superseded` (R-27.2, Stack 2026-09-14). Ids never
 * change meaning, so a row already in the store stays the row it was.
 */
function writeResumeNote({ context, sessionsDir, area, collection, vaultRoot, previous, plan, previousPath }) {
  const index = nextFreeResumeIndex(sessionsDir, context.sessionId);
  if (index === 0) {
    return { written: false, action: 'skip', skip: 'resume chain is implausibly long', notePath: '', vaultRoot, detail: '' };
  }

  const fields = { ...plan.fields, id: noteId(context.sessionId, index) };
  const resumedContext = { ...context, noteId: fields.id };
  const targetPath = path.join(sessionsDir, noteFilename(context.sessionId, index));

  const written = persist(targetPath, renderNote(fields, renderBody(resumedContext, fields)));
  if (!written.ok) {
    return { written: false, action: 'skip', skip: `write failed (${written.error})`, notePath: targetPath, vaultRoot, detail: '' };
  }

  // Only after the successor exists: a crash between the two leaves a complete
  // note and a stale status, never a superseded note with no successor.
  const supersededText = renderNote(markSuperseded(previous.fields), previous.body);
  const flipped = persist(previousPath, supersededText);

  return {
    written: true,
    action: ACTION_RESUME,
    skip: '',
    notePath: targetPath,
    vaultRoot,
    detail:
      `${area}/${collection}/sessions/${path.basename(targetPath)} ` +
      `supersedes=${path.basename(previousPath)}${flipped.ok ? '' : ' (status flip failed)'}`,
  };
}

function readNote(notePath) {
  let raw;
  try {
    raw = fs.readFileSync(notePath, 'utf8');
  } catch {
    return { fields: null, body: '', error: '' }; // absent is not an error
  }
  const parsed = parseFrontmatter(raw);
  if (!parsed.ok) return { fields: null, body: '', error: parsed.error };
  if (Object.keys(parsed.fields).length === 0) return { fields: null, body: '', error: 'no frontmatter' };
  return { fields: parsed.fields, body: parsed.body.replace(/^\n+/, ''), error: '' };
}

function persist(notePath, text) {
  try {
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, text, 'utf8');
    return { ok: true, error: '' };
  } catch (err) {
    return { ok: false, error: err?.code || err?.message || 'unknown' };
  }
}

function nextFreeResumeIndex(sessionsDir, sessionId) {
  for (let index = 2; index <= MAX_RESUME_INDEX; index += 1) {
    if (!fs.existsSync(path.join(sessionsDir, noteFilename(sessionId, index)))) return index;
  }
  return 0;
}

// ------------------------------------------------------------- derivations

function vaultAvailable(vaultRoot) {
  if (!vaultRoot) return false;
  // Auto-create inside an existing parent only. If OneDrive is unmounted the
  // parent is gone too, and inventing a vault on the wrong drive is worse than
  // skipping one session.
  return fs.existsSync(vaultRoot) || fs.existsSync(path.dirname(vaultRoot));
}

function deriveTiming(entries) {
  // Transcript order is chronological, but a resumed session interleaves files;
  // sorting the stamps costs nothing and removes the assumption.
  const stamps = entries
    .map((entry) => entry.timestamp)
    .filter((stamp) => typeof stamp === 'string' && stamp)
    .sort();
  const startedAt = stamps[0] || '';
  const endedAt = stamps[stamps.length - 1] || '';
  const durationMs = startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : Number.NaN;
  return { startedAt, endedAt, durationMs };
}

function deriveCommits({ repo, timing, runGit, deadlineAt }) {
  if (!repo.mainRoot || !timing.startedAt) return { shas: [], prs: [] };
  if (Date.now() > deadlineAt - RESERVE_MS) return { shas: [], prs: [] };
  const result = collectCommits({
    repoRoot: repo.mainRoot,
    since: timing.startedAt,
    until: timing.endedAt,
    runGit,
  });
  return { shas: result.shas, prs: result.prs };
}

function sortedFiles(accumulator) {
  return [...accumulator.files.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function sortedToolCounts(accumulator) {
  return [...accumulator.toolCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function lastBranchSeen(accumulator) {
  const branches = [...accumulator.branches];
  return branches.length ? branches[branches.length - 1] : '';
}
