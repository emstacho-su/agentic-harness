/**
 * The bb2dash field back-fill (brief 101 H-8; P-54, P-56).
 *
 * 5 of 373 bb2dash session notes carried a `phase` on 2026-09-24, two of them
 * wrong, and 156 an empty `repo`. This pass fills, where it can derive them and
 * never by guessing: `phase` (H-1, clearing a wrong value), `repo`, `commits`
 * and `prs`, `origin`, `files_modified` made repo-relative, `machine` (only
 * where the note's transcript is on this machine, B-54) and `hook_tags` (the
 * classifier replayed where the transcript exists, else `[]`). On a note with
 * more than five vocabulary tags it drops those the replay did not raise
 * (P-56); a note with no transcript keeps its tags exactly (PM sub-default
 * under B-52, 2026-09-29).
 *
 * The body's Session facts table is re-rendered from the new frontmatter, so
 * `ingest`, which hashes the body, sees the change. Everything a person wrote
 * below the generated marker is kept. A note is only ever moved by an explicit
 * `--relocate`, and the original then goes into the backup, never deleted.
 *
 * Pure planning lives here; `runBackfill` does the I/O, and the CLI
 * (`hooks/backfill-fields.mjs`) parses flags and prints. Git and `gh` are
 * injected so the tests never spawn either.
 */

import fs from 'node:fs';
import path from 'node:path';

import { backfillSession, pullRequestsInWindow, runGhSync } from './backfill.mjs';
import { AREAS, MAIN_TRANSCRIPT_MAX_BYTES, MAX_DOCS_TOUCHED, MAX_FILES_LISTED, MAX_HOOK_TAGS, MAX_MEMORY_FILES, MAX_REPOS_TOUCHED, SESSIONS_DIR } from './constants.mjs';
import { serializeFrontmatter, parseFrontmatter } from './frontmatter.mjs';
import { runGitSync } from './git-log.mjs';
import { withLinks } from './links.mjs';
import { mergeTags } from './merge.mjs';
import { HANDWRITTEN_MARKER, renderFacts } from './note.mjs';
import { transcriptPathFrom } from './outcome-backfill.mjs';
import { classifyPaths } from './paths.mjs';
import { redact } from './redact.mjs';
import { resolveRepo } from './repo.mjs';
import { classify, derivePhase, withPhaseTag } from './tags.mjs';
import { isLocalPath, isSafeFilenameSegment, toPosix } from './text.mjs';
import { createAccumulator, extractOrigin, extractPrompts, extractTools, readEntries } from './transcript.mjs';
import { readTranscriptHead } from './transcript-head.mjs';
import { UNCLASSIFIED, isKnownTag } from './vocabulary.mjs';

export const BB2DASH_REPO = 'emstacho-su/bb2dash';
export const DEFAULT_BB2DASH_CHECKOUT = 'C:/Users/stack/projects/bb2dash';
/** Where bb2dash lived before the move out of OneDrive; its notes name this cwd. */
export const ONEDRIVE_BB2DASH_CHECKOUT = 'C:/Users/stack/OneDrive - Syracuse University/.fall2026/.projects2026/bb2dash';
const BB2DASH_SESSIONS_PREFIX = `projects/bb2dash/${SESSIONS_DIR}/`;
const SDK_ORIGIN_PREFIX = 'sdk-';
const WORKER_NOTE = /^(.+)--([^/]+)\.md$/;
const FACTS_HEADING = '## Session facts';
const ABSENT = '(absent)';

/** The `--report --json` keys, in the order H-8 lists them. */
export const REPORT_KEYS = Object.freeze([
  'bb2dash_notes',
  'top_level_notes',
  'distinct_top_level_session_ids',
  'phase_set',
  'phase_underivable',
  'phase_underivable_indexed',
  'branch_empty',
  'phase_body_mismatch',
  'repo_empty',
  'repo_empty_underivable',
  'absolute_files_modified',
  'machine_empty',
  'machine_empty_underivable',
  'hook_tags_over_cap',
  'unknown_hook_tags',
  'changes',
]);

/** Fields this pass may change, in the order a change line prints them. */
const TRACKED_FIELDS = Object.freeze([
  'collection', 'collection_source', 'up', 'related', 'repo', 'phase', 'commits', 'prs', 'origin',
  'files_modified', 'machine', 'hook_tags', 'tags',
]);

