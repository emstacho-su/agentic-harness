# Memory sprint: status board

**Compiled** 2026-09-28 00:33 EDT-ish, by the sprint orchestrator, from `main` at `896f8e4`.
Re-verified live wherever a command could confirm it; the checkboxes in
`docs/memory-sprint-orchestration.md` are known stale (per the last H-b session) and are **not**
the source of truth below — the evidence column is. This doc is written once per audit pass; treat
it as a snapshot, not a live view.

## Commands run for this audit

```
git log --oneline -15 ; git status ; git branch -a ; git worktree list
gh pr list --state all --json number,title,state,baseRefName,headRefName,mergedAt
gh pr view 19..29 --json mergeCommit    # merge SHAs
gh pr view 27 / 28 --json body,statusCheckRollup,mergeable
tail -n 180 ~/.claude/hooks/nightly-ingest.log
cat ~/.claude/hooks/ingest-state.json ; cat ~/.claude/hooks/session-start.log
Resolve-DnsName aws-0-...supabase.com / github.com
Get-ScheduledTask + Get-ScheduledTaskInfo (AgenticHarness-*)
node hooks/doctor.mjs
gh repo view emstacho-su/claude-config
gh repo view emstacho-su/vault-harness --json isPrivate,pushedAt
uv run ingest db migrate --dry-run   (from ingest/)
```

## Per-unit status

