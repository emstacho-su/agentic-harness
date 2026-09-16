/**
 * Registering the hook in `~/.claude/settings.json`.
 *
 * That file is the user's, not ours. It holds permissions, model choice,
 * enabled plugins and whatever else they have set, and other tools write to it
 * too. So this is a read-merge-write that touches exactly the two hook events
 * it owns and leaves every other key — and every other hook — byte-for-byte
 * where it was.
 *
 * Idempotent by construction: an entry is recognised by the command it runs, so
 * running the installer twice changes nothing the second time. An entry that is
 * already there keeps its own `timeout` and `statusMessage`, because if someone
 * tuned the timeout the installer has no business resetting it.
 */

import { toPosix } from './text.mjs';

const HOOK_EVENTS = Object.freeze(['SessionEnd', 'SubagentStop']);

const STATUS_MESSAGES = Object.freeze({
  SessionEnd: 'Capturing session to vault...',
  SubagentStop: 'Capturing subagent to vault...',
});

/** SessionEnd hooks share ~1.5 s unless the registration raises it. */
export const HOOK_TIMEOUT_SECONDS = 20;

/**
 * The command line, quoted for Windows: both paths can contain spaces.
 *
 * Forward slashes, which is what the existing registration uses and what every
 * other path in this project uses. Windows accepts either.
 */
export function hookCommand(nodePath, hookPath) {
  return `"${toPosix(nodePath)}" "${toPosix(hookPath)}"`;
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
  return toPosix(String(a ?? '')).toLowerCase() === toPosix(String(b ?? '')).toLowerCase();
}

/**
 * Merge the hook registration into `settings`, returning a new object.
 *
 * @param {object} settings  the parsed settings.json
 * @param {string} command   the exact command line to register
 * @returns {{settings: object, added: string[], unchanged: string[]}}
 */
export function withHookRegistered(settings, command) {
  const source = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const hooks = source.hooks && typeof source.hooks === 'object' && !Array.isArray(source.hooks) ? source.hooks : {};

  const nextHooks = { ...hooks };
  const added = [];
  const unchanged = [];

  for (const event of HOOK_EVENTS) {
    const matchers = Array.isArray(hooks[event]) ? hooks[event] : [];
    if (matchers.some((matcher) => registersCommand(matcher, command))) {
      unchanged.push(event);
      continue;
    }
    nextHooks[event] = [...matchers, matcherFor(event, command)];
    added.push(event);
  }

  return { settings: { ...source, hooks: nextHooks }, added, unchanged };
}

function registersCommand(matcher, command) {
  const entries = matcher && Array.isArray(matcher.hooks) ? matcher.hooks : [];
  return entries.some((entry) => entry && entry.type === 'command' && sameCommand(entry.command, command));
}

function matcherFor(event, command) {
  return {
    hooks: [
      {
        type: 'command',
        command,
        timeout: HOOK_TIMEOUT_SECONDS,
        statusMessage: STATUS_MESSAGES[event],
      },
    ],
  };
}

/** The events this installer owns. Exported so the tests cannot drift from it. */
export function registeredEvents() {
  return [...HOOK_EVENTS];
}
