/**
 * The settings.json merge.
 *
 * This is the one thing the installer does that it cannot undo for the user:
 * `~/.claude/settings.json` holds their permissions, their model, their plugins
 * and other tools' hooks. The tests here are all the same shape — do the merge,
 * then assert that everything the installer does not own came back unchanged.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOOK_TIMEOUT_SECONDS,
  SESSION_START_MATCHER,
  SESSION_START_TIMEOUT_SECONDS,
  hookCommand,
  hookCommands,
  registeredEvents,
  registrationStatus,
  withHookRegistered,
} from '../lib/settings.mjs';

const NODE = 'C:/Program Files/nodejs/node.exe';
const HOOKS_DIR = 'C:/Users/estac/.claude/hooks';
const COMMAND = hookCommand(NODE, `${HOOKS_DIR}/session-capture.mjs`);
const START_COMMAND = hookCommand(NODE, `${HOOKS_DIR}/session-start.mjs`);
/** Every event's command: the capture hook for two, the start hook for SessionStart. */
const COMMANDS = hookCommands(NODE, HOOKS_DIR);
const CAPTURE_EVENTS = Object.freeze(['SessionEnd', 'SubagentStop']);

/** The shape actually on this machine, trimmed to what matters. */
const EXISTING = Object.freeze({
  permissions: { allow: ['Read', 'Edit'], defaultMode: 'auto' },
  model: 'claude-fable-5-1[1m]',
  hooks: {
    SessionEnd: [
      {
        hooks: [
          { type: 'command', command: COMMAND, timeout: 20, statusMessage: 'Capturing session to vault...' },
        ],
      },
    ],
  },
  enabledPlugins: { 'code-review@claude-code-plugins': true },
  tui: 'fullscreen',
});

test('every event is registered, each with its own script, timeout and status message', () => {
  const { settings, added } = withHookRegistered({}, COMMANDS);
  assert.deepEqual(added.slice().sort(), registeredEvents().sort());
  assert.deepEqual(registeredEvents().slice().sort(), ['SessionEnd', 'SessionStart', 'SubagentStop']);

  for (const event of CAPTURE_EVENTS) {
    const entry = settings.hooks[event][0].hooks[0];
    assert.equal(entry.type, 'command');
    assert.equal(entry.command, COMMAND);
    assert.equal(entry.timeout, HOOK_TIMEOUT_SECONDS);
    assert.ok(entry.statusMessage.length > 0);
    assert.equal(settings.hooks[event][0].matcher, undefined, 'SessionEnd and SubagentStop take no matcher');
  }

  const start = settings.hooks.SessionStart[0];
  assert.equal(start.matcher, SESSION_START_MATCHER);
  assert.equal(start.hooks[0].type, 'command');
  assert.equal(start.hooks[0].command, START_COMMAND);
  assert.equal(start.hooks[0].timeout, SESSION_START_TIMEOUT_SECONDS);
  assert.ok(start.hooks[0].statusMessage.length > 0);
});

test('SessionStart fires on startup and resume only, and gives up long before a capture would', () => {
  assert.equal(SESSION_START_MATCHER, 'startup|resume');
  assert.equal(SESSION_START_TIMEOUT_SECONDS, 5);
});

test('hookCommands names session-capture.mjs for capture and session-start.mjs for SessionStart', () => {
  assert.deepEqual({ ...COMMANDS }, { SessionEnd: COMMAND, SubagentStop: COMMAND, SessionStart: START_COMMAND });
  assert.ok(Object.isFrozen(COMMANDS));
  // A Windows-style hooks folder comes out with forward slashes, like every other path here.
  assert.equal(hookCommands(NODE, String.raw`C:\Users\estac\.claude\hooks`).SessionStart, START_COMMAND);
});

test('a single command string, or a map missing an event, is refused rather than guessed at', () => {
  // A bare string used to mean "this command for every event". With SessionStart
  // running a different script, that would register the capture hook at startup.
  assert.throws(() => withHookRegistered({}, COMMAND), TypeError);
  assert.throws(() => withHookRegistered({}, { SessionEnd: COMMAND, SubagentStop: COMMAND }), /SessionStart/);
  assert.throws(() => withHookRegistered({}, { ...COMMANDS, SessionStart: '' }), /SessionStart/);
});