// ------------------------------------------------------------------ parsing

/** `--relocate ca25962a=classes/ist466` -> `{prefix, realm, collection, spec}`; throws on anything else. */
export function parseRelocation(spec) {
  const match = String(spec ?? '').match(/^([^=]+)=([^/]+)\/([^/]+)$/);
  const [, prefix = '', realm = '', collection = ''] = match ?? [];
  if (!match || !isSafeFilenameSegment(prefix) || !AREAS.includes(realm) || !isSafeFilenameSegment(collection) || collection.startsWith('.')) {
    throw new Error(`--relocate needs <session-prefix>=<realm>/<collection> with a realm in ${AREAS.join(', ')}: ${JSON.stringify(spec)}`);
  }
  return { prefix, realm, collection, spec: `${prefix}=${realm}/${collection}` };
}

// ------------------------------------------------------------------ the run

/**
 * Plan every change, then (unless `dryRun`) back up and write.
 *
 * @returns {{lines: string[], report: object, refused: {path: string, error: string}[], written: string[]}}
 */
export function runBackfill({
  vaultRoot,
  backupDir = '',
  dryRun = true,
  checkout = DEFAULT_BB2DASH_CHECKOUT,
  home = '',
  projectsRoot = '',
  relocations = [],
  network = true,
  machine = '',
  resolveRepoFor = resolveRepo,
  runGit = runGitSync,
  runGh = runGhSync,
}) {
  if (!dryRun && !backupDir) throw new Error('a real run needs --backup <dir>');
  const scan = scanVault(vaultRoot);
  const ctx = makeContext({ vaultRoot, checkout, home, projectsRoot, relocations, network, machine, resolveRepoFor, runGit, runGh });
  const plans = planAll(scan.notes, ctx);
  const lines = plans.flatMap((plan) => plan.lines);
  const refused = [...scan.refused, ...plans.filter((plan) => plan.refusal).map((plan) => ({ path: plan.note.notePath, error: plan.refusal }))];
  const written = dryRun ? [] : applyPlans(plans, { vaultRoot, backupDir, refused });
  const report = buildReport({ plans, changes: lines.length });
  return { lines, report, refused, written };
}

function makeContext({ vaultRoot, checkout, home, projectsRoot, relocations, network, machine, resolveRepoFor, runGit, runGh }) {
  const root = trimSlash(toPosix(checkout));
  const cachedGh = memoize(runGh);
  return {
    vaultRoot,
    checkout: root,
    bb2dashRepo: redact(resolveRepoFor(root)?.repoFullName ?? ''),
    workflowPrefix: home ? `${trimSlash(toPosix(home))}/.claude/projects/${encodeProjectName(root)}` : '',
    projectsRoot,
    relocations,
    network,
    machine: redact(machine),
    resolveRepoFor: memoize(resolveRepoFor),
    runGit,
    runGh: network ? cachedGh : () => ({ ok: false, stdout: '', error: 'offline (--no-network)' }),
    byStem: new Map(),
  };
}

// ------------------------------------------------------------------ scanning

/** Every `<realm>/<collection>/sessions/*.md`, parsed; an unparseable one is refused, not guessed at. */
export function scanVault(vaultRoot) {
  const notes = [];
  const refused = [];
  for (const area of listDirs(vaultRoot)) {
    for (const collection of listDirs(path.join(vaultRoot, area))) {
      const dir = path.join(vaultRoot, area, collection, SESSIONS_DIR);
      for (const name of listFiles(dir).filter((file) => file.endsWith('.md')).sort()) {
        const notePath = path.join(dir, name);
        const raw = fs.readFileSync(notePath, 'utf8');
        const parsed = parseFrontmatter(raw);
        if (!parsed.ok) {
          refused.push({ path: notePath, error: `frontmatter unreadable: ${parsed.error}` });
          continue;
        }
        if (parsed.fields.type !== 'session') continue;
        const rel = `${area}/${collection}/${SESSIONS_DIR}/${name}`;
        notes.push({ notePath, rel, area, collection, name, stem: name.slice(0, -3), raw, fields: parsed.fields, body: parsed.body });
      }
    }
  }
  return { notes, refused };
}