| Unit | Requirements | Built | Merged | Live step | Record | Open items |
|---|---|---|---|---|---|---|
| **N** | R-N1, R-N2, R-N3 | PR #21, `feat/memory-n-hub-names` | `797c251` (2026-09-27) | **L1 — done**, unrecorded. Evidence: `hooks/README.md` §"The hub rename": *"Ran live on home-pc 2026-09-27: 19 moves, 348 rewrites, `--check` 0 broken."* But `memory-sprint-orchestration.md`'s L1 box is still `- [ ]`. | **Not written.** No "Phase N record" section exists in `memory-sprint-requirements.md` (unlike H-a's and P's) | No `docs:` record commit for N; Front Matter Title plugin install (MANUAL) status not found anywhere — unverified; eval before/after for L1 not found recorded |
| **P** | R-P1, R-P2, R-P3 | PR #20, `feat/memory-p-provenance`; docs in PR #22 | `6fa2a53`; record `1c917f7` | **L4 — done, gate waived.** Evidence: requirements doc "Phase P record — L4, 2026-09-27" (migration 7/7 applied, ingest 824 unchanged/0 chunks, live R-P1 check: subagent's 2 searches + 6 `retrieved:` links captured) | **Written** (`memory-sprint-requirements.md` §Phase P record) | MANUAL graph check (`retrieved:` draws edges) still open (see cross-cutting row below); dashboard build (now folded into C-b's plan, `a719c69`); R-P1 "next ten live sessions" done-when not yet confirmed; UTF-8 console-encoding bug in the text report; stale-event edge case deferred. (Q-a's negative case retiring **is** done — PR #25) |
| **Q-a** | R-Q1, R-Q3, R-Q2 dogfood negative | PR #19, `feat/memory-qa-store-audit` | `0f190be` (2026-09-27) | **L5 — not done.** Evidence: no nightly run since Q-a merged has reached `verify`/`eval` — the log's only entries after merge (2026-09-27T17:53) failed at the `ingest` step itself on a DNS error before verify/eval could run; `Get-ScheduledTaskInfo` shows `AgenticHarness-NightlyIngest` `LastTaskResult=1` at that same timestamp, `NextRunTime` 2026-09-28 03:00 | **Not written** | Needs one clean nightly (verify + eval) read afterward; DNS was transient — re-checked live just now, `Resolve-DnsName` clean for both `github.com` and the Supabase pooler host, and `uv run ingest db migrate --dry-run` connected fine (7 applied, 0 pending) |
| **H-b** | R-H4, R-H5, R-H6 | PR #29, `feat/memory-hb-start-and-portable` | `896f8e4` (2026-09-28 00:30 UTC) | **L2 — not done.** Evidence: `node hooks/doctor.mjs` shows the SessionStart hook *is* registered and firing (this session's own `session-start.log` line, 2026-09-28T00:33Z) — but `gh repo view emstacho-su/claude-config` returns *"could not resolve to a Repository"*: the GitHub repo R-H5 requires does not exist. Whether the currently-deployed hook copy is the reviewed/merged code or the earlier "accidental 19:56 install" is unconfirmed — `doctor.mjs` reports no hash/version | **Not written** | Per the last H-b session: (1) decide whether to undo the 19:56 install — probably moot, L2's reinstall supersedes it; (2) decide `skills/synced/` allowlist-vs-denylist (16 vs 9 scan findings to review); (3) Stack's "go L2" — real install, review scan findings, `gh repo create emstacho-su/claude-config --private`, first push, bootstrap trial on a scratch profile |
| **H-a** | R-H1, R-H2, R-H3 | PR #23, `feat/memory-ha-harness-realm` | `35a450b` (2026-09-27) | **L3 — done, gate waived.** Evidence: requirements doc "Phase H-a record — L3" (332 moved/4 archived/0 failed); confirmed live just now — `doctor.mjs`: `realm harness  git checkout, origin vault-harness.git, 2 commits`; `gh repo view emstacho-su/vault-harness` → private, `pushedAt 2026-09-27T21:13:44Z` | **Written** (`memory-sprint-requirements.md` §Phase H-a record) | The record's own "Open": the 3 real sessions landing in `harness/agentic-harness/sessions/` on next `SessionEnd` (worth a spot check); next nightly's `harness: … -> pushed` line still hasn't landed (no clean nightly since — same blocker as Q-a's L5) |
| **C-a** | R-C1, R-C2, R-C3 | PR #27, `feat/memory-ca-curator-ledger` | **Not merged.** OPEN, `mergeable: MERGEABLE`, CI 6/6 green incl. both Windows jobs (2026-09-27T21:41) | **None for this unit** — pilot is C-b's L7 | N/A pre-merge | Stack merges #27; MEDIUM findings deferred by design (ledger keyed by collection name alone; bare-filename suffix matching; `ledger.md` partial-write on mid-run failure; confirm-cache key not fingerprinting `CONFIRM_INSTRUCTIONS`) |
| **Q-b** | R-Q2 experiment, R-Q4, R-Q5, harness golden cases | **No branch exists.** No `feat/memory-qb-matrix` branch or worktree found (`git branch -a`, `git worktree list`) | N/A | **L6 — not started** | N/A | Orchestration doc's own gate: "N, P, H-a, H-b and Q-a merged **and** L1–L4 done." Merges: ✅ all five merged. L1–L4: L1 ✅(unrecorded), L2 ❌ (blocker), L3 ✅, L4 ✅(MANUAL check open). **So Q-b is blocked on L2 only** — matches the last H-b session's own read |
| **C-b** | R-C4–R-C7, pilot | PR #28, `feat/memory-cb-curator-status`, stacked on C-a's branch | **Not merged**; base is C-a's branch, not `main` — retarget once #27 merges. OPEN, `mergeable: MERGEABLE`, CI 6/6 green (2026-09-27T23:01) | **L7 — not started.** Full sequence (pre-flight → migration → dry runs → live pilot → sign-off → bb2dash → all → weekly task) is written out in the PR body, none run | N/A pre-merge | Long deferred list (see below); pilot needs Stack's "go L7" and sign-off at three separate checkpoints inside it |

## Cross-cutting rows

**1. The three-night `committed -> pulled -> pushed` prerequisite.** Never actually satisfied.
`memory-sprint-requirements.md` §Gates and order requires it before any live realm change in
Phase H; both the H-a (L3) and P (L4) records say **"Gate waived"** explicitly, because the PC
was down/crashed through the window and the 2026-09-27 catch-up run failed on DNS. Evidence:
`nightly-ingest.log` has no clean realm-push success recorded between 2026-09-24T07:01 (a
`--dry-run` only) and now. **Every live step run so far (L1, L3, L4) has run on an explicit
Stack waiver, not because the automated nightly ever completed a clean cycle.** The nightly
task itself is healthy (`Ready`, correct `NextRunTime` 2026-09-28 03:00) — the gap is that it
has not had an uninterrupted multi-night run since before this sprint started.

