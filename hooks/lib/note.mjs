/**
 * Rendering a session note: the schema-v2 frontmatter, and the body.
 *
 * One design decision worth knowing about. `ingest` hashes the **body** to
 * decide whether to re-embed, so a change confined to frontmatter would update
 * the note on disk and change nothing in the store. The relational fields that
 * matter for retrieval — status, repo, branch, phase, tags — are therefore
 * mirrored into the body's fact table. A note whose status flips to
 * `superseded` is a new body, and the next ingest run notices.
 */

import {
  AREA_CLASSES,
  GENERATOR_VERSION,
  MAX_COMMANDS_LISTED,
  MAX_FILES_LISTED,
  MAX_PROMPTS_RENDERED,
  MAX_PROMPT_CHARS,
  SCHEMA_VERSION,
} from './constants.mjs';
import { serializeFrontmatter } from './frontmatter.mjs';
import { redact } from './redact.mjs';
import { humanDuration, toPosix } from './text.mjs';

/** `session-<id>` — the stable `external_id` ingest keys on. */
export function noteId(sessionId, resumeIndex = 1) {
  const base = `session-${sessionId}`;
  return resumeIndex > 1 ? `${base}-r${resumeIndex}` : base;
}

/** The note's filename inside `<collection>/sessions/`. */
export function noteFilename(sessionId, resumeIndex = 1) {
  return resumeIndex > 1 ? `${sessionId}-r${resumeIndex}.md` : `${sessionId}.md`;
}

/**
 * The schema-v2 frontmatter for one session.
 *
 * Every field in R-27.2 and R-27.3 is present on every note, including the ones
 * that could not be derived. An empty string means "not derivable from this
 * session", which is a different and more useful statement than a missing key —
 * and it keeps one type per field, which is what lets W-H2's `filter_metadata`
 * match without guessing.
 */
export function buildFields(ctx) {
  return {
    id: ctx.noteId,
    title: `Session ${ctx.date} — ${ctx.collection}`,
    type: 'session',
    schema_version: SCHEMA_VERSION,
    collection: ctx.collection,
    collection_source: ctx.collectionSource,
    session_id: ctx.sessionId,
    date: ctx.date,
    started_at: ctx.startedAt,
    ended_at: ctx.endedAt,
    duration_minutes: Number.isFinite(ctx.durationMs) ? Math.round(ctx.durationMs / 60000) : 0,
    status: ctx.status,
    concluded_at: ctx.concludedAt,
    end_reason: ctx.endReason,
    repo: ctx.repo,
    branch: ctx.branch,
    worktree: ctx.worktree,
    repos_touched: ctx.reposTouched,
    cwd: toPosix(ctx.cwd),
    cwds_seen: ctx.cwdsSeen,
    phase: ctx.phase,
    tags: ctx.tags,
    supersedes: ctx.supersedes ?? [],
    resumed_from: ctx.resumedFrom ?? '',
    parent_session: ctx.parentSession,
    child_sessions: ctx.childSessions,
    commits: ctx.commits,
    prs: ctx.prs,
    memory_files: ctx.memoryFiles,
    plan_file: ctx.planFile,
    docs_touched: ctx.docsTouched,
    artifacts: ctx.artifacts,
    files_modified: ctx.files.map((file) => file.path),
    prompt_count: ctx.prompts.length,
    command_count: ctx.commandCount,
    agent: 'claude-code',
    generator: `session-capture.mjs ${GENERATOR_VERSION}`,
    tools_used: Object.fromEntries(ctx.toolCounts),
  };
}