// ------------------------------------------------------------------ planning

/** Parents before workers, so a worker reads its parent's filled fields. */
function planAll(notes, ctx) {
  const ordered = [...notes.filter((note) => !isWorker(note)), ...notes.filter(isWorker)];
  const plans = [];
  for (const note of ordered) {
    const plan = planNote(note, ctx);
    ctx.byStem.set(note.stem, plan.fields);
    plans.push(plan);
  }
  return plans;
}

function planNote(note, ctx) {
  const relocation = ctx.relocations.find((entry) => note.name.startsWith(entry.prefix)) ?? null;
  const inScope = isInScope(note, ctx);
  if (!inScope && !relocation) return { note, fields: note.fields, text: note.raw, lines: [], inScope, target: '' };

  const derived = inScope ? deriveFields(note, ctx) : { fields: { ...note.fields }, sources: {} };
  const placed = placeFields(note, derived, relocation);
  const text = renderWith(note, placed.fields);
  const lines = changeLines(note, placed.fields, derived.sources);
  const moving = placed.target !== note.rel;
  if (moving) lines.push(changeLine(note, 'path', note.rel, placed.target, `--relocate ${relocation.spec}`));
  const bodyOnly = lines.length === 0 && text !== note.raw;
  if (bodyOnly) lines.push(changeLine(note, 'body', 'Session facts', 're-rendered', 'frontmatter re-serialized'));
  const refusal = moving && fs.existsSync(path.join(ctx.vaultRoot, placed.target)) ? `relocate refused: target exists ${placed.target}` : '';
  return { note, fields: placed.fields, text, lines: refusal ? [] : lines, inScope, target: placed.target, refusal };
}

/** The relocated collection, or the note where it is. */
function placeFields(note, derived, relocation) {
  const moving = relocation && (note.area !== relocation.realm || note.collection !== relocation.collection);
  if (!moving) return { fields: derived.fields, target: note.rel };
  const fields = withLinks(
    { ...derived.fields, collection: relocation.collection, collection_source: 'folder' },
    relocation.realm,
    relocation.collection,
  );
  derived.sources.collection = derived.sources.collection_source = derived.sources.up = `--relocate ${relocation.spec}`;
  return { fields, target: `${relocation.realm}/${relocation.collection}/${SESSIONS_DIR}/${note.name}` };
}

function isWorker(note) {
  return WORKER_NOTE.test(note.name);
}

/** Filed under bb2dash, or naming bb2dash by repo or by a cwd in its checkout or a worktree of it. */
function isInScope(note, ctx) {
  if (note.rel.startsWith(BB2DASH_SESSIONS_PREFIX)) return true;
  if (sameText(note.fields.repo, BB2DASH_REPO)) return true;
  return cwdInCheckout(String(note.fields.cwd ?? ''), ctx.checkout);
}

function deriveFields(note, ctx) {
  const old = note.fields;
  const sources = {};
  const parent = parentFieldsOf(note, ctx);
  const transcript = findTranscript(note, ctx);
  const entries = transcript ? readEntries(transcript, MAIN_TRANSCRIPT_MAX_BYTES) : [];

  const repo = deriveRepo(note, ctx, parent, sources);
  const phase = derivePhaseFor(note, ctx, parent, repo, sources);
  const history = deriveHistory(note, ctx, repo, sources);
  const hookTags = deriveHookTags({ note, ctx, entries, transcript, repo, phase, sources });
  const fields = {
    ...old,
    repo,
    phase,
    ...history,
    origin: old.origin || (transcript ? redact(extractOrigin(entries)) : ''),
    files_modified: repoRelative(old.files_modified, ctx),
    machine: old.machine || (transcript ? ctx.machine : ''),
    hook_tags: hookTags,
    tags: deriveTags(old, hookTags, transcript),
  };
  sources.origin = 'transcript entrypoint';
  sources.files_modified = 'repo-relative';
  sources.machine = 'transcript on this machine (B-54)';
  sources.tags = transcript ? 'hook_tags replayed; P-56 over-cap repair' : 'unchanged';
  return { fields, sources, transcript };
}

// --------------------------------------------------------------- the fields