test('the command quotes both paths, because both contain spaces', () => {
  assert.equal(COMMAND, '"C:/Program Files/nodejs/node.exe" "C:/Users/estac/.claude/hooks/session-capture.mjs"');
});

test('an existing SessionEnd entry is left exactly as it was', () => {
  const { settings, added, unchanged } = withHookRegistered(EXISTING, COMMANDS);
  assert.deepEqual(unchanged, ['SessionEnd']);
  assert.deepEqual(added, ['SubagentStop', 'SessionStart']);
  assert.deepEqual(settings.hooks.SessionEnd, EXISTING.hooks.SessionEnd);
});

test('the same registration written with backslashes or another case is recognised', () => {
  // The live file had the command with forward slashes; `process.execPath`
  // hands back backslashes. Comparing raw strings added a second SessionEnd
  // entry on every install, and thirteen accumulated before anyone noticed.
  const backslashed = {
    hooks: {
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: String.raw`"C:\Program Files\nodejs\node.exe" "C:\Users\estac\.claude\hooks\session-capture.mjs"`,
              timeout: 20,
            },
          ],
        },
      ],
      SessionStart: [
        {
          matcher: 'startup|resume',
          hooks: [
            {
              type: 'command',
              command: String.raw`"C:\PROGRAM FILES\nodejs\node.exe" "C:\Users\estac\.claude\hooks\session-start.mjs"`,
              timeout: 5,
            },
          ],
        },
      ],
    },
  };
  const { added, unchanged, settings } = withHookRegistered(backslashed, COMMANDS);
  assert.deepEqual(unchanged, ['SessionEnd', 'SessionStart']);
  assert.deepEqual(added, ['SubagentStop']);
  assert.equal(settings.hooks.SessionEnd.length, 1, 'no duplicate entry was added');
  assert.equal(settings.hooks.SessionStart.length, 1, 'no duplicate SessionStart entry was added');
});

test('a second run changes nothing at all', () => {
  const once = withHookRegistered(EXISTING, COMMANDS);
  const twice = withHookRegistered(once.settings, COMMANDS);
  assert.deepEqual(twice.added, []);
  assert.deepEqual(twice.unchanged, registeredEvents());
  assert.deepEqual(twice.settings, once.settings);
});

test('every other key and every other hook survives', () => {
  const withOtherHooks = {
    ...EXISTING,
    hooks: {
      ...EXISTING.hooks,
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'someone-elses-guard.exe' }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: 'another-tool.exe', timeout: 5 }] }],
    },
  };

  const { settings } = withHookRegistered(withOtherHooks, COMMANDS);

  assert.deepEqual(settings.permissions, withOtherHooks.permissions);
  assert.equal(settings.model, withOtherHooks.model);
  assert.deepEqual(settings.enabledPlugins, withOtherHooks.enabledPlugins);
  assert.equal(settings.tui, withOtherHooks.tui);
  assert.deepEqual(settings.hooks.PreToolUse, withOtherHooks.hooks.PreToolUse);

  // Appended beside the other tool's SubagentStop hook, not over it.
  assert.equal(settings.hooks.SubagentStop.length, 2);
  assert.deepEqual(settings.hooks.SubagentStop[0], withOtherHooks.hooks.SubagentStop[0]);
  assert.equal(settings.hooks.SubagentStop[1].hooks[0].command, COMMAND);
});

test("someone else's SessionStart entry is left alone, and ours goes beside it", () => {
  const theirs = Object.freeze({ matcher: 'startup', hooks: [{ type: 'command', command: 'plugin-banner.exe', timeout: 3 }] });
  const { settings, added } = withHookRegistered({ hooks: { SessionStart: [theirs] } }, COMMANDS);
  assert.ok(added.includes('SessionStart'));
  assert.equal(settings.hooks.SessionStart.length, 2);
  assert.deepEqual(settings.hooks.SessionStart[0], theirs);
  assert.equal(settings.hooks.SessionStart[1].hooks[0].command, START_COMMAND);
});

