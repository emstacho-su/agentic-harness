/**
 * String and path helpers shared by every other module.
 *
 * Nothing here touches the filesystem, which is what makes the rest testable.
 */

/** Windows backslashes to forward slashes. Vault paths are always POSIX. */
export function toPosix(value) {
  return typeof value === 'string' ? value.replace(/\\/g, '/') : '';
}

/**
 * Single-quoted YAML.
 *
 * The only scalar style where a Windows backslash stays literal and a leading
 * `#`, `@` or digit cannot change the type. Newlines are folded to spaces: a
 * frontmatter value is an index entry, not a document.
 */
export function yamlStr(value) {
  return `'${String(value ?? '').replace(/'/g, "''").replace(/[\r\n]+/g, ' ')}'`;
}

/**
 * A filesystem-safe, lowercase slug for a collection folder.
 *
 * Returns `''` for input that slugs to nothing, so the caller decides the
 * fallback rather than inheriting an invented name.
 */
export function slugify(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ._-]+/g, '-')
    .replace(/[-\s]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .trim();
  if (!slug) return '';
  // A reserved Windows device name would produce an uncreatable folder.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(slug)) return `${slug}-dir`;
  return slug.slice(0, 64);
}

/** First non-empty trimmed string among `names` on `obj`, else `''`. */
export function pick(obj, ...names) {
  for (const name of names) {
    const value = obj?.[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/** Order-preserving dedupe with an optional cap. Returns a new array. */
export function uniqueCapped(values, cap) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (value === '' || value === null || value === undefined) continue;
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (Number.isInteger(cap) && out.length >= cap) break;
  }
  return out;
}

/** `4h 12m` / `37m` / `unknown`. Body prose only; the frontmatter keeps minutes. */
export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** ISO instant to `YYYY-MM-DD`, or `''` when the input is not one. */
export function isoDate(value) {
  const text = String(value ?? '');
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
}

/** Milliseconds since epoch for an ISO instant, or NaN. */
export function isoToMillis(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