/** The markdown body. Extracted, never summarised: no model runs at session end. */
export function renderBody(ctx, fields) {
  const lines = [];
  lines.push(`# Session — ${ctx.date} — ${ctx.collection}`);
  lines.push('');
  lines.push(summaryLine(ctx, fields));
  lines.push('');

  lines.push('## What I asked for');
  lines.push('');
  ctx.prompts.slice(0, MAX_PROMPTS_RENDERED).forEach((prompt, index) => {
    const text = redact(prompt.text).slice(0, MAX_PROMPT_CHARS);
    lines.push(`${index + 1}. ${text.replace(/\n+/g, '\n   ')}`);
    lines.push('');
  });
  if (ctx.prompts.length > MAX_PROMPTS_RENDERED) {
    lines.push(`_…and ${ctx.prompts.length - MAX_PROMPTS_RENDERED} more prompts._`);
    lines.push('');
  }

  if (ctx.files.length) {
    lines.push('## Files created or modified');
    lines.push('');
    for (const file of ctx.files.slice(0, MAX_FILES_LISTED)) {
      lines.push(`- \`${file.path}\`${file.count > 1 ? ` (${file.count} edits)` : ''}`);
    }
    if (ctx.files.length > MAX_FILES_LISTED) {
      lines.push(`- _…and ${ctx.files.length - MAX_FILES_LISTED} more._`);
    }
    lines.push('');
  }

  if (fields.command_count) {
    lines.push('## Commands run');
    lines.push('');
    lines.push(`${fields.command_count} shell invocation${fields.command_count === 1 ? '' : 's'}. Sample:`);
    lines.push('');
    const seen = new Set();
    for (const label of ctx.commands) {
      if (seen.size >= MAX_COMMANDS_LISTED) break;
      if (seen.has(label)) continue;
      seen.add(label);
      lines.push(`- ${label}`);
    }
    lines.push('');
  }

  if (ctx.agents.length || ctx.skills.length) {
    lines.push('## Delegated work');
    lines.push('');
    for (const agent of ctx.agents.slice(0, 25)) lines.push(`- Agent: ${agent}`);
    for (const skill of ctx.skills.slice(0, 25)) lines.push(`- Skill: ${skill}`);
    lines.push('');
  }

  lines.push(
    ...renderFacts(fields, {
      transcriptPath: ctx.transcriptPath,
      subagentFilesRead: ctx.subagentFilesRead,
    }),
  );

  return lines.join('\n');
}

/**
 * The `## Session facts` section, as lines.
 *
 * Shared with the one-time migration, which replaces a v1 note's facts table
 * with this one — and in doing so changes the body, which is what makes
 * `ingest` notice that the note's metadata is new. (`content_hash` is computed
 * over the body alone, so a frontmatter-only edit is invisible to it.)
 */
export function renderFacts(fields, { transcriptPath = '', subagentFilesRead = 0 } = {}) {
  const lines = ['## Session facts', '', '| Field | Value |', '| --- | --- |'];
  for (const [label, value] of factRows(fields, { transcriptPath, subagentFilesRead })) {
    lines.push(`| ${label} | ${value} |`);
  }
  lines.push('');
  lines.push(
    '_Generated mechanically by `session-capture.mjs` at session end — extracted, not summarised. ' +
      'Tool output is never copied; prompts and commands are redacted for secrets._',
  );
  lines.push('');
  return lines;
}

function summaryLine(ctx, fields) {
  const prompts = fields.prompt_count;
  const commands = fields.command_count;
  const files = fields.files_modified.length;
  return (
    `Working directory \`${toPosix(ctx.cwd)}\`. Ran ${humanDuration(ctx.durationMs)}, ` +
    `${prompts} prompt${prompts === 1 ? '' : 's'}, ` +
    `${commands} shell command${commands === 1 ? '' : 's'}, ` +
    `${files} file${files === 1 ? '' : 's'} touched. Ended: ${fields.end_reason}.`
  );
}

/**
 * The rows that mirror frontmatter into the body.
 *
 * Only fields whose change should trigger a re-embed are here; a list of sixty
 * file paths is already in the body above, and repeating the whole frontmatter
 * would make every note twice as long for no retrieval gain.
 */
function factRows(fields, { transcriptPath, subagentFilesRead }) {
  const rows = [
    ['Session id', `\`${fields.session_id}\``],
    ['Status', fields.status],
    ['Collection', `\`${fields.collection}\` (from ${fields.collection_source})`],
    ['Repo', fields.repo || '—'],
    ['Branch', fields.branch || '—'],
    ['Worktree', fields.worktree || '—'],
    ['Phase', fields.phase || '—'],
    ['Tags', fields.tags.length ? fields.tags.map((tag) => `\`${tag}\``).join(', ') : '—'],
    ['Started', fields.started_at || 'unknown'],
    ['Ended', fields.ended_at || 'unknown'],
    ['End reason', fields.end_reason],
  ];
  if (fields.resumed_from) rows.push(['Resumed from', `\`${fields.resumed_from}\``]);
  if (fields.parent_session) rows.push(['Parent session', `\`${fields.parent_session}\``]);
  if (fields.commits.length) rows.push(['Commits', fields.commits.length]);
  if (fields.prs.length) rows.push(['PRs', fields.prs.map((pr) => `#${pr}`).join(', ')]);
  rows.push(['Transcript', `\`${toPosix(transcriptPath)}\``]);
  rows.push(['Subagent transcripts read', subagentFilesRead]);
  return rows;
}

/** Frontmatter block, blank line, body. The exact bytes the goldens compare. */
export function renderNote(fields, body) {
  return `${serializeFrontmatter(fields)}\n\n${body}`;
}

/** `classes` notes live under a course id, `projects` notes under a repo slug. */
export function isClassArea(area) {
  return area === AREA_CLASSES;
}
