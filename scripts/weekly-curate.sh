#!/usr/bin/env bash
# The weekly curator run, for Linux and macOS. Mirrors weekly-curate.ps1 step
# for step; the PowerShell file's header explains the order and the reasons.
#
#   scripts/weekly-curate.sh             # every stage
#   scripts/weekly-curate.sh --dry-run   # --dry-run to every stage, no report file
#   CURATE_STAGES=status,report scripts/weekly-curate.sh
#
# Reads ~/.harness/machine.env (HARNESS_VAULT, HARNESS_INGEST_PROJECT,
# HARNESS_UV, HARNESS_WEEKLY_LOG, HARNESS_REPORTS_DIR, and CURATE_MODEL,
# CURATE_MAX_CALLS, CURATE_MAX_TOKENS, CURATE_GIT, CURATE_STAGES once
# lib/machine-env.sh accepts them) with the environment winning:
#   CURATE_MODEL       --model for the stages that call the judge
#   CURATE_MAX_CALLS   --max-calls for them (a positive integer)
#   CURATE_MAX_TOKENS  --max-tokens for them (a positive integer)
#   CURATE_GIT         apply (default) or skip; skip gives --no-git to the
#                      stages that read git
#   CURATE_STAGES      the stages to run, space- or comma-separated, from
#                      inventory extract ledger status history report
#                      retrievals; default all. They always run in that order.
# The stages read the rest of that file (DATABASE_URL, ...) themselves.
# Register with cron after the nightly job and the backup, e.g.
#   30 4 * * 0 /path/to/agentic-harness/scripts/weekly-curate.sh
# or with launchd on macOS.
#
# Every stage runs, whatever the one before it did: exit 1 (findings) and 3
# (stopped by budget) are logged, and so is 2 (could not run), because status,
# history and report still work from the cache. Exit status is 2 when any stage
# could not run, else 0.

set -u

# The weekly order (the C-b contract; weekly-curate.ps1 lists the same).
WEEKLY_STAGES='inventory extract ledger status history report retrievals'

usage() {
  echo "usage: $0 [--dry-run]" >&2
  exit 2
}

dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -h|--help) echo "usage: $0 [--dry-run]"; exit 0 ;;
    *) usage ;;
  esac
done

# The shared reader: HARNESS_* keys and the few allowlisted settings from the
# machine file, nothing else (lib/machine-env.sh).
machine_env_lib="$(dirname "$0")/lib/machine-env.sh"
# shellcheck source=lib/machine-env.sh
. "$machine_env_lib" || { echo "FATAL could not read $machine_env_lib" >&2; exit 2; }
load_machine_env

VAULT="${HARNESS_VAULT:-$HOME/vault}"
PROJECT="${HARNESS_INGEST_PROJECT:-$HOME/agentic-harness/ingest}"
UV_BIN="${HARNESS_UV:-${HOME}/.local/bin/uv}"
[ -x "$UV_BIN" ] || UV_BIN="$(command -v uv || true)"
LOG="${HARNESS_WEEKLY_LOG:-$HOME/.claude/hooks/weekly-curate.log}"
REPORTS="${HARNESS_REPORTS_DIR:-$HOME/.harness/reports}"
CURATE_MODEL="${CURATE_MODEL:-}"
CURATE_MAX_CALLS="${CURATE_MAX_CALLS:-}"
CURATE_MAX_TOKENS="${CURATE_MAX_TOKENS:-}"
CURATE_GIT="${CURATE_GIT:-apply}"
CURATE_STAGES="${CURATE_STAGES:-all}"

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

log "=== weekly curate starting ==="
log "vault: $VAULT"
[ -d "$VAULT" ] || { log "FATAL vault not found: $VAULT"; exit 2; }
[ -f "$PROJECT/pyproject.toml" ] || { log "FATAL ingest project not found: $PROJECT"; exit 2; }
[ -n "$UV_BIN" ] || { log "FATAL uv not found; set HARNESS_UV"; exit 2; }

# The settings are checked before anything runs. A bad value is named by its
# key only: nothing from the machine file or the environment is echoed.
positive_int_re='^[1-9][0-9]*$'
case "$CURATE_GIT" in
  apply|skip) ;;
  *) log "FATAL CURATE_GIT must be apply or skip"; exit 2 ;;
esac
[ -z "$CURATE_MAX_CALLS" ] || [[ "$CURATE_MAX_CALLS" =~ $positive_int_re ]] \
  || { log "FATAL CURATE_MAX_CALLS must be a positive integer"; exit 2; }
