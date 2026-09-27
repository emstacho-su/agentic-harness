/**
 * Registering the hooks in `~/.claude/settings.json`.
 *
 * That file is the user's, not ours. It holds permissions, model choice,
 * enabled plugins and whatever else they have set, and other tools write to it
 * too. So this is a read-merge-write that touches exactly the hook events it
 * owns and leaves every other key — and every other hook — byte-for-byte
 * where it was.
 *
 * Two scripts, three events: `session-capture.mjs` for SessionEnd and
 * SubagentStop, `session-start.mjs` for SessionStart (R-H4). Each event gets
 * its own command, so the caller passes one per event (`hookCommands`).
 *
 * Idempotent by construction: an entry is recognised by the command it runs, so
 * running the installer twice changes nothing the second time. An entry that is
 * already there keeps its own `timeout`, `statusMessage` and `matcher`, because
 * if someone tuned them the installer has no business resetting them.
 */

import path from 'node:path';

import { toPosix } from './text.mjs';

/** SessionEnd hooks share ~1.5 s unless the registration raises it. */
export const HOOK_TIMEOUT_SECONDS = 20;
/**
 * The SessionStart hook gives up at 2 s on its own (BRIEF_DEADLINE_MS); this is
 * Claude Code's backstop above that, not a budget the hook plans to use.
 */
export const SESSION_START_TIMEOUT_SECONDS = 5;
/**
 * The start reasons that get a brief. `clear`, `compact` and `fork` continue a
 * session whose context already has one, or chose to drop it
 * (https://code.claude.com/docs/en/hooks, SessionStart matchers).
 */
export const SESSION_START_MATCHER = 'startup|resume';

export const CAPTURE_SCRIPT = 'session-capture.mjs';
export const START_SCRIPT = 'session-start.mjs';
/** Every script this installer registers; an entry running one of these is ours. */
const OUR_SCRIPTS = Object.freeze([CAPTURE_SCRIPT, START_SCRIPT]);

/** What each owned event runs, in the order the installer reports them. */
const REGISTRATIONS = Object.freeze({
  SessionEnd: Object.freeze({
    script: CAPTURE_SCRIPT,
    timeout: HOOK_TIMEOUT_SECONDS,
    statusMessage: 'Capturing session to vault...',
  }),
  SubagentStop: Object.freeze({
    script: CAPTURE_SCRIPT,
    timeout: HOOK_TIMEOUT_SECONDS,
    statusMessage: 'Capturing subagent to vault...',
  }),
  SessionStart: Object.freeze({
    script: START_SCRIPT,
    matcher: SESSION_START_MATCHER,
    timeout: SESSION_START_TIMEOUT_SECONDS,
    statusMessage: 'Loading project brief...',
  }),
});

const HOOK_EVENTS = Object.freeze(Object.keys(REGISTRATIONS));

/**
 * The command line, quoted for Windows: both paths can contain spaces.
 *
 * Forward slashes, which is what the existing registration uses and what every
 * other path in this project uses. Windows accepts either.
 */
export function hookCommand(nodePath, hookPath) {
  return `"${toPosix(nodePath)}" "${toPosix(hookPath)}"`;
}

/** `{event: command}` for every owned event, each running its own script in `hooksDir`. */
export function hookCommands(nodePath, hooksDir) {
  return Object.freeze(
    Object.fromEntries(
      HOOK_EVENTS.map((event) => [event, hookCommand(nodePath, path.join(hooksDir, REGISTRATIONS[event].script))]),
    ),
  );
}

/**
 * Two command lines naming the same two files are the same registration.
 *
 * `C:\Program Files\nodejs\node.exe` and `C:/Program Files/nodejs/node.exe`
 * are one path, and Windows filenames are case-insensitive. Comparing the raw
 * strings meant an installer run added a *second* SessionEnd entry beside the
 * one already there, and then another on the next run.
 */
function sameCommand(a, b) {
  return comparable(a) === comparable(b);
}

