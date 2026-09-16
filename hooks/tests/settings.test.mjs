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

import { HOOK_TIMEOUT_SECONDS, hookCommand, registeredEvents, withHookRegistered } from '../lib/settings.mjs';

const COMMAND = hookCommand('C:/Program Files/nodejs/node.exe', 'C:/Users/estac/.claude/hooks/session-capture.mjs');

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

test('both events are registered, with the quoted command and the raised timeout', () => {
  const { settings, added } = withHookRegistered({}, COMMAND);
  assert.deepEqual(added.sort(), registeredEvents().sort());

  for (const event of registeredEvents()) {
    const entry = settings.hooks[event][0].hooks[0];
    assert.equal(entry.type, 'command');
    assert.equal(entry.command, COMMAND);
    assert.equal(entry.timeout, HOOK_TIMEOUT_SECONDS);
    assert.ok(entry.statusMessage.length > 0);
  }
});

test('the command quotes both paths, because both contain spaces', () => {
  assert.equal(COMMAND, '"C:/Program Files/nodejs/node.exe" "C:/Users/estac/.claude/hooks/session-capture.mjs"');
});

test('an existing SessionEnd entry is left exactly as it was', () => {
  const { settings, added, unchanged } = withHookRegistered(EXISTING, COMMAND);
  assert.deepEqual(unchanged, ['SessionEnd']);
  assert.deepEqual(added, ['SubagentStop']);
  assert.deepEqual(settings.hooks.SessionEnd, EXISTING.hooks.SessionEnd);
});

test('the same registration written with backslashes is recognised', () => {
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
    },
  };
  const { added, unchanged, settings } = withHookRegistered(backslashed, COMMAND);
  assert.deepEqual(unchanged, ['SessionEnd']);
  assert.deepEqual(added, ['SubagentStop']);
  assert.equal(settings.hooks.SessionEnd.length, 1, 'no duplicate entry was added');
});

test('a second run changes nothing at all', () => {
  const once = withHookRegistered(EXISTING, COMMAND);
  const twice = withHookRegistered(once.settings, COMMAND);
  assert.deepEqual(twice.added, []);
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

  const { settings } = withHookRegistered(withOtherHooks, COMMAND);

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

test('a tuned timeout on an existing entry is not reset', () => {
  const tuned = {
    hooks: {
      SessionEnd: [{ hooks: [{ type: 'command', command: COMMAND, timeout: 45, statusMessage: 'mine' }] }],
    },
  };
  const { settings, unchanged } = withHookRegistered(tuned, COMMAND);
  assert.deepEqual(unchanged, ['SessionEnd']);
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].timeout, 45);
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].statusMessage, 'mine');
});

test('the merge returns a new object and mutates nothing', () => {
  const before = JSON.parse(JSON.stringify(EXISTING));
  const { settings } = withHookRegistered(EXISTING, COMMAND);
  assert.notEqual(settings, EXISTING);
  assert.deepEqual(EXISTING, before);
});

test('a settings file with no hooks key, or a malformed one, is handled', () => {
  for (const input of [{}, { hooks: null }, { hooks: [] }, { hooks: { SessionEnd: 'nonsense' } }, null]) {
    const { settings } = withHookRegistered(input, COMMAND);
    for (const event of registeredEvents()) {
      assert.equal(settings.hooks[event][0].hooks[0].command, COMMAND);
    }
  }
});
