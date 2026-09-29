---
name: checkpoint
description: Save this session as a vault note when it is worth keeping. Use in a claude.ai/code (cloud) session, where no transcript reaches the user's machine, to file the session under a project (default, from the git remote) or a class (pass the course id, e.g. /checkpoint ist323). Writes .harness/sessions/<id>.md, commits it and pushes; the nightly harness job collects it into the Obsidian vault and the RAG store.
argument-hint: "[collection]  e.g. ist323, or empty for the repository's project"
allowed-tools: Bash(git *), Bash(node *), Bash(mkdir *), Bash(ls *), Bash(cat *), Read, Write
---

# /checkpoint — keep this session

This session runs where the user's session-capture hook cannot: nothing about it will reach
their vault unless you write it now. Do exactly the steps below. The frontmatter is built by a
script from git so it is a record, not a recollection; you write the body only.

**Collection argument:** `$ARGUMENTS`. Empty means "the project this repository is", which the
script derives from the git remote. A course id such as `ist323` files the note as classwork.
Pass it through unchanged; do not invent one.

## 1. Write the body

Create `.harness/checkpoint-body.md` with these four headings, in this order, all four present
even when a section is only one line:

```markdown
## What I asked for
1. <each request the user made in this session, in their words, one per item>

## What was done
- <what was built, fixed, decided, or found; name files and commits where you can>

## Decisions
- <choices made and the reason; "none" if none>

## Open questions / next steps
- <what is unresolved or what should happen next; "none" if none>
```

Rules for the body:
- Facts from this conversation only. Do not guess at work you cannot see in context.
- Never paste secrets, tokens, connection strings, or raw tool output. Describe; do not dump.
- Keep it under ~120 lines. This is an index entry the user will search, not a transcript.

## 2. Build the note

```bash
node .claude/skills/checkpoint/build-note.mjs --body .harness/checkpoint-body.md --collection "$ARGUMENTS"
```

It prints one JSON line. On `ok: true` note the `path` and `id`. On `ok: false` fix what it
names (usually a missing heading) and run it again.

This skill requires `node`; without it, stop and report that no checkpoint was written.

## 3. Commit and push

```bash
git add .harness/sessions
git commit -m "chore(harness): checkpoint <id>"
git push
```

The body file `.harness/checkpoint-body.md` is ignored by git; only the note is committed.
If the push is refused, do **not** retry or force: say so, and that the commit is on the
branch so the next push will carry it.

## 4. Report

Tell the user in one or two lines: the note path, the collection it was filed under, the
branch it was pushed to, and whether the push succeeded. The harness collects it at 12:00,
18:00 and 03:00 on the user's machine; it is searchable after the next of those.