[ -z "$CURATE_MAX_TOKENS" ] || [[ "$CURATE_MAX_TOKENS" =~ $positive_int_re ]] \
  || { log "FATAL CURATE_MAX_TOKENS must be a positive integer"; exit 2; }

selected=" "
# read -a, not an unquoted $(...): a `*` in the value must not glob.
read -ra stage_names <<< "${CURATE_STAGES//,/ }"
for name in ${stage_names[@]+"${stage_names[@]}"}; do
  if [ "$name" = "all" ]; then
    selected=" $WEEKLY_STAGES "
  elif [[ " $WEEKLY_STAGES " == *" $name "* ]]; then
    selected="$selected$name "
  else
    log "FATAL CURATE_STAGES names a stage that does not exist; use all or any of: $WEEKLY_STAGES"
    exit 2
  fi
done
[ "$selected" != " " ] || { log "FATAL CURATE_STAGES names no stage; use all or any of: $WEEKLY_STAGES"; exit 2; }
is_selected() { [[ "$selected" == *" $1 "* ]]; }
[ "$dry_run" -eq 1 ] && log "dry run: --dry-run goes to every curate stage; no report file is written"

run_status=0
note_code() {
  # note_code <stage> <code>: record it for the finish line and say what it means.
  local stage="$1" code="$2"
  printf -v "code_$stage" '%s' "$code"
  case "$code" in
    0) ;;
    1) log "$stage ended with 1 (findings); see the $stage lines above; continuing" ;;
    3) log "$stage ended with 3 (stopped by budget); what it finished is kept, the rest waits for next week; continuing" ;;
    *) log "$stage ended with $code (could not run); continuing, the later stages work from the cache"
       run_status=2 ;;
  esac
}

curate_stage() {
  # curate_stage <stage> [stage args...]: one `ingest curate` stage through run_step.
  local stage="$1"; shift
  if ! is_selected "$stage"; then log "$stage: skipped by CURATE_STAGES"; note_code "$stage" 0; return; fi
  local args=(--path "$VAULT" "$@")
  # The judge stages take the model and the budget; inventory and status call no judge.
  case "$stage" in extract|ledger|history|report)
    [ -n "$CURATE_MODEL" ] && args+=(--model "$CURATE_MODEL")
    [ -n "$CURATE_MAX_CALLS" ] && args+=(--max-calls "$CURATE_MAX_CALLS")
    [ -n "$CURATE_MAX_TOKENS" ] && args+=(--max-tokens "$CURATE_MAX_TOKENS")
    ;;
  esac
  # Every stage but extract reads git; extract reads notes and the cache only.
  [ "$stage" != "extract" ] && [ "$CURATE_GIT" = "skip" ] && args+=(--no-git)
  [ "$dry_run" -eq 1 ] && args+=(--dry-run)
  run_step "$stage" "$UV_BIN" --directory "$PROJECT" run ingest curate "$stage" "${args[@]}"
  note_code "$stage" $?
}

# Steps 1-6: the curator stages, each on the cache the one before it left.
curate_stage inventory
curate_stage extract --all
curate_stage ledger --all
curate_stage status --all
curate_stage history --all
curate_stage report --all

# Step 7: the retrieval provenance report, as JSON for the week and as the
# dashboard page. A dry run writes nothing, so it only says what it would write.
day="$(date -u +%Y-%m-%d)"
json_out="$REPORTS/retrievals-$day.json"
html_out="$REPORTS/retrievals-dashboard.html"
if ! is_selected retrievals; then
  log "retrievals: skipped by CURATE_STAGES"; note_code retrievals 0
elif [ "$dry_run" -eq 1 ]; then
  log "retrievals: dry run, would write $json_out and $html_out"; note_code retrievals 0
elif ! mkdir -p "$REPORTS"; then
  log "retrievals: could not create the reports folder $REPORTS"; note_code retrievals 2
else
  run_step retrievals "$UV_BIN" --directory "$PROJECT" run ingest report retrievals --quiet --json-out "$json_out" --html "$html_out"
  note_code retrievals $?
fi

log "=== weekly curate finished (inventory $code_inventory, extract $code_extract, ledger $code_ledger, status $code_status, history $code_history, report $code_report, retrievals $code_retrievals) ==="
# 2 when any stage could not run; findings and budget stops report through the log.
exit "$run_status"
