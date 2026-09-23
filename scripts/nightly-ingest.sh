#!/usr/bin/env bash
# The nightly reconcile, for Linux and macOS. Mirrors nightly-ingest.ps1 step
# for step; the PowerShell file's header explains the order and the reasons.
#
#   scripts/nightly-ingest.sh                 # everything
#   REALM_SYNC=skip scripts/nightly-ingest.sh # without the git steps
#
# Reads ~/.harness/machine.env (HARNESS_VAULT, HARNESS_INGEST_PROJECT,
# HARNESS_HOOKS_DIR, HARNESS_NODE, HARNESS_UV) with the environment winning.
# Register with cron, e.g.  0 3 * * * /path/to/agentic-harness/scripts/nightly-ingest.sh
# or with launchd on macOS; both are documented in docs/portable.md.
#
# Exit status is the ingest's, as on Windows: the reconcile is the job.

set -u

machine_env="${HARNESS_MACHINE_ENV:-$HOME/.harness/machine.env}"
if [ -f "$machine_env" ]; then
  # KEY=value only; the file is ours, but it is still not sourced as code.
  while IFS='=' read -r key value; do
    key="${key#export }"; key="${key// /}"
    case "$key" in ''|\#*) continue ;; esac
    value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
    [ -z "${!key:-}" ] && export "$key=$value"
  done < "$machine_env"
fi

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

# Step 3: commit the night's notes, merge-pull, and push the push-policy realms.
# Nothing is forced, rebased or stashed; what cannot go now goes next time.
push_code=0
if [ "$REALM_SYNC" != "skip" ]; then
  sync_args=(--push --vault "$VAULT"); [ "$REALM_SYNC" = "dryrun" ] && sync_args+=(--dry-run)
  run_step realms-push "$NODE_BIN" "$HOOKS/sync-realms.mjs" "${sync_args[@]}"; push_code=$?
fi

log "=== nightly reconcile finished (realms-pull $pull_code, transcripts $transcript_code, checkpoints $checkpoint_code, sweep $sweep_code, ingest $ingest_code, realms-push $push_code) ==="
exit "$ingest_code"
