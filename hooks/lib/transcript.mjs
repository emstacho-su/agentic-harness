/**
 * Reading a session's JSONL transcript.
 *
 * The transcript is the only record of what happened, and it is also the one
 * thing here that can be hundreds of megabytes. So: a bounded tail read, a
 * parser that tolerates a truncated or malformed line, and extraction that
 * copies **user prompts and tool inputs only**. Raw tool output never reaches
 * the note — with two deliberate, narrow exceptions documented at
 * `scanToolResults`, which pull an integer and a URL and nothing else.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  EDIT_TOOLS,
  MAX_COMMANDS_LISTED,
  MAX_COMMAND_CHARS,
  SHELL_TOOLS,
  SUBAGENT_BUDGET_BYTES,
} from './constants.mjs';
import { redact } from './redact.mjs';
import { toPosix } from './text.mjs';

/** Wrapper tags Claude Code uses for machinery that is not a human turn. */
const NOISE_TAG =
  /^<(bash-input|bash-stdout|bash-stderr|task-notification|local-command-stdout|local-command-stderr|system-reminder|user-memory-input|command-output)\b/;

const GITHUB_PR_URL = /https?:\/\/[^\s"']*\/pull\/(\d{1,6})\b/g;
const ARTIFACT_URL = /https:\/\/claude\.ai\/[A-Za-z0-9/_-]*artifacts?\/[A-Za-z0-9_-]{6,}/g;
const GH_PR_COMMAND = /\bgh\s+pr\b/;

// ------------------------------------------------------------------ file IO

/** Claude Code's own scheme: every non-alphanumeric run becomes a single `-`. */
export function sanitizeCwdForProjectDir(cwd) {
  return toPosix(cwd).replace(/[^a-zA-Z0-9]+/g, '-');
}

/**
 * Find the transcript for this session.
 *
 * The declared `transcript_path` is trusted when it exists; otherwise the
 * conventional location is reconstructed from the cwd, and finally every
 * project directory is scanned — a session launched from one directory and
 * ended in another is common enough to be worth the walk, and the walk is
 * bounded by the deadline.
 */
export function resolveTranscript({ declaredPath, sessionId, cwd, projectsRoot, deadlineAt }) {
  if (declaredPath && fs.existsSync(declaredPath)) return toPosix(declaredPath);
  if (!sessionId || !projectsRoot) return '';

  const guess = path.join(projectsRoot, sanitizeCwdForProjectDir(cwd), `${sessionId}.jsonl`);
  if (fs.existsSync(guess)) return toPosix(guess);

  try {
    for (const dir of fs.readdirSync(projectsRoot)) {
      const candidate = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return toPosix(candidate);
      if (Date.now() > deadlineAt) break;
    }
  } catch {
    /* no projects directory: nothing to find */
  }
  return '';
}

/**
 * Parse a JSONL file into entries, reading at most `maxBytes` from the tail.
 *
 * A tail read can start mid-line; that line fails to parse and is dropped,
 * which is the correct outcome and the reason the parser never throws.
 */
export function readEntries(file, maxBytes) {
  let raw;
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return [];
    if (size > maxBytes) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
        raw = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(file, 'utf8');
    }
  } catch {
    return [];
  }

  const entries = [];
  for (const line of raw.split('\n')) {
    if (line.length < 2 || line.charCodeAt(0) !== 123 /* { */) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* one malformed line must not cost the capture */
    }
  }
  return entries;
}

// ----------------------------------------------------------------- prompts

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    // A tool_result or an image means this entry is machinery, not a human turn.
    if (block.type !== 'text') return null;
    if (typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length ? parts.join('\n') : null;
}

/** The human-meaningful prompt text, or null when this is not one. */
export function normalizePrompt(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  // Slash commands arrive wrapped in <command-name>/<command-args> tags.
  const name = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (name) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    return `${name[1].trim()} ${args ? args[1].trim() : ''}`.trim() || null;
  }

  if (NOISE_TAG.test(text)) return null;

  const stripped = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-[a-z]+>[\s\S]*?<\/local-command-[a-z]+>/g, '')
    .trim();
  return stripped || null;
}

/**
 * Every human prompt, in order, from the most trustworthy tier that has any.
 *
 *   1. `origin.kind === 'human'` — the reliable signal on current builds.
 *   2. untagged user turns — older transcripts carry no `origin` at all, and
 *      capturing nothing would be worse than capturing these.
 *   3. sidechain turns — only when the file has nothing else. A subagent's own
 *      transcript is *entirely* sidechain, so excluding them unconditionally
 *      would mean a worker session that fires SessionEnd writes no note; in a
 *      parent transcript tier 1 or 2 always wins, so subagent turns stay out.
 */
export function extractPrompts(entries) {
  const humanTagged = [];
  const untagged = [];
  const sidechain = [];

  for (const entry of entries) {
    if (entry?.type !== 'user' || entry.isMeta) continue;
    const text = contentToText(entry.message?.content);
    if (text === null) continue;
    const prompt = normalizePrompt(text);
    if (!prompt) continue;

    const record = { text: prompt, timestamp: entry.timestamp, cwd: toPosix(entry.cwd) };
    if (entry.isSidechain) sidechain.push(record);
    else if (entry.origin?.kind === 'human') humanTagged.push(record);
    else if (!entry.origin?.kind && entry.promptSource !== 'system') untagged.push(record);
  }

  if (humanTagged.length) return humanTagged;
  if (untagged.length) return untagged;
  return sidechain;
}

