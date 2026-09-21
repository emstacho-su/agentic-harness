/**
 * Every tunable number and closed enum the session-capture hook depends on.
 *
 * They live in one file so a budget or a cap is a value with a name and a
 * reason, never a literal buried three calls deep.
 */

/** Written into `generator:`; bumped whenever the note's shape changes. */
export const GENERATOR_VERSION = '2.2.0';

/** Written into `schema_version:`. Lets a reader tell "old note" from "unknown". */
export const SCHEMA_VERSION = 2;

/**
 * Wall-clock budget for the whole hook, in ms. SessionEnd hooks share ~1.5 s;
 * settings.json raises the per-hook timeout, but a capture that delays session
 * exit is a capture nobody keeps. Optional work checks the deadline first.
 */
export const BUDGET_MS = 1200;

/**
 * Budget for the nightly transcript sweep, per session. It runs offline, so
 * it can afford the full read the hook has to truncate; it is still bounded
 * because one pathological transcript must not stall the whole night.
 */
export const SWEEP_BUDGET_MS = 30_000;

/** The sweep is offline, so `git log` may take its time; still bounded per call. */
export const SWEEP_GIT_TIMEOUT_MS = 5_000;

/**
 * Notes per detached ingest when the sweep is run by hand with `--ingest`.
 * Windows caps a command line at 32 KiB; ~80 vault-relative note paths keep
 * one spawn well under it, and one model load per 80 notes is cheap enough.
 */
export const SWEEP_INGEST_BATCH = 80;

/** Transcripts modified more recently than this are live sessions: not swept. */
export const DEFAULT_SWEEP_IDLE_HOURS = 6;

/**
 * Working directories the sweep never captures, matched as a path substring.
 * claude-mem's observer sessions were that retired tool's own SDK workers
 * summarising *other* sessions: derivative, and not the user's work.
 */
export const SWEEP_EXCLUDED_CWD_SEGMENTS = Object.freeze(['claude-mem/observer-sessions']);

/** Optional work stops this long before the deadline, leaving room to write. */
export const RESERVE_MS = 350;

/** `git log` is the one subprocess. Bounded so a stalled git cannot block exit. */
export const GIT_TIMEOUT_MS = 400;

/** Log file rotation. */
export const LOG_MAX_BYTES = 64 * 1024;
export const LOG_KEEP_LINES = 200;

/**
 * Transcript reading. A larger file is read tail-first; the head is dropped.
 *
 * 16 MB, not the 96 MB this started at: the budget test covers 18 MB across a
 * main transcript and its subagents, and the largest real transcript on this
 * machine is 4.6 MB. A 96 MB read holds the buffer, the decoded string, the
 * line array and the parsed entries in memory at once — hundreds of megabytes
 * and seconds of wall clock, inside a 1,200 ms budget.
 */
export const MAIN_TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;
export const SUBAGENT_BUDGET_BYTES = 24 * 1024 * 1024;

/** Note body limits. */
export const MAX_PROMPTS_RENDERED = 40;
export const MAX_PROMPT_CHARS = 1200;
export const MAX_FILES_LISTED = 60;
export const MAX_COMMANDS_LISTED = 20;
export const MAX_COMMAND_CHARS = 160;
/** Agent descriptions, skill names, artifact URLs — short labels, capped too. */
export const MAX_LABEL_CHARS = 200;
/**
 * The closing assistant message. Roughly 500 tokens: enough for a summary of
 * what was done and decided, short enough that one verbose session cannot turn
 * its note into a transcript.
 */
export const MAX_OUTCOME_CHARS = 2000;

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

/** The hook events this entry point serves. */
export const SESSION_END_EVENT = 'SessionEnd';
export const SUBAGENT_STOP_EVENT = 'SubagentStop';

/** Vault top-level areas the hook may write into. */
export const AREA_PROJECTS = 'projects';
export const AREA_CLASSES = 'classes';
/** The vault's two top-level areas. A collection folder lives in exactly one. */
export const AREAS = Object.freeze([AREA_PROJECTS, AREA_CLASSES]);

/** Every collection's hub note: what a session links `up` to. */
export const INDEX_NOTE = 'index';
export const INDEX_FILENAME = `${INDEX_NOTE}.md`;

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

/**
 * `captured_by:` — which entry point wrote the note. The hook runs at session
 * exit; the sweep runs nightly over transcripts the hook never saw.
 */
export const CAPTURED_BY_HOOK = 'hook';
export const CAPTURED_BY_SWEEP = 'sweep';
export const CAPTURED_BY_MIGRATION = 'migration';
/** Written by the /checkpoint skill inside a cloud session; collected from git nightly. */
export const CAPTURED_BY_SKILL = 'skill';

/** Where the /checkpoint skill leaves its notes inside a repository. */
export const CHECKPOINT_NOTES_DIR = '.harness/sessions';

/** Repositories the nightly collector fetches, relative to the home directory. */
export const DEFAULT_CHECKPOINT_REPO_SEGMENTS = Object.freeze([['agentic-harness'], ['projects', 'bb2dash']]);

/** `git fetch` touches the network; the other collector git calls do not. */
export const CHECKPOINT_FETCH_TIMEOUT_MS = 60_000;
export const CHECKPOINT_GIT_TIMEOUT_MS = 10_000;

/**
 * `origin:` — the `entrypoint` Claude Code stamps on every transcript record
 * (`cli`, `claude-desktop`, `sdk-py`, `sdk-cli`). Empty when the transcript
 * carries none; never guessed. The allow-list keeps it a label, not a payload.
 */
export const ORIGIN_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