test('a tuned timeout, status message or matcher on an existing entry is not reset', () => {
  const tuned = {
    hooks: {
      SessionEnd: [{ hooks: [{ type: 'command', command: COMMAND, timeout: 45, statusMessage: 'mine' }] }],
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: START_COMMAND, timeout: 9 }] }],
    },
  };
  const { settings, unchanged } = withHookRegistered(tuned, COMMANDS);
  assert.deepEqual(unchanged, ['SessionEnd', 'SessionStart']);
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].timeout, 45);
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].statusMessage, 'mine');
  assert.deepEqual(settings.hooks.SessionStart, tuned.hooks.SessionStart);
});

test('the merge returns a new object and mutates nothing', () => {
  const before = JSON.parse(JSON.stringify(EXISTING));
  const { settings } = withHookRegistered(EXISTING, COMMANDS);
  assert.notEqual(settings, EXISTING);
  assert.deepEqual(EXISTING, before);
});

test('a settings file with no hooks key, or a malformed one, is handled', () => {
  for (const input of [{}, { hooks: null }, { hooks: [] }, { hooks: { SessionEnd: 'nonsense' } }, null]) {
    const { settings } = withHookRegistered(input, COMMANDS);
    for (const event of registeredEvents()) {
      assert.equal(settings.hooks[event][0].hooks[0].command, COMMANDS[event]);
    }
  }
});

// ------------------------------------------------------- registrationStatus (doctor's row)

/** settings.json with one SessionStart entry running `command`. */
const startEntry = (command) => ({
  hooks: { SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command }] }] },
});

test('registrationStatus: registered when an entry runs the script in the hooks folder, any node', () => {
  const settings = startEntry(String.raw`"D:/node/node.exe" "C:\Users\estac\.claude\hooks\session-start.mjs"`);
  const status = registrationStatus(settings, 'SessionStart', HOOKS_DIR);
  assert.equal(status.state, 'registered');
  assert.equal(status.script, `${HOOKS_DIR}/session-start.mjs`);
});

test('registrationStatus: missing when nothing, or only another tool, is registered', () => {
  for (const settings of [{}, null, { hooks: { SessionStart: 'nonsense' } }, startEntry('plugin-banner.exe --hello')]) {
    const status = registrationStatus(settings, 'SessionStart', HOOKS_DIR);
    assert.equal(status.state, 'missing');
    assert.equal(status.expected, `${HOOKS_DIR}/session-start.mjs`);
  }
});

test('registrationStatus: wrong-script is one of ours running the wrong file or from the wrong place', () => {
  const capture = registrationStatus(startEntry(COMMAND), 'SessionStart', HOOKS_DIR);
  assert.equal(capture.state, 'wrong-script');
  assert.equal(capture.script, `${HOOKS_DIR}/session-capture.mjs`);

  const worktree = registrationStatus(
    startEntry('node "C:/Users/estac/agentic-harness-wt/hooks/session-start.mjs"'),
    'SessionStart',
    HOOKS_DIR,
  );
  assert.equal(worktree.state, 'wrong-script');
  assert.equal(worktree.script, 'C:/Users/estac/agentic-harness-wt/hooks/session-start.mjs');

  const unquoted = registrationStatus(startEntry('node C:/elsewhere/session-start.mjs'), 'SessionStart', HOOKS_DIR);
  assert.equal(unquoted.state, 'wrong-script');
  assert.equal(unquoted.script, 'C:/elsewhere/session-start.mjs');
});

test('registrationStatus: a right entry anywhere wins over a wrong one', () => {
  const settings = {
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: COMMAND }] },
        { matcher: 'startup|resume', hooks: [{ type: 'command', command: START_COMMAND }] },
      ],
    },
  };
  assert.equal(registrationStatus(settings, 'SessionStart', HOOKS_DIR).state, 'registered');
});

test('registrationStatus refuses an event it does not own', () => {
  assert.throws(() => registrationStatus({}, 'PreToolUse', HOOKS_DIR), /PreToolUse/);
});