**2. L4's MANUAL graph check.** Still open — nobody has confirmed in Obsidian that a note's
`retrieved:` frontmatter draws a session→note edge in the graph view. No code or log can settle
this; it needs a human look.

**3. R-Q5's threshold date.** Not due. The spec sets no threshold until two weeks of baseline
retrieval-usage numbers exist, "on or after 2026-10-11" — 13 days from today. Nothing to do yet;
tracked so it isn't lost.

**4. Deferred items carried by PR #27 and PR #28.** Consolidated (full text is in each PR body):
- Ledger keyed by collection name alone; two realms sharing a folder name would share a ledger
- Bare filename suffix matching in `ledger_events.paths_match` (tune during the L7 pilot)
- `ledger.md` written only after every collection succeeds; a mid-run `StoreError` leaves earlier
  collections' file stale until the next clean run
- Confirmation-verdict cache key doesn't fingerprint `CONFIRM_INSTRUCTIONS`
- **Retrievals-dashboard publishing (R-P3) needs a decision from Stack**: (a) publish the static
  HTML as an Artifact once from the L7 session and re-publish by hand later [recommended by the
  PR], (b) add a `claude -p` republish step to the weekly script, or (c) accept the local file only
- Extractor-version bump (C-b added a `state` field) means the first L7 `extract` re-judges every
  note — budget calls/tokens accordingly
- Tick-forgery in curation reports (sub-threshold security observation) — sign reports before
  automatic mode ships next sprint
- Assorted small cleanup/dedup items (three note-index builders, unread parsed fields, a
  second Postgres connection for retrieval counts with silent fallback)

## One more finding not in the four requested rows

A real network outage happened mid-sprint and is worth flagging on its own: the 2026-09-27T17:53
nightly attempt failed with **DNS resolution failures for both `github.com` and the Supabase
pooler host** (`getaddrinfo failed`), not a code bug. Re-checked live during this audit:
`Resolve-DnsName` now resolves both cleanly and `uv run ingest db migrate --dry-run` connects fine
(7 applied, 0 pending). Whatever caused the outage appears to have cleared on its own; nothing to
fix in code, but it explains why Q-a's L5 and the nightly push evidence for H-a/N/P are all still
open.

## Questions for Stack

1. **Merge order.** PR #27 (C-a) has been sitting reviewed and CI-green since 2026-09-27T21:41.
   OK to merge it now so C-b (#28) can retarget to `main`?
2. **H-b's "go L2".** Ready whenever you are — it needs you specifically for: the real
   `node hooks/install.mjs` run (edits `settings.json`), reviewing the secret-scan findings list
   (`node hooks/export-config.mjs --list-findings`), `skills/synced/` allowlist-vs-denylist call,
   and the first push. This also unblocks Q-b.
3. **The accidental 19:56 install.** Still want it undone, or treat it as moot since L2's reinstall
   supersedes it either way?
4. **L5 (first real nightly with verify+eval).** Since network looks healthy again, OK to let
   tomorrow's 03:00 scheduled run be the first real attempt, or do you want a manual trigger now
   to get L5 off the books sooner (outside the 02:45–04:30 blackout, so a manual run now is fine)?
5. **N's missing record.** Should I write the "Phase N record" now (retroactively, from the
   `hooks/README.md` evidence and the hub-rename script's own dry-run log), so N stops being an
   undocumented "done"? I don't have N's before/after eval numbers on hand and would need to
   confirm none were captured, or just note that gap in the record.
6. **Q-a's missing record.** Same question — write a placeholder "Phase Q-a record" now noting
   R-Q1/R-Q3 code is merged but L5 hasn't run, so it's not falsely read as closed?
7. **Retrievals-dashboard decision (PR #28's deferred item).** (a) one-off Artifact publish now,
   re-published by hand later, (b) weekly `claude -p` republish step, or (c) local file only —
   recommendation is (a).

Once these are answered I'll proceed per the sprint's own order: merge #27 → H-b build is already
done, so it's straight to "go L2" → L5 → L7 → Q-b build → L6 → records → sprint close. I have not
started building the portable-hosting requirements doc yet (Step 3 of my brief) — that comes after
the memory sprint's live lane, per the brief's own instruction.