// ------------------------------------------------------------------- tools

/** A fresh, empty accumulator. Every extractor adds to one of these. */
export function createAccumulator() {
  return {
    files: new Map(),
    commands: [],
    commandTexts: [],
    commandCount: 0,
    agents: [],
    skills: new Set(),
    toolCounts: new Map(),
    shellByToolUseId: new Map(),
    artifactToolUseIds: new Set(),
    prNumbers: [],
    artifacts: [],
    branches: new Set(),
  };
}

/** Walk assistant turns and record what the session did. Mutates `into`. */
export function extractTools(entries, into) {
  for (const entry of entries) {
    if (typeof entry?.gitBranch === 'string' && entry.gitBranch.trim()) {
      into.branches.add(entry.gitBranch.trim());
    }
    if (entry?.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      recordToolUse(block, into);
    }
  }
}

function recordToolUse(block, into) {
  const name = String(block.name || 'unknown');
  into.toolCounts.set(name, (into.toolCounts.get(name) || 0) + 1);

  const args = block.input && typeof block.input === 'object' ? block.input : {};

  if (EDIT_TOOLS.has(name)) {
    const file = toPosix(args.file_path || args.notebook_path || '');
    if (file) into.files.set(file, (into.files.get(file) || 0) + 1);
    return;
  }
  if (SHELL_TOOLS.has(name)) {
    into.commandCount += 1;
    const commandText = String(args.command ?? '');
    if (commandText) into.commandTexts.push(commandText);
    if (block.id && GH_PR_COMMAND.test(commandText)) into.shellByToolUseId.set(block.id, commandText);

    const description = typeof args.description === 'string' ? args.description.trim() : '';
    const firstLine = commandText.split('\n').find((line) => line.trim()) || '';
    const label = description || redact(firstLine).slice(0, MAX_COMMAND_CHARS);
    if (label && into.commands.length < MAX_COMMANDS_LISTED * 3) into.commands.push(label);
    return;
  }
  if (name === 'Agent') {
    const description = typeof args.description === 'string' ? args.description.trim() : '';
    const type = typeof args.subagent_type === 'string' ? args.subagent_type.trim() : '';
    if (description || type) into.agents.push(description ? `${description}${type ? ` (${type})` : ''}` : type);
    return;
  }
  if (name === 'Skill') {
    const skill = typeof args.skill === 'string' ? args.skill.trim() : '';
    if (skill) into.skills.add(skill);
    return;
  }
  if (name === 'Artifact') {
    if (block.id) into.artifactToolUseIds.add(block.id);
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (url) into.artifacts.push(url);
  }
}

/**
 * The two narrow reads of tool *output*.
 *
 * R-27.3 asks for `prs` "from `gh pr create/merge` output" and for the artifact
 * URLs, and neither exists anywhere else: the PR number is minted by GitHub and
 * the artifact URL by the publish. So this scans the result of a tool call it
 * already identified — a shell command containing `gh pr`, or an `Artifact`
 * call — and keeps one capture group from each: an integer, and a claude.ai
 * URL. No other output is read, and nothing is copied into the note body.
 */
export function scanToolResults(entries, into) {
  for (const entry of entries) {
    const result = entry?.toolUseResult;
    if (!result) continue;
    const id = toolUseIdOf(entry);
    if (!id) continue;

    const isShell = into.shellByToolUseId.has(id);
    const isArtifact = into.artifactToolUseIds.has(id);
    if (!isShell && !isArtifact) continue;

    const stdout = typeof result === 'string' ? result : String(result.stdout ?? '');
    if (!stdout) continue;

    if (isShell) {
      for (const match of stdout.matchAll(GITHUB_PR_URL)) {
        const number = Number.parseInt(match[1], 10);
        if (Number.isInteger(number) && number > 0) into.prNumbers.push(number);
      }
    }
    if (isArtifact) {
      for (const match of stdout.matchAll(ARTIFACT_URL)) into.artifacts.push(match[0]);
    }
  }
}

function toolUseIdOf(entry) {
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') return block.tool_use_id;
  }
  return '';
}

/**
 * Subagents do real work, and their edits belong in `files_modified`.
 *
 * Budgeted twice over: a byte ceiling across all of them, and the deadline. A
 * session with sixty subagent transcripts stops reading when either runs out,
 * because a complete note that arrives after session exit is worth nothing.
 */
export function extractSubagentTools({ transcriptPath, sessionId, into, deadlineAt }) {
  const dir = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return { filesRead: 0, agentIds: [] };
  }

  const agentIds = names.map((name) => name.replace(/\.jsonl$/, '')).sort();
  let spent = 0;
  let filesRead = 0;

  for (const name of names) {
    if (Date.now() > deadlineAt) break;
    const file = path.join(dir, name);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (spent + size > SUBAGENT_BUDGET_BYTES) continue;
    spent += size;
    extractTools(readEntries(file, SUBAGENT_BUDGET_BYTES), into);
    filesRead += 1;
  }
  return { filesRead, agentIds };
}

/**
 * When the transcript itself lives under `<parent-session>/subagents/`, the
 * spawning session is the directory two levels up. That is the only in-band
 * parent link Claude Code records; everything else comes from the environment.
 */
export function parentSessionFromPath(transcriptPath) {
  const posix = toPosix(transcriptPath);
  const match = posix.match(/\/([0-9a-fA-F-]{8,})\/subagents\/[^/]+\.jsonl$/);
  return match ? match[1] : '';
}
