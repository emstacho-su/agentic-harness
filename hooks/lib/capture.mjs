/**
 * Capturing a finished session: transcript in, one merged note on disk out.
 *
 * Lives beside the hook rather than inside it so the whole pipeline can be
 * driven from a test with a fixture transcript, a fixture vault and a stubbed
 * `git`. `session-capture.mjs` is the thin process wrapper around this, and
 * `subagent.mjs` is its sibling for `SubagentStop`.
 *
 * The analysis — repository, branch, files, tags, commits — is in
 * `analyse.mjs`, shared with the subagent path. What stays here is the part
 * that is specific to a *session*: its identity, its resume chain, and the
 * write.
 */

import path from 'node:path';

import { analyseTranscript } from './analyse.mjs';
import {
  BUDGET_MS,
  MAIN_TRANSCRIPT_MAX_BYTES,
  MAX_CHILD_SESSIONS,
  RESERVE_MS,
  RESUME_REASON,
  STATUS_ACTIVE,
  STATUS_CONCLUDED,
} from './constants.mjs';
import { runGitSync } from './git-log.mjs';
import {
  ACTION_CREATE,
  ACTION_MERGE,
  ACTION_NOOP,
  ACTION_RESUME,
  markSuperseded,
  planWrite,
} from './merge.mjs';
import { buildFields, childNoteId, noteFilename, noteId, renderBody, renderNote } from './note.mjs';
import { persist, readNote, resolveChainHead, vaultAvailable } from './notes-io.mjs';
import { isoDate, uniqueCapped } from './text.mjs';
import {
  extractPrompts,
  extractSubagentTools,
  extractTools,
  createAccumulator,
  parentSessionFromPath,
  readEntries,
  resolveTranscript,
} from './transcript.mjs';

/**
 * Capture one finished session.
 *
 * `touchedPaths` lists every note this call actually changed on disk, which is
 * not always just `notePath`: a resume also rewrites the note it supersedes.
 * It is what gets handed to the ingest, so a note that was rewritten byte for
 * byte is deliberately absent from it.
 *
 * @returns {{written: boolean, action: string, skip: string, notePath: string,
 *            touchedPaths: string[], vaultRoot: string, detail: string}}
 */
export function capture({
  input,
  vaultRoot,
  projectsRoot,
  startedAtMs = Date.now(),
  deadlineAt = startedAtMs + BUDGET_MS,
  runGit = runGitSync,
}) {
  const skip = (reason) => ({ written: false, action: 'skip', skip: reason, notePath: '', touchedPaths: [], vaultRoot, detail: '' });

  const transcriptPath = resolveTranscript({
    declaredPath: input.transcriptPath,
    sessionId: input.sessionId,
    cwd: input.cwd,
    projectsRoot,
    deadlineAt,
  });
  if (!transcriptPath) return skip('no transcript found');

  const entries = readEntries(transcriptPath, MAIN_TRANSCRIPT_MAX_BYTES, deadlineAt - RESERVE_MS);
  if (entries.length === 0) return skip('transcript unreadable or empty');

  const prompts = extractPrompts(entries);
  if (prompts.length === 0) return skip('no user prompts (trivial session)');

  if (!vaultAvailable(vaultRoot)) return skip(`vault root unavailable (${vaultRoot})`);

  // A subagent's edits are the session's edits, so its transcripts are folded
  // into the same accumulator before anything is derived from it.
  const accumulator = createAccumulator();
  extractTools(entries, accumulator);
  const subagents = extractSubagentTools({
    transcriptPath,
    sessionId: input.sessionId,
    into: accumulator,
    deadlineAt: deadlineAt - RESERVE_MS,
  });

  const facts = analyseTranscript({
    entries,
    prompts,
    cwd: input.cwd,
    vaultRoot,
    deadlineAt,
    runGit,
    into: accumulator,
  });

  const concluded = input.endReason !== RESUME_REASON;

  const context = {
    sessionId: input.sessionId,
    noteId: noteId(input.sessionId),
    collection: facts.collection,
    collectionSource: facts.collectionSource,
    date: isoDate(facts.timing.endedAt) || isoDate(new Date().toISOString()),
    cwd: facts.cwd,
    cwdsSeen: facts.cwdsSeen,
    endReason: input.endReason,
    startedAt: facts.timing.startedAt,
    endedAt: facts.timing.endedAt,
    durationMs: facts.timing.durationMs,
    status: concluded ? STATUS_CONCLUDED : STATUS_ACTIVE,
    concludedAt: concluded ? facts.timing.endedAt : '',
    repo: facts.repo.repoFullName,
    branch: facts.branch,
    worktree: facts.repo.worktree,
    reposTouched: facts.paths.reposTouched,
    phase: facts.phase,
    tags: facts.tags,
    supersedes: [],
    resumedFrom: '',
    parentSession: input.parentSession || parentSessionFromPath(transcriptPath),
    // The child note ids, which are the ingest external_ids, so a search can
    // follow the link straight to the worker's own note. The `SubagentStop`
    // hook writes those notes; this back-fill is what makes the list complete
    // even for children that ended before their parent's note existed.
    childSessions: uniqueCapped(
      subagents.agentIds.map((agentId) => childNoteId(input.sessionId, agentId)),
      MAX_CHILD_SESSIONS,
    ),
    agentType: '',
    commits: facts.commits,
    prs: facts.prs,
    memoryFiles: facts.paths.memoryFiles,
    planFile: facts.paths.planFile,
    docsTouched: facts.paths.docsTouched,
    artifacts: facts.artifacts,
    files: facts.paths.files,
    prompts,
    commands: accumulator.commands,
    commandCount: accumulator.commandCount,
    agents: accumulator.agents,
    skills: [...accumulator.skills],
    toolCounts: facts.toolCounts,
    subagentFilesRead: subagents.filesRead,
    transcriptPath,
  };

  const sessionsDir = path.join(vaultRoot, facts.area, facts.collection, 'sessions');
  return writeNote({ context, sessionsDir, area: facts.area, collection: facts.collection, vaultRoot });
}

