#!/usr/bin/env bash
# The nightly reconcile, for Linux and macOS. Mirrors nightly-ingest.ps1 step
# for step; the PowerShell file's header explains the order and the reasons.
#
#   scripts/nightly-ingest.sh                 # everything
#   REALM_SYNC=skip scripts/nightly-ingest.sh # without the git steps
#
# Reads ~/.harness/machine.env (HARNESS_VAULT, HARNESS_INGEST_PROJECT,
# HARNESS_HOOKS_DIR, HARNESS_NODE, HARNESS_UV, HARNESS_NIGHTLY_LOG, REALM_SYNC,
# TRANSCRIPT_IDLE_HOURS, STALE_AFTER_HOURS, STORE_VERIFY, RETRIEVAL_EVAL) with
# the environment winning. STORE_VERIFY (apply|skip) switches the read-only store
# audit after the ingest; RETRIEVAL_EVAL (apply|skip) the retrieval eval that
# appends to ingest/eval/history.jsonl. The ingest and the hooks read the rest of
# that file (DATABASE_URL, ...) themselves.
# Register with cron, e.g.  0 3 * * * /path/to/agentic-harness/scripts/nightly-ingest.sh
# or with launchd on macOS; both are documented in docs/portable.md.
#
# Exit status is the ingest's, as on Windows: the reconcile is the job. Verify
# and eval only report; however they end, they never change it.

set -u

# The shared reader: HARNESS_* keys, REALM_SYNC, TRANSCRIPT_IDLE_HOURS,
# STALE_AFTER_HOURS, STORE_VERIFY and RETRIEVAL_EVAL from the machine file,
# nothing else (lib/machine-env.sh).
machine_env_lib="$(dirname "$0")/lib/machine-env.sh"
# shellcheck source=lib/machine-env.sh
. "$machine_env_lib" || { echo "FATAL could not read $machine_env_lib" >&2; exit 2; }
load_machine_env

VAULT="${HARNESS_VAULT:-$HOME/vault}"
PROJECT="${HARNESS_INGEST_PROJECT:-$HOME/agentic-harness/ingest}"
HOOKS="${HARNESS_HOOKS_DIR:-$HOME/agentic-harness/hooks}"
NODE_BIN="${HARNESS_NODE:-$(command -v node || true)}"
UV_BIN="${HARNESS_UV:-${HOME}/.local/bin/uv}"
[ -x "$UV_BIN" ] || UV_BIN="$(command -v uv || true)"
LOG="${HARNESS_NIGHTLY_LOG:-$HOME/.claude/hooks/nightly-ingest.log}"
REALM_SYNC="${REALM_SYNC:-apply}"
TRANSCRIPT_IDLE_HOURS="${TRANSCRIPT_IDLE_HOURS:-6}"
STALE_AFTER_HOURS="${STALE_AFTER_HOURS:-24}"
STORE_VERIFY="${STORE_VERIFY:-apply}"
RETRIEVAL_EVAL="${RETRIEVAL_EVAL:-apply}"

mkdir -p "$(dirname "$LOG")"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

run_step() {
  # run_step <label> <command...>: every line to the log, exit code returned.
  local label="$1"; shift
  log "$label : $*"
  "$@" 2>&1 | while IFS= read -r line; do log "$label | $line"; done
  local code=${PIPESTATUS[0]}
  log "$label : exit $code"
  return "$code"
}

log "=== nightly reconcile starting ==="
log "vault: $VAULT"
[ -d "$VAULT" ] || { log "FATAL vault not found: $VAULT"; exit 2; }
[ -f "$PROJECT/pyproject.toml" ] || { log "FATAL ingest project not found: $PROJECT"; exit 2; }
[ -n "$NODE_BIN" ] || { log "FATAL node not found; set HARNESS_NODE"; exit 2; }
[ -n "$UV_BIN" ] || { log "FATAL uv not found; set HARNESS_UV"; exit 2; }

# Step -1: commit and merge-pull every realm, so the night starts from what the
# other machines pushed. Exit 2 (conflict, lock held, refused) is never fatal: a
# conflicting merge is aborted with the local commit kept, and the night runs on.
pull_code=0
if [ "$REALM_SYNC" != "skip" ]; then
  sync_args=(--pull --vault "$VAULT"); [ "$REALM_SYNC" = "dryrun" ] && sync_args+=(--dry-run)
  run_step realms-pull "$NODE_BIN" "$HOOKS/sync-realms.mjs" "${sync_args[@]}"; pull_code=$?
fi

run_step transcripts "$NODE_BIN" "$HOOKS/sweep-transcripts.mjs" --vault "$VAULT" --min-idle-hours "$TRANSCRIPT_IDLE_HOURS"; transcript_code=$?
run_step checkpoints "$NODE_BIN" "$HOOKS/collect-checkpoints.mjs" --vault "$VAULT"; checkpoint_code=$?
run_step sweep "$UV_BIN" --directory "$PROJECT" run ingest sweep-concluded --path "$VAULT" --stale-after-hours "$STALE_AFTER_HOURS" --apply; sweep_code=$?
run_step ingest "$UV_BIN" --directory "$PROJECT" run ingest --source obsidian --path "$VAULT" --prune; ingest_code=$?

# Step 3: audit the store the ingest just left (read-only; 0 clean, 1 findings,
# 2 could not run). It runs after a failed ingest too, when it matters most.
verify_code=0
if [ "$STORE_VERIFY" = "skip" ]; then
  log "verify: skipped by STORE_VERIFY=skip"
else
  run_step verify "$UV_BIN" --directory "$PROJECT" run ingest verify --path "$VAULT"; verify_code=$?
fi
[ "$verify_code" -eq 0 ] || log "verify ended with $verify_code; 1 is findings, 2 is could not run, see the verify lines above"

# Step 4: score retrieval and append to ingest/eval/history.jsonl. No
# --min-hit-rate, so it reports and never gates.
eval_code=0
if [ "$RETRIEVAL_EVAL" = "skip" ]; then
  log "eval: skipped by RETRIEVAL_EVAL=skip"
else
  run_step eval "$UV_BIN" --directory "$PROJECT" run ingest eval --history; eval_code=$?
fi
[ "$eval_code" -eq 0 ] || log "eval ended with $eval_code; tonight's history line may be missing, see the eval lines above"

# Step 5: commit the night's notes, merge-pull, and push the push-policy realms.
# Nothing is forced, rebased or stashed; what cannot go now goes next time.
push_code=0
if [ "$REALM_SYNC" != "skip" ]; then
  sync_args=(--push --vault "$VAULT"); [ "$REALM_SYNC" = "dryrun" ] && sync_args+=(--dry-run)
  run_step realms-push "$NODE_BIN" "$HOOKS/sync-realms.mjs" "${sync_args[@]}"; push_code=$?
fi

log "=== nightly reconcile finished (realms-pull $pull_code, transcripts $transcript_code, checkpoints $checkpoint_code, sweep $sweep_code, ingest $ingest_code, verify $verify_code, eval $eval_code, realms-push $push_code) ==="
# Only the ingest decides the exit status; verify and eval report through the log.
exit "$ingest_code"
