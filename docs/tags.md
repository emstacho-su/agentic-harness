# The session tag vocabulary

A session note's `tags:` field is a **controlled vocabulary**, not a folksonomy.
The `SessionEnd` hook applies tags mechanically from what the session touched;
Stack appends terms by hand. A closed list is what makes
`search_context(tags=["review"])` return every review session instead of the
subset that happened to be spelled that way.

This file is the human-readable source. `hooks/lib/vocabulary.mjs` is the
machine-readable mirror, and `hooks/tests/vocabulary.test.mjs` fails if the two
drift apart.

---

## The list

```text
# areas
ingest
db
retrieval
gui
mcp
harness
docs
review
planning
# activities
phase-brief
integration
pr
hotfix
validation
# phase
phase-<n>[<l>]
# sentinel
unclassified
```

`phase-<n>[<l>]` is a family, not a literal: `phase-7`, `phase-11`, `phase-12b`. `n` is 1–99;
the optional `l` is one lowercase letter, for a phase split into lettered parts
(`phase-10a`, `phase-10b`).

---

## Area tags — what the session touched

Applied from the repo-relative paths the session edited. One path can raise
more than one tag; `web/src/lib/queries.sync.ts` is `gui`, and
`db/migrations/035_transform_driver.sql` is `db`.

When the edits raise no area — a research or review worker edits nothing — the
same rules are applied to the paths the session **read** (`Read`, `Grep`, `Glob`
inputs). Reads never override edits and never raise an activity tag: reading a
phase brief is not writing one. Read paths are used for classification only and
are not listed in the note.

| Tag | Raised by a touched path that… |
| --- | --- |
| `ingest` | starts `ingest/` |
| `db` | starts `db/`, contains `/migrations/`, or ends `.sql` |
| `retrieval` | contains `retrieval`, `search`, or a `rag/` segment |
| `gui` | starts `web/`, or ends `.tsx`, `.jsx`, `.css`, `.scss` |
| `mcp` | contains `mcp-server/` or `mcp/` |
| `harness` | starts `hooks/`, contains `.claude/`, or contains `agentic-harness` |
| `planning` | starts `docs/planning/` |
| `docs` | starts `docs/`, or is a `.md` file outside `docs/planning/` |

`review` is the exception: no path raises it. It comes from a transcript
signal, below, because a review is something you *run*, not something you edit.

## Activity tags — what the session did

Applied from transcript signals: the shell commands the session ran, the skills
it invoked, and its branch name. Command text comes from tool **inputs**, which
the hook already reads; tool output is not scanned for tags.

| Tag | Raised by |
| --- | --- |
| `pr` | a shell command matching `gh pr create|merge|ready|edit|comment` |
| `integration` | a shell command matching `git merge`, `git rebase`, or `gh pr merge` |
| `validation` | a shell command running tests: `pytest`, `npm test`, `npm run test`, `vitest`, `node --test`, `cargo test`, `go test` |
| `hotfix` | a branch matching `fix/…` or `hotfix/…` |
| `phase-brief` | a touched path matching `docs/planning/…PHASE…` |
| `review` | the `/code-review` or `/security-review` command, or the `code-review` skill |
| `db` | the Supabase `apply_migration` tool (in addition to the path rule) |

## The phase tag

The phase is read from three sources, in this order:

1. the branch name — `feat/phase7-retrieval`, `phase-11/sprint`, `docs/phase12b-merged`;
2. the title of a pull request from the session's window (the back-fill only:
   the hook has no network; never for `emstacho-su/bb2dash`, whose titles of
   #7, #18 and #25 name the wrong phase);
3. a touched path under `docs/planning/` —
   `docs/planning/sprint-1-hub/briefs/80c_PHASE12B_page_pass.md` is `phase-12b`.

In every source the rule is `phase[-_ ]?(\d{1,2}[a-z]?)` not followed by a
letter or digit, case-insensitive and lowercased. Within one source every
distinct phase is collected: **one** is the phase; **two or more** is `''` and
no later source is read (a session spanning phases carries no phase); **none**
moves on to the next source.

Two more branch rules hold only when the repo is `emstacho-su/bb2dash`, read
from the name after its `feat/`, `fix/`, `chore/` or `docs/` prefix:

- a hyphen-delimited segment that is exactly 1–2 digits and an optional
  lowercase letter: `feat/grades-v1-16` is `phase-16`, `fix/page-pass-12b-tail`
  is `phase-12b` (`v1` is not a segment of digits);
- the alias table in `hooks/lib/phase-aliases.mjs`, for the slug branches that
  predate the `<slug>-<NN>` naming, each row citing its PR: `retrieval-polish`
  is `phase-7` (#6), `course-dimension` is `phase-8` (#8), `sync-loop` is
  `phase-9` (#10). An alias matches the whole name or a worker branch
  `<alias>-<stream>`.

Worker branches are `<phase branch>-<stream word>`; the stream is never a bare
number. A subagent whose own sources yield no phase takes its parent's, from
the branch of the parent transcript's checkout; one whose own `cwd` yields no
repo takes the repo of the parent transcript's `cwd`.

The same value lands in the `phase:` frontmatter field. When no source yields
exactly one phase, `phase:` is the empty string and no phase tag is applied. It
is never guessed from prose.

---

## The cap

**At most five hook-applied tags.** Ten tags a note is noise. The five slots are
filled in this order, so neither axis crowds out the other:

1. the phase tag, if there is one;
2. the two highest-count area tags — ties broken by the order in the list above;
3. up to two activity tags, in the order above;
4. any remaining area tags, then any remaining activity tags.

A session that edits files in six areas and opens a PR still says `pr`, which is
the whole point of having two axes.

**Manual tags are uncapped.** A tag Stack types into the note is a deliberate
act and the hook has no business rationing it.

## `unclassified`

A session that raises no tag at all gets exactly `tags: [unclassified]`. That is
a sentinel, not a term: it means "the classifier had nothing to go on", which is
a real and reviewable state — a planning conversation that edited no files looks
exactly like this.

List them with:

```bash
node hooks/untagged-sessions.mjs
```

It prints every note whose `tags` contain `unclassified`, newest first, with the
collection, the date and the first line of the session's first prompt. Run it
weekly; the fix for a note on that list is either a hand-added tag or a new rule
here.

---

## Adding a term

A tag Stack adds by hand is kept forever — the hook merges frontmatter and never
removes a tag it did not apply. But an off-list term is invisible to anyone
searching by the list, so:

1. add the term to the fenced block above, with a row in the table saying what
   raises it;
2. mirror it in `hooks/lib/vocabulary.mjs`;
3. if a mechanical signal exists, teach `hooks/lib/tags.mjs` to raise it.

Steps 1 and 2 are one commit, enforced by the test. Step 3 is optional — a term
can be manual-only.

## The rule the suite enforces

> Every tag the hook applies is in this file, or is exactly `unclassified`.

`hooks/tests/tags.test.mjs` parses the fenced block above, runs the classifier
over every fixture transcript, and asserts the set difference is empty. Schema
drift fails the suite instead of quietly polluting the store.