function deriveRepo(note, ctx, parent, sources) {
  const old = String(note.fields.repo ?? '');
  if (old) return old;
  const cwd = toPosix(String(note.fields.cwd ?? ''));
  const pick = (value, source) => {
    sources.repo = source;
    return redact(value);
  };
  if (cwdInCheckout(cwd, ctx.checkout) && ctx.bb2dashRepo) return pick(ctx.bb2dashRepo, `origin of ${ctx.checkout}`);
  if (sameText(cwd, ONEDRIVE_BB2DASH_CHECKOUT)) return pick(BB2DASH_REPO, 'pre-move OneDrive checkout');
  if (isWorkflowCwd(cwd, ctx)) {
    if (parent?.repo) return pick(parent.repo, `parent note ${note.fields.parent_session}`);
    const fromTranscript = parentTranscriptRepo(cwd, ctx);
    if (fromTranscript) return pick(fromTranscript, 'parent transcript cwd');
  }
  const own = cwd && isLocalPath(cwd) ? ctx.resolveRepoFor(cwd)?.repoFullName ?? '' : '';
  if (own) return pick(own, 'cwd git remote');
  if (parent?.repo) return pick(parent.repo, `parent note ${note.fields.parent_session}`);
  return '';
}

function derivePhaseFor(note, ctx, parent, repo, sources) {
  const old = note.fields;
  const branch = String(old.branch ?? '');
  const docs = asList(old.docs_touched).map(String);
  const prTitles = !sameText(repo, BB2DASH_REPO) ? prTitlesFor(old, repo, ctx) : [];
  const own = derivePhase({ branch, docsTouched: docs, prTitles, repo });
  const parts = [`branch ${branch || "''"}`];
  if (docs.length) parts.push(`${docs.length} docs_touched`);
  if (prTitles.length) parts.push(`${prTitles.length} PR titles`);
  if (!own && old.parent_session && parent?.phase) {
    sources.phase = `parent note ${old.parent_session}`;
    return parent.phase;
  }
  sources.phase = parts.join(', ');
  return redact(own);
}

function prTitlesFor(old, repo, ctx) {
  if (!repo || !old.started_at || !old.ended_at) return [];
  return pullRequestsInWindow({ repoFullName: repo, startedAt: old.started_at, endedAt: old.ended_at, runGh: ctx.runGh }).titles;
}

/** `commits` and `prs` for a bb2dash note, from the main checkout's history and `gh`; each only when empty. */
function deriveHistory(note, ctx, repo, sources) {
  const old = note.fields;
  const commits = asList(old.commits);
  const prs = asList(old.prs);
  if (!sameText(repo, BB2DASH_REPO) || (commits.length && prs.length) || !old.started_at || !old.ended_at) return { commits, prs };
  const derived = backfillSession({
    repoRoot: ctx.checkout,
    repoFullName: repo,
    startedAt: old.started_at,
    endedAt: old.ended_at,
    runGit: ctx.runGit,
    runGh: ctx.runGh,
  });
  sources.commits = `git log of ${ctx.checkout} in the session window`;
  sources.prs = 'gh pr list in the session window';
  return {
    commits: commits.length ? commits : derived.commits.map((sha) => redact(sha)),
    prs: prs.length ? prs : derived.prs,
  };
}

/** The classifier replayed on the transcript, its phase slot set to the note's phase; `[]` with no transcript. */
function deriveHookTags({ note, ctx, entries, transcript, repo, phase, sources }) {
  const old = note.fields;
  if (!transcript) {
    sources.hook_tags = 'no transcript on this machine';
    return Array.isArray(old.hook_tags) && old.hook_tags.length ? old.hook_tags : [];
  }
  const accumulator = createAccumulator();
  extractTools(entries, accumulator);
  const repoFor = repoResolverFor(ctx);
  const pathsOf = (counts) =>
    classifyPaths([...(counts ?? new Map()).entries()], { repoFor, maxFiles: MAX_FILES_LISTED, maxDocs: MAX_DOCS_TOUCHED, maxMemory: MAX_MEMORY_FILES, maxRepos: MAX_REPOS_TOUCHED });
  const edited = pathsOf(accumulator.files);
  const { tags } = classify({
    files: edited.files,
    filesRead: pathsOf(accumulator.filesRead).files,
    docsTouched: asList(old.docs_touched),
    commandTexts: accumulator.commandTexts,
    promptTexts: extractPrompts(entries).map((prompt) => prompt.text),
    skills: [...accumulator.skills],
    toolNames: [...accumulator.toolCounts.keys()],
    branch: String(old.branch ?? ''),
    repo,
  });
  sources.hook_tags = `classifier replayed on ${transcript}`;
  return withPhaseTag(tags, phase).map((tag) => redact(tag));
}

