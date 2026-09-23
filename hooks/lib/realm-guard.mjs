/**
 * What may not enter a realm commit (R-A3, R-A4).
 *
 * Two kinds of file block every *later* pull on some other machine, and both
 * are cheaper to refuse here than to fix in history:
 *
 *   - a name one platform rejects: Git for Windows refuses `a:b.md` or
 *     `CON.md` at checkout (`core.protectNTFS`), which fails the whole pull;
 *     a name committed in Unicode NFD from a Mac "can only be fixed by
 *     removing and re-adding" once it is in;
 *   - a file GitHub rejects: over 100 MB the push fails until history is
 *     rewritten. The ceiling here is a quarter of that, with a report line
 *     well below it, so the vault never gets near the cliff.
 *
 * Pure functions over relative paths and byte counts; the caller lists the
 * candidates (realm-sync) and stats them. Nothing here touches git.
 */

/** Refused outright: a quarter of GitHub's hard limit. */
export const ATTACHMENT_REFUSE_BYTES = 25 * 1024 * 1024;
/** Reported, not refused: big enough to notice, far from the ceiling. */
export const ATTACHMENT_REPORT_BYTES = 5 * 1024 * 1024;
/** The one realm-level folder where non-markdown belongs. */
export const ATTACHMENTS_DIR = 'attachments';

/** Non-markdown files a realm commits besides attachments: the markers and Obsidian settings. */
const POLICY_FILES = new Set(['.realm', '.gitignore', '.gitattributes']);
const OBSIDIAN_SETTING = /^\.obsidian\/[^/]+\.json$/;
const MARKDOWN = /\.md$/i;

/**
 * `< > : " | ? * \` and every control character: NTFS refuses them all. A
 * backslash inside a segment is a legal Linux/macOS name that Windows would
 * read as a directory separator.
 */
const RESERVED_CHAR = /[<>:"|?*\\]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f]/;
/**
 * Device names are reserved with or without an extension: `nul`, `NUL.md`,
 * `Com1.tar.gz`. Microsoft's list runs COM0–COM9 and LPT0–LPT9 and the
 * superscript digits ¹ ² ³ count as digits.
 */
const DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(\.|$)/i;

/**
 * Reported, not refused: Git for Windows fails checkout past MAX_PATH (260)
 * unless `core.longpaths` is set, and the realm's own prefix
 * (`C:/Users/<you>/vault/<realm>/`) takes some of that. Not in R-A3's list,
 * so a report line rather than a refusal.
 */
export const PATH_REPORT_CHARS = 200;
const WINDOWS_MAX_PATH = 260;

const MIB = 1024 * 1024;

/**
 * Why `relPath` cannot be committed, or '' when it can.
 *
 * Checked per path segment, because each one becomes a directory entry on
 * every machine that pulls it.
 */
export function checkName(relPath) {
  for (const segment of String(relPath).split('/')) {
    const reserved = segment.match(RESERVED_CHAR);
    if (reserved) return `reserved character '${reserved[0]}' in '${segment}'`;
    if (CONTROL_CHAR.test(segment)) return `control character in '${JSON.stringify(segment)}'`;
    if (segment.endsWith(' ')) return `'${segment}' ends in a space`;
    if (segment.endsWith('.') && segment !== '.' && segment !== '..') return `'${segment}' ends in a period`;
    const device = segment.match(DEVICE_NAME);
    if (device) return `'${segment}' is the Windows device name '${device[1].toUpperCase()}'`;
    if (segment.normalize('NFC') !== segment) return `'${segment}' is not in Unicode NFC`;
  }
  return '';
}

/**
 * Whether a file of `bytes` at `relPath` is refused, reported, or fine.
 *
 * @returns {{level: 'refuse'|'report'|'', reason: string}}
 */
export function checkSize(relPath, bytes) {
  if (bytes > ATTACHMENT_REFUSE_BYTES) return { level: 'refuse', reason: `${mib(bytes)} MiB is over ${ATTACHMENT_REFUSE_BYTES / MIB} MiB` };
  if (bytes > ATTACHMENT_REPORT_BYTES) return { level: 'report', reason: `${mib(bytes)} MiB is over ${ATTACHMENT_REPORT_BYTES / MIB} MiB` };
  if (!isAllowedNonMarkdown(relPath) && !MARKDOWN.test(relPath)) {
    return { level: 'report', reason: `non-markdown outside ${ATTACHMENTS_DIR}/` };
  }
  return { level: '', reason: '' };
}

function isAllowedNonMarkdown(relPath) {
  return POLICY_FILES.has(relPath) || OBSIDIAN_SETTING.test(relPath) || relPath.startsWith(`${ATTACHMENTS_DIR}/`);
}

function mib(bytes) {
  return (bytes / MIB).toFixed(1);
}

/**
 * Scan every candidate path once. `stat(relPath)` returns its size in bytes.
 * A path that is no longer on disk is a tracked file the user deleted — the
 * ordinary case, staged as a deletion — so it has nothing to check; any
 * other failure to read a size is a refusal, not something to paper over.
 *
 * @param {readonly string[]} relPaths
 * @param {(relPath: string) => number} stat
 * @returns {{refused: readonly {path: string, reason: string}[], reported: readonly {path: string, reason: string}[]}}
 */
export function scanRealm(relPaths, stat) {
  const refused = [];
  const reported = [];
  /** Windows and macOS fold case: two names that differ only by case are one file there. */
  const seenFolded = new Map();
  for (const relPath of relPaths) {
    const badName = checkName(relPath) || caseCollision(relPath, seenFolded);
    if (badName) {
      refused.push({ path: relPath, reason: badName });
      continue;
    }
    if (relPath.length > PATH_REPORT_CHARS) {
      reported.push({ path: relPath, reason: `${relPath.length} chars; Windows fails checkout past ${WINDOWS_MAX_PATH} with the vault prefix` });
    }
    const verdict = sizeVerdict(relPath, stat);
    if (verdict.level === 'refuse') refused.push({ path: relPath, reason: verdict.reason });
    else if (verdict.level === 'report') reported.push({ path: relPath, reason: verdict.reason });
  }
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { refused: Object.freeze([...refused].sort(byPath)), reported: Object.freeze([...reported].sort(byPath)) };
}

/** Records `relPath` under its case-folded form; the reason when another path already holds it. */
function caseCollision(relPath, seenFolded) {
  const folded = relPath.toLowerCase();
  const earlier = seenFolded.get(folded);
  if (earlier !== undefined) return `collides with '${earlier}' on a case-insensitive filesystem`;
  seenFolded.set(folded, relPath);
  return '';
}

function sizeVerdict(relPath, stat) {
  let bytes;
  try {
    bytes = stat(relPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return { level: '', reason: '' };
    return { level: 'refuse', reason: `size unreadable (${err?.code || err?.message || 'stat failed'})` };
  }
  return checkSize(relPath, bytes);
}
