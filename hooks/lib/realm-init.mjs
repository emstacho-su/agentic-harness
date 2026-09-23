/**
 * The three files every realm repo is born with (R-A1, R-A2).
 *
 *   .realm          the marker `realm-sync.mjs` keys on
 *   .gitattributes  line endings are the repo's policy, not each machine's:
 *                   a committed file overrides every contributor's
 *                   `core.autocrlf`, and OneDrive round-trips already taught
 *                   the ingest hash to forgive CRLF once
 *   .gitignore      per-device Obsidian state never enters git; workspace.json
 *                   changes every session and is the top source of spurious
 *                   conflicts in obsidian-git's own experience
 *
 * `projects` is the one realm that tracks `.obsidian/*.json` settings — the
 * vault root's `.obsidian` moves with it — so every other realm ignores the
 * folder wholesale. Nothing here runs git; the first commit is preceded by
 * `git add --renormalize .` by whoever makes it (init-realm, Phase C).
 */

import fs from 'node:fs';
import path from 'node:path';

import { persist } from './notes-io.mjs';
import { REALM_MARKER, REALM_NAME } from './realm-sync.mjs';

/** The realm whose `.obsidian/*.json` settings are committed. */
export const SETTINGS_REALM = 'projects';

export const GITATTRIBUTES_TEXT = '* text=auto\n*.md text eol=lf\n';

/** Per-device or throwaway state, whatever the realm. */
const IGNORED_ALWAYS = Object.freeze(['.trash/', '.DS_Store', 'Thumbs.db']);
/** Inside a tracked `.obsidian`, the parts that differ per device. */
const IGNORED_OBSIDIAN_DEVICE_STATE = Object.freeze(['.obsidian/workspace.json', '.obsidian/workspace-mobile.json', '.obsidian/plugins/*/']);
const IGNORED_OBSIDIAN_ALL = Object.freeze(['.obsidian/']);

/** The `.gitignore` for a realm that does or does not carry the Obsidian settings. */
export function gitignoreText({ trackObsidianSettings }) {
  const obsidian = trackObsidianSettings ? IGNORED_OBSIDIAN_DEVICE_STATE : IGNORED_OBSIDIAN_ALL;
  return [...obsidian, ...IGNORED_ALWAYS].map((line) => `${line}\n`).join('');
}

/**
 * The policy files for a realm, in the order they are written.
 *
 * @returns {readonly {relPath: string, text: string}[]}
 */
export function realmPolicyFiles(name) {
  if (!REALM_NAME.test(String(name ?? ''))) throw new Error(`'${name}' is not a realm name (${REALM_NAME})`);
  return Object.freeze([
    { relPath: REALM_MARKER, text: `${name}\n` },
    { relPath: '.gitattributes', text: GITATTRIBUTES_TEXT },
    { relPath: '.gitignore', text: gitignoreText({ trackObsidianSettings: name === SETTINGS_REALM }) },
  ]);
}

/**
 * Write the policy files into `dir` (created if absent), byte-exact, LF,
 * UTF-8 without BOM.
 *
 * A marker that already names a different realm is never overwritten: that
 * is a folder somebody else owns. An identical file is left alone so a rerun
 * is a no-op and reports it as such; a file that exists with other content
 * is replaced, and the action says so, because a hand-added ignore rule
 * silently vanishing is how `drafts/` ends up on GitHub.
 *
 * @returns {readonly {relPath: string, action: 'written'|'overwritten'|'unchanged'|'would-write'|'would-overwrite'}[]}
 */
export function writeRealmFiles(dir, name, { dryRun = false } = {}) {
  const files = realmPolicyFiles(name);
  const existingMarker = readIfPresent(path.join(dir, REALM_MARKER));
  if (existingMarker !== null && existingMarker.trim() !== name) {
    throw new Error(`${dir} is already marked as '${existingMarker.trim()}', not '${name}'`);
  }
  return Object.freeze(
    files.map(({ relPath, text }) => {
      const target = path.join(dir, relPath);
      const existing = readIfPresent(target);
      if (existing === text) return { relPath, action: 'unchanged' };
      const verb = existing === null ? 'write' : 'overwrite';
      if (dryRun) return { relPath, action: `would-${verb}` };
      const saved = persist(target, text);
      if (!saved.ok) throw new Error(`could not write ${target} (${saved.error})`);
      return { relPath, action: verb === 'write' ? 'written' : 'overwritten' };
    }),
  );
}

/** The file's text, or null when there is no file. Any other failure is thrown: it is the caller's disk. */
function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}
