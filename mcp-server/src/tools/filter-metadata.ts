/**
 * Turn the agent-facing `repo` / `phase` / `tags` inputs into the one jsonb
 * object `rag.search(filter_metadata => ...)` contains-matches against.
 *
 * Why named inputs rather than a free-form jsonb parameter: a contains-match on
 * a key the corpus does not have returns nothing and raises nothing, so a
 * hallucinated key reads to the model as "the store holds nothing on this
 * topic". Three named, described, validated inputs cannot be hallucinated into
 * silence.
 *
 * The types here are frozen by the W-H1/W-H2 seam (R-27.3): `repo` and `phase`
 * are strings and `tags` is an array of strings. `{"prs": [6]}` against a note
 * that stored `{"prs": ["6"]}` matches nothing, silently — which is why one type
 * per field is a contract and not a preference.
 */

/** Frontmatter keys this tool filters on. Spelled exactly as the hook writes them. */
export const METADATA_KEYS = {
  repo: 'repo',
  phase: 'phase',
  tags: 'tags',
} as const;

export interface MetadataFilterInput {
  repo?: string;
  phase?: string;
  tags?: readonly string[];
}

/** The jsonb value sent to `rag.search`. `null` means "no metadata filter". */
export type MetadataFilter = Readonly<Record<string, string | string[]>> | null;

/**
 * Merge the given inputs into one contains-match object.
 *
 * Returns a new object every time; nothing passed in is mutated. An input that
 * is absent, or blank after trimming, contributes no key at all — an empty
 * string would be a filter that matches nothing rather than no filter.
 */
export function buildFilterMetadata(input: MetadataFilterInput): MetadataFilter {
  const filter: Record<string, string | string[]> = {};

  const repo = clean(input.repo);
  if (repo !== null) filter[METADATA_KEYS.repo] = repo;

  const phase = clean(input.phase);
  if (phase !== null) filter[METADATA_KEYS.phase] = phase;

  const tags = cleanTags(input.tags);
  if (tags.length > 0) filter[METADATA_KEYS.tags] = tags;

  return Object.keys(filter).length > 0 ? filter : null;
}

/** Human-readable rendering of an active filter, for result headers and logs. */
export function describeFilterMetadata(filter: MetadataFilter): string[] {
  if (filter === null) return [];
  return Object.entries(filter).map(([key, value]) =>
    Array.isArray(value) ? `${key} [${value.join(', ')}]` : `${key} "${value}"`,
  );
}

function clean(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Trim, drop blanks, and de-duplicate while keeping the caller's order. */
function cleanTags(tags: readonly string[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const tag of tags) {
    const cleaned = clean(tag);
    if (cleaned === null || seen.has(cleaned)) continue;
    seen.add(cleaned);
    kept.push(cleaned);
  }
  return kept;
}
