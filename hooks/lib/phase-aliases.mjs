/**
 * bb2dash branches whose name carries no phase number, and the phase each
 * shipped (brief 101 H-1).
 *
 * Three phases were built on slug branches before the `<slug>-<NN>` naming
 * took hold. Each row cites the PR that merged it, so the table is checkable
 * against GitHub rather than trusted. A row matches the branch name (after its
 * `feat/`, `fix/`, `chore/` or `docs/` prefix) exactly, or as the prefix of a
 * worker branch `<alias>-<stream>`, so the workers of that phase inherit it.
 *
 * Read only for `emstacho-su/bb2dash`: the rule is that repo's history, not a
 * convention of every repo.
 */

export const PHASE_ALIASES = Object.freeze([
  Object.freeze({ name: 'retrieval-polish', phase: 'phase-7', pr: 6 }),
  Object.freeze({ name: 'course-dimension', phase: 'phase-8', pr: 8 }),
  Object.freeze({ name: 'sync-loop', phase: 'phase-9', pr: 10 }),
]);

/** The aliased phase of a prefix-stripped branch name, or `''`. */
export function aliasPhase(name) {
  const text = String(name ?? '');
  if (!text) return '';
  const row = PHASE_ALIASES.find((alias) => text === alias.name || text.startsWith(`${alias.name}-`));
  return row ? row.phase : '';
}