function comparable(value) {
  return toPosix(String(value ?? '')).toLowerCase();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** The command-type hook entries registered for `event`, however malformed the file. */
function commandEntries(settings, event) {
  const matchers = asObject(asObject(settings).hooks)[event];
  if (!Array.isArray(matchers)) return [];
  return matchers
    .flatMap((matcher) => (matcher && Array.isArray(matcher.hooks) ? matcher.hooks : []))
    .filter((entry) => entry && entry.type === 'command' && typeof entry.command === 'string');
}

function checkCommands(commands) {
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)) {
    throw new TypeError('withHookRegistered needs {event: command} for every event (see hookCommands)');
  }
  const missing = HOOK_EVENTS.filter((event) => typeof commands[event] !== 'string' || !commands[event].trim());
  if (missing.length) throw new TypeError(`withHookRegistered: no command for ${missing.join(', ')}`);
}

/**
 * Merge the hook registrations into `settings`, returning a new object.
 *
 * @param {object} settings  the parsed settings.json
 * @param {Record<string, string>} commands  the exact command line per event (`hookCommands`)
 * @returns {{settings: object, added: string[], unchanged: string[]}}
 */
export function withHookRegistered(settings, commands) {
  checkCommands(commands);
  const source = asObject(settings);
  const hooks = asObject(source.hooks);

  const nextHooks = { ...hooks };
  const added = [];
  const unchanged = [];

  for (const event of HOOK_EVENTS) {
    const command = commands[event];
    if (commandEntries(source, event).some((entry) => sameCommand(entry.command, command))) {
      unchanged.push(event);
      continue;
    }
    const matchers = Array.isArray(hooks[event]) ? hooks[event] : [];
    nextHooks[event] = [...matchers, matcherFor(event, command)];
    added.push(event);
  }

  return { settings: { ...source, hooks: nextHooks }, added, unchanged };
}

function matcherFor(event, command) {
  const { matcher, timeout, statusMessage } = REGISTRATIONS[event];
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command, timeout, statusMessage }],
  };
}

/** A command-line word: a double-quoted run (spaces allowed) or a bare one. */
const COMMAND_WORD = /"([^"]*)"|(\S+)/g;

/**
 * The script a command line runs: its second word (`"node" "script"`, quoted
 * or not). Forward slashes; '' when the line has only one word.
 */
export function commandScript(command) {
  const words = [...String(command ?? '').matchAll(COMMAND_WORD)].map((match) => match[1] ?? match[2]);
  return toPosix(words[1] ?? '');
}

/**
 * Whether `event` is registered to run its script from `hooksDir` (doctor's row).
 *
 * `registered` — some entry runs `<hooksDir>/<script>`, with any node;
 * `wrong-script` — none does, but an entry runs one of our scripts from
 *   elsewhere (a worktree) or the other script (capture at startup);
 * `missing` — neither; another tool's entries do not count.
 *
 * @returns {{state: 'registered'|'wrong-script'|'missing', script: string, expected: string}}
 */
export function registrationStatus(settings, event, hooksDir) {
  const registration = REGISTRATIONS[event];
  if (!registration) throw new RangeError(`not an event this installer owns: ${event}`);
  const expected = toPosix(path.join(hooksDir, registration.script));
  const scripts = commandEntries(settings, event).map((entry) => commandScript(entry.command));

  const right = scripts.find((script) => comparable(script) === comparable(expected));
  if (right) return Object.freeze({ state: 'registered', script: right, expected });
  const ours = scripts.find((script) => isOurs(script, hooksDir));
  if (ours) return Object.freeze({ state: 'wrong-script', script: ours, expected });
  return Object.freeze({ state: 'missing', script: '', expected });
}

/** An entry running a file from our hooks folder, or one of our scripts from anywhere. */
function isOurs(script, hooksDir) {
  if (!script) return false;
  const folder = toPosix(path.join(hooksDir)).replace(/\/+$/, '');
  const inHooksDir = comparable(path.posix.dirname(script)) === comparable(folder);
  return inHooksDir || OUR_SCRIPTS.includes(path.posix.basename(script).toLowerCase());
}

/** The events this installer owns. Exported so the tests cannot drift from it. */
export function registeredEvents() {
  return [...HOOK_EVENTS];
}