// -------------------------------------------------------------- the write

function writeNote({ context, sessionsDir, area, collection, vaultRoot }) {
  const next = buildFields(context);
  // The head of the chain, not the base note: once an `-r2` exists it is the
  // one that carries the session's current state, and planning against the
  // superseded base would fork a new note on every later SessionEnd.
  const head = resolveChainHead(sessionsDir, context.sessionId);
  const targetPath = head.path;

  const current = readNote(targetPath);
  if (current.error) {
    // An unreadable note is a note somebody may have hand-edited into a shape
    // this parser does not know. Refusing to write is the only safe answer.
    return { written: false, action: 'skip', skip: `existing note unreadable: ${current.error}`, notePath: targetPath, touchedPaths: [], vaultRoot, detail: '' };
  }

  const plan = planWrite(current.fields, next);
  if (plan.action === ACTION_NOOP) {
    return { written: false, action: ACTION_NOOP, skip: plan.reason, notePath: targetPath, touchedPaths: [], vaultRoot, detail: '' };
  }

  if (plan.action === ACTION_RESUME) {
    return writeResumeNote({ context, sessionsDir, area, collection, vaultRoot, previous: current, plan, previousPath: targetPath, index: head.nextIndex });
  }

  const fields = plan.fields;
  // The previous body carries anything Stack typed below the generated marker;
  // `renderBody` regenerates the machine sections and re-appends the rest.
  const merged = { ...context, previousBody: current.body };
  const result = persist(targetPath, renderNote(fields, renderBody(merged, fields)));
  if (!result.ok) {
    return { written: false, action: 'skip', skip: `write failed (${result.error})`, notePath: targetPath, touchedPaths: [], vaultRoot, detail: '' };
  }

  return {
    written: true,
    action: plan.action === ACTION_CREATE ? ACTION_CREATE : ACTION_MERGE,
    skip: '',
    notePath: targetPath,
    // Empty when the re-render came out byte-identical: the note on disk is
    // already what the store holds, so an ingest would only re-confirm a hash.
    touchedPaths: result.changed ? [targetPath] : [],
    vaultRoot,
    detail:
      `${area}/${collection}/sessions/${path.basename(targetPath)}` +
      (result.changed ? '' : ' (identical on disk)'),
  };
}

/**
 * A resume that arrives after the note settled becomes a new note, and the note
 * it continues is marked `superseded` (R-27.2, Stack 2026-09-14). Ids never
 * change meaning, so a row already in the store stays the row it was.
 */
function writeResumeNote({ context, sessionsDir, area, collection, vaultRoot, previous, plan, previousPath, index }) {
  if (index === 0) {
    return { written: false, action: 'skip', skip: 'resume chain is implausibly long', notePath: '', touchedPaths: [], vaultRoot, detail: '' };
  }

  const fields = { ...plan.fields, id: noteId(context.sessionId, index) };
  const resumedContext = { ...context, noteId: fields.id };
  const targetPath = path.join(sessionsDir, noteFilename(context.sessionId, index));

  const written = persist(targetPath, renderNote(fields, renderBody(resumedContext, fields)));
  if (!written.ok) {
    return { written: false, action: 'skip', skip: `write failed (${written.error})`, notePath: targetPath, touchedPaths: [], vaultRoot, detail: '' };
  }

  // Only after the successor exists: a crash between the two leaves a complete
  // note and a stale status, never a superseded note with no successor.
  const flipped = persist(previousPath, renderNote(markSuperseded(previous.fields), previous.body));

  return {
    written: true,
    action: ACTION_RESUME,
    skip: '',
    notePath: targetPath,
    // Both notes changed, and both have to be re-ingested: the predecessor's
    // `status: superseded` is a frontmatter-only edit, which is exactly the
    // change the store used to miss.
    touchedPaths: [
      ...(written.changed ? [targetPath] : []),
      ...(flipped.ok && flipped.changed ? [previousPath] : []),
    ],
    vaultRoot,
    detail:
      `${area}/${collection}/sessions/${path.basename(targetPath)} ` +
      `supersedes=${path.basename(previousPath)}${flipped.ok ? '' : ' (status flip failed)'}`,
  };
}
