/**
 * Every tunable number and closed enum the session-capture hook depends on.
 *
 * They live in one file so a budget or a cap is a value with a name and a
 * reason, never a literal buried three calls deep.
 */

/** Written into `generator:`; bumped whenever the note's shape changes. */
export const GENERATOR_VERSION = '2.0.0';

/** Written into `schema_version:`. Lets a reader tell "old note" from "unknown". */
export const SCHEMA_VERSION = 2;

/**
 * Wall-clock budget for the whole hook, in ms. SessionEnd hooks share ~1.5 s;
 * settings.json raises the per-hook timeout, but a capture that delays session
 * exit is a capture nobody keeps. Optional work checks the deadline first.
 */
export const BUDGET_MS = 1200;

/** Optional work stops this long before the deadline, leaving room to write. */
export const RESERVE_MS = 350;

/** `git log` is the one subprocess. Bounded so a stalled git cannot block exit. */
export const GIT_TIMEOUT_MS = 400;

/** Log file rotation. */
export const LOG_MAX_BYTES = 64 * 1024;
export const LOG_KEEP_LINES = 200;

/** Transcript reading. A larger file is read tail-first; the head is dropped. */
export const MAIN_TRANSCRIPT_MAX_BYTES = 96 * 1024 * 1024;
export const SUBAGENT_BUDGET_BYTES = 24 * 1024 * 1024;

/** Note body limits. */
export const MAX_PROMPTS_RENDERED = 40;
export const MAX_PROMPT_CHARS = 1200;
export const MAX_FILES_LISTED = 60;
export const MAX_COMMANDS_LISTED = 20;
export const MAX_COMMAND_CHARS = 160;

/** Frontmatter array caps — a session note is an index, not an archive. */
export const MAX_HOOK_TAGS = 5;
export const MAX_COMMITS = 40;
export const MAX_PRS = 10;
export const MAX_DOCS_TOUCHED = 40;
export const MAX_MEMORY_FILES = 20;
export const MAX_ARTIFACTS = 10;
export const MAX_CWDS_SEEN = 20;
export const MAX_REPOS_TOUCHED = 10;
export const MAX_CHILD_SESSIONS = 40;

/** Tools whose input names a file the session edited. */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Tools whose input is a shell command line. */
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** `status:` is a ratchet. Higher never falls back to lower. */
export const STATUS_ACTIVE = 'active';
export const STATUS_CONCLUDED = 'concluded';
export const STATUS_SUPERSEDED = 'superseded';

/** Index = rank. `STATUS_RANK.indexOf(status)`; -1 means "unknown, treat as 0". */
export const STATUS_RANK = [STATUS_ACTIVE, STATUS_CONCLUDED, STATUS_SUPERSEDED];

/** SessionEnd reasons Claude Code emits. Anything else is normalised to `other`. */
export const END_REASONS = new Set(['clear', 'resume', 'logout', 'prompt_input_exit', 'other']);

/** The one reason that does *not* conclude a session (R-27.2). */
export const RESUME_REASON = 'resume';

/** Vault top-level areas the hook may write into. */
export const AREA_PROJECTS = 'projects';
export const AREA_CLASSES = 'classes';

/** `collection_source:` — how the collection name was decided. */
export const COLLECTION_FROM_GIT = 'git';
export const COLLECTION_FROM_FOLDER = 'folder';

/** Default vault, overridable with HARNESS_VAULT (the tests rely on that). */
export const VAULT_ENV_VAR = 'HARNESS_VAULT';
export const DEFAULT_VAULT_SEGMENTS = ['OneDrive - Syracuse University', 'vault'];

/**
 * Log destination, overridable with HARNESS_SESSION_CAPTURE_LOG. The end-to-end
 * test spawns the real hook, and it must not append to the live log.
 */
export const LOG_ENV_VAR = 'HARNESS_SESSION_CAPTURE_LOG';

/** Kill switch. */
export const DISABLE_ENV_VAR = 'HARNESS_SESSION_CAPTURE';
export const DISABLE_VALUES = new Set(['0', 'off', 'false', 'no']);

/**
 * Parent-session override. Subagents launched with the Agent tool share their
 * parent's `session_id` and never fire SessionEnd of their own, so a worker run
 * as a separate `claude` process is the only kind that gets its own note. Set
 * this in the worker's environment and the note records who spawned it.
 */
export const PARENT_SESSION_ENV_VAR = 'HARNESS_PARENT_SESSION';
