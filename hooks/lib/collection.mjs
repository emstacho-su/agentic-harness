/**
 * Which vault folder a session belongs in (R-27.1).
 *
 * The rule that matters: **the collection is the repository, not the folder.**
 * Before this, a session run in `bb2dash-wt-sl` filed itself under a collection
 * called `bb2dash-wt-sl`, so one project's history scattered across as many
 * "projects" as it had worktrees. Every worktree of `emstacho-su/bb2dash` now
 * resolves to `bb2dash`.
 *
 * Three rules, in order:
 *   1. a class folder — cwd passes through a directory that exists under
 *      `vault/classes/`, so `…/.fall2026/ist352` is `classes/ist352`;
 *   2. the git remote — `https://github.com/emstacho-su/bb2dash.git` is
 *      `projects/bb2dash`, flagged `collection_source: git`;
 *   3. the folder name, flagged `collection_source: folder`, preferring an
 *      ancestor that already owns a vault folder so a session run in
 *      `agentic-harness/ingest` is not filed under `ingest`.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  AREA_CLASSES,
  AREA_PROJECTS,
  COLLECTION_FROM_FOLDER,
  COLLECTION_FROM_GIT,
} from './constants.mjs';
import { slugify, toPosix } from './text.mjs';

const AREAS = [AREA_PROJECTS, AREA_CLASSES];
const MAX_WALK_UP = 40;
const FALLBACK_COLLECTION = 'misc';

/**
 * @param {object} args
 * @param {string} args.cwd        the session's working directory
 * @param {string} args.vaultRoot  vault root; folders in it steer rules 1 and 3
 * @param {object} args.repo       the result of `resolveRepo(cwd)`
 * @returns {{area: string, collection: string, collectionSource: string}}
 */
export function deriveCollection({ cwd, vaultRoot, repo }) {
  const classMatch = matchClassFolder(cwd, vaultRoot);
  if (classMatch) {
    return { area: AREA_CLASSES, collection: classMatch, collectionSource: COLLECTION_FROM_FOLDER };
  }

  const fromGit = slugify(repo?.repoSlug ?? '');
  if (fromGit) {
    return { area: AREA_PROJECTS, collection: fromGit, collectionSource: COLLECTION_FROM_GIT };
  }

  return {
    area: AREA_PROJECTS,
    collection: fromFolder(cwd, vaultRoot),
    collectionSource: COLLECTION_FROM_FOLDER,
  };
}

/**
 * The deepest path segment that already names a folder under `vault/classes/`.
 *
 * Data-driven on purpose: the course ids are the ones the vault already uses
 * (`ist323`, `geo103`), so adding a class is creating its folder, not editing
 * the hook.
 */
function matchClassFolder(cwd, vaultRoot) {
  const segments = toPosix(cwd).split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const slug = slugify(segments[i]);
    if (!slug) continue;
    if (vaultFolderExists(vaultRoot, AREA_CLASSES, slug)) return slug;
  }
  return '';
}

function fromFolder(cwd, vaultRoot) {
  let current = toPosix(cwd);
  for (let depth = 0; depth < MAX_WALK_UP && current; depth += 1) {
    const slug = slugify(path.basename(current));
    if (slug && AREAS.some((area) => vaultFolderExists(vaultRoot, area, slug))) return slug;
    const parent = toPosix(path.dirname(current));
    if (!parent || parent === current) break;
    current = parent;
  }
  return slugify(path.basename(toPosix(cwd))) || FALLBACK_COLLECTION;
}

function vaultFolderExists(vaultRoot, area, slug) {
  if (!vaultRoot) return false;
  try {
    return fs.statSync(path.join(vaultRoot, area, slug)).isDirectory();
  } catch {
    return false;
  }
}