/**
 * Tags after the replay: hand tags kept, the replayed hook tags in, and on a
 * note with more than `MAX_HOOK_TAGS` vocabulary tags every vocabulary tag the
 * replay did not raise dropped (P-56). No transcript, no change. The old
 * order is kept when the set is the same, so a second run changes nothing.
 */
function deriveTags(old, hookTags, transcript) {
  const current = asList(old.tags);
  if (!transcript) return current;
  const merged = mergeTags(current, hookTags, asList(old.hook_tags));
  const vocabulary = merged.filter((tag) => tag !== UNCLASSIFIED && isKnownTag(tag));
  const hook = new Set(hookTags);
  const repaired = vocabulary.length > MAX_HOOK_TAGS ? merged.filter((tag) => !isKnownTag(tag) || hook.has(tag)) : merged;
  return sameSet(repaired, current) ? current : repaired;
}

function repoRelative(files, ctx) {
  const out = [];
  for (const file of asList(files).map(String)) {
    const relative = redact(relativeTo(file, ctx));
    if (!out.includes(relative)) out.push(relative);
  }
  return out;
}

function relativeTo(file, ctx) {
  const posix = toPosix(file);
  if (!isAbsolute(posix)) return posix;
  for (const root of checkoutRoots(posix, ctx.checkout)) {
    if (posix.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return posix.slice(root.length + 1);
  }
  const repo = isLocalPath(posix) ? ctx.resolveRepoFor(path.posix.dirname(posix)) : null;
  const root = toPosix(repo?.repoRoot ?? '');
  return root && posix.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? posix.slice(root.length + 1) : posix;
}

/** The checkout, the worktree folder a path is in, and the pre-move OneDrive checkout. */
function checkoutRoots(posix, checkout) {
  const roots = [checkout, ONEDRIVE_BB2DASH_CHECKOUT];
  const worktree = posix.slice(0, posix.indexOf('/', checkout.length + 1));
  if (posix.toLowerCase().startsWith(`${checkout.toLowerCase()}-wt-`) && worktree) roots.push(worktree);
  return roots;
}

/** `repoFor` for `classifyPaths`: bb2dash's checkout and worktrees by prefix, deleted ones included. */
function repoResolverFor(ctx) {
  return (filePath) => {
    const posix = toPosix(filePath);
    for (const root of checkoutRoots(posix, ctx.checkout)) {
      if (posix.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return { repoRoot: root, repoSlug: 'bb2dash' };
    }
    const repo = isLocalPath(posix) ? ctx.resolveRepoFor(path.posix.dirname(posix)) : null;
    return repo?.repoRoot ? repo : null;
  };
}

// ------------------------------------------------------------ transcripts

/** The Transcript row's file when it is on disk, else `<projectsRoot>/*\/<session>.jsonl` (or the worker's). */
function findTranscript(note, ctx) {
  const declared = transcriptPathFrom(note.raw);
  if (declared && isLocalPath(declared) && fs.existsSync(declared)) return toPosix(declared);
  const sessionId = String(note.fields.session_id ?? '');
  if (!ctx.projectsRoot || !isSafeFilenameSegment(sessionId)) return '';
  const agent = note.name.match(WORKER_NOTE)?.[2] ?? '';
  const relative = agent ? path.join(sessionId, 'subagents', `agent-${agent}.jsonl`) : `${sessionId}.jsonl`;
  for (const dir of listDirs(ctx.projectsRoot)) {
    const candidate = path.join(ctx.projectsRoot, dir, relative);
    if (fs.existsSync(candidate)) return toPosix(candidate);
  }
  return '';
}

/** `<home>/.claude/projects/<bb2dash encoded>*\/…`: a workflow agent's folder. */
function isWorkflowCwd(cwd, ctx) {
  return Boolean(ctx.workflowPrefix) && cwd.toLowerCase().startsWith(ctx.workflowPrefix.toLowerCase());
}

/** The repo `resolveRepo` gives for the cwd the parent transcript declares, `…/<encoded>/<sid>.jsonl`. */
function parentTranscriptRepo(cwd, ctx) {
  const match = cwd.match(/^(.*\/\.claude\/projects\/[^/]+)\/([^/]+)\/subagents\//i);
  if (!match || !isSafeFilenameSegment(match[2])) return '';
  const head = readTranscriptHead(`${match[1]}/${match[2]}.jsonl`);
  return head.cwd ? ctx.resolveRepoFor(head.cwd)?.repoFullName ?? '' : '';
}

function parentFieldsOf(note, ctx) {
  const parent = String(note.fields.parent_session ?? '');
  return parent && isSafeFilenameSegment(parent) ? ctx.byStem.get(parent) ?? null : null;
}

// ---------------------------------------------------------------- rendering

/** The note with its frontmatter replaced and its Session facts table re-rendered. */
function renderWith(note, fields) {
  const body = rerenderFacts(note.body, fields);
  return `${serializeFrontmatter(fields)}\n\n${body.replace(/^\n+/, '')}`;
}

/**
 * Replace the last Session facts section in the generated part of the body
 * (up to the last generated marker), keeping its Transcript and subagent rows
 * and everything a person wrote below the marker. A body with no facts
 * section gets one appended to its generated part.
 */
export function rerenderFacts(body, fields) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const markerAt = text.lastIndexOf(HANDWRITTEN_MARKER);
  const generated = markerAt === -1 ? text : text.slice(0, markerAt);
  const tail = markerAt === -1 ? '' : text.slice(markerAt + HANDWRITTEN_MARKER.length);
  const headingAt = generated.lastIndexOf(`\n${FACTS_HEADING}\n`);
  const before = headingAt === -1 ? generated.replace(/\s+$/, '\n\n') : generated.slice(0, headingAt + 1);
  const section = headingAt === -1 ? '' : generated.slice(headingAt + 1);
  const facts = renderFacts(fields, {
    transcriptPath: factValue(section, 'Transcript').replace(/^`|`$/g, ''),
    subagentFilesRead: Number(factValue(section, 'Subagent transcripts read')) || 0,
  }).join('\n');
  const rest = tail.replace(/^\n/, '');
  return `${before}${facts.replace(/\n$/, '')}${rest ? `\n${rest}` : '\n'}`;
}

function factValue(section, label) {
  const match = section.match(new RegExp(`\\n\\| ${label} \\| (.*) \\|(?=\\n)`));
  return match ? match[1] : '';
}

// ------------------------------------------------------------ change lines

function changeLines(note, fields, sources) {
  const lines = [];
  for (const name of TRACKED_FIELDS) {
    const from = Object.hasOwn(note.fields, name) ? note.fields[name] : undefined;
    const to = fields[name];
    if (same(from, to)) continue;
    lines.push(changeLine(note, name, from, to, sources[name] || 'derived'));
  }
  return lines;
}

function changeLine(note, field, from, to, source) {
  return `${note.stem} ${field}: ${show(from)} -> ${show(to)} (${source})`;
}

function show(value) {
  return value === undefined ? ABSENT : JSON.stringify(value);
}

// ------------------------------------------------------------------ writing

function applyPlans(plans, { vaultRoot, backupDir, refused }) {
  const written = [];
  for (const plan of plans) {
    if (plan.lines.length === 0 || plan.refusal) continue;
    try {
      if (plan.target === plan.note.rel) {
        backupCopy(plan.note, vaultRoot, backupDir);
        fs.writeFileSync(plan.note.notePath, plan.text, 'utf8');
        written.push(plan.note.notePath);
      } else {
        written.push(relocate(plan, vaultRoot, backupDir));
      }
    } catch (err) {
      refused.push({ path: plan.note.notePath, error: err?.message || err?.code || 'write failed' });
    }
  }
  return written;
}

/** The first copy is the original: an existing backup is never overwritten. */
function backupCopy(note, vaultRoot, backupDir) {
  const destination = path.join(backupDir, note.rel);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.copyFileSync(note.notePath, destination, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
}

/** Write at the target, then move the original into the backup. A target that exists is refused. */
function relocate(plan, vaultRoot, backupDir) {
  const target = path.join(vaultRoot, plan.target);
  if (fs.existsSync(target)) throw new Error(`relocate refused: target exists ${plan.target}`);
  const destination = path.join(backupDir, plan.note.rel);
  if (fs.existsSync(destination)) throw new Error(`relocate refused: backup already holds ${plan.note.rel}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, plan.text, { encoding: 'utf8', flag: 'wx' });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(plan.note.notePath, destination);
  return target;
}

// ------------------------------------------------------------------ report

/**
 * The projected state of every note in scope (the fields as this run leaves
 * them). `repo_empty` and `machine_empty` count the vault as it is before the
 * run; their `_underivable` twins count what is still empty after it.
 */
function buildReport({ plans, changes }) {
  const scoped = plans.filter((plan) => plan.inScope);
  const topLevel = scoped.filter((plan) => plan.note.name === `${plan.fields.session_id}.md`);
  const indexed = scoped.filter((plan) => isIndexed(plan));
  const empty = (plan, name) => String(plan.fields[name] ?? '') === '';
  const count = (list, predicate) => list.filter(predicate).length;
  const report = {
    bb2dash_notes: scoped.length,
    top_level_notes: topLevel.length,
    distinct_top_level_session_ids: new Set(topLevel.map((plan) => plan.fields.session_id)).size,
    phase_set: count(scoped, (plan) => !empty(plan, 'phase')),
    phase_underivable: count(scoped, (plan) => empty(plan, 'phase')),
    phase_underivable_indexed: count(indexed, (plan) => empty(plan, 'phase')),
    branch_empty: count(indexed, (plan) => empty(plan, 'branch')),
    phase_body_mismatch: count(scoped, (plan) => factValue(plan.text, 'Phase') !== (plan.fields.phase || '—')),
    repo_empty: count(scoped, (plan) => String(plan.note.fields.repo ?? '') === ''),
    repo_empty_underivable: count(scoped, (plan) => empty(plan, 'repo')),
    absolute_files_modified: count(scoped, (plan) => asList(plan.fields.files_modified).some((file) => isAbsolute(toPosix(String(file))))),
    machine_empty: count(scoped, (plan) => String(plan.note.fields.machine ?? '') === ''),
    machine_empty_underivable: count(scoped, (plan) => empty(plan, 'machine')),
    hook_tags_over_cap: count(scoped, (plan) => asList(plan.fields.hook_tags).length > MAX_HOOK_TAGS),
    unknown_hook_tags: scoped.reduce((sum, plan) => sum + asList(plan.fields.hook_tags).filter((tag) => !isKnownTag(tag)).length, 0),
    changes,
  };
  return Object.fromEntries(REPORT_KEYS.map((key) => [key, report[key]]));
}

/** What the ingest loads from `projects/bb2dash/sessions/`: not `origin: sdk-*`, not `ingest: false`. */
function isIndexed(plan) {
  const where = plan.target || plan.note.rel;
  if (!where.startsWith(BB2DASH_SESSIONS_PREFIX)) return false;
  if (String(plan.fields.origin ?? '').startsWith(SDK_ORIGIN_PREFIX)) return false;
  return plan.fields.ingest !== false && String(plan.fields.ingest ?? '') !== 'false';
}

// ------------------------------------------------------------------ helpers

function cwdInCheckout(cwd, checkout) {
  const value = toPosix(cwd).toLowerCase();
  const root = checkout.toLowerCase();
  return Boolean(value) && (value === root || value.startsWith(`${root}/`) || value.startsWith(`${root}-wt-`));
}

function encodeProjectName(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

function isAbsolute(posix) {
  return /^[A-Za-z]:\//.test(posix) || posix.startsWith('/');
}

function sameText(a, b) {
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameSet(a, b) {
  return a.length === b.length && a.every((tag) => b.includes(tag));
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function trimSlash(value) {
  return value.replace(/\/+$/, '');
}

/** Same arguments, same answer: one `gh pr list` per repo, one repo walk per directory. */
function memoize(fn) {
  const cache = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    if (!cache.has(key)) cache.set(key, fn(...args));
    return cache.get(key);
  };
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
