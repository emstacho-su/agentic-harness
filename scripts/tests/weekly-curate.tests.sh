#!/usr/bin/env bash
# Self-test for scripts/weekly-curate.sh. No framework, no uv, no store, no judge.
#
#   bash scripts/tests/weekly-curate.tests.sh
#
# Runs weekly-curate.sh against a scratch vault (its name holds a space), a
# scratch project holding an empty pyproject.toml and a scratch reports folder,
# with a fake `uv` named by HARNESS_UV and also first on PATH, so even the
# script's `command -v uv` fallback finds the fake. The fake records its argv,
# one call per line with every argument in brackets, and exits with
# FAKE_CODE_<STAGE> (FAKE_CODE_EXTRACT=3, ...). For `report retrievals` it
# writes the two files named by --json-out and --html, the way the real command
# does, so a dry run that wrote them would show. Nothing real runs: no judge
# call, no database, no vault write.
#
# The cases cover the stage order, the flags CURATE_* produce and which stages
# get them, that exit 1 and 3 are logged and the run goes on, that exit 2 from
# any stage is logged, the run goes on and the script exits 2, that --dry-run
# reaches every curate stage and writes no report file, that CURATE_STAGES
# narrows the run, that bad settings are refused before anything runs, and that
# the log never holds a value from the machine file. Static checks: `bash -n`,
# the header's settings, the last line, and that the .sh and .ps1 list the same
# stages in the same order. The scratch folder is removed on exit. Exits 1 if
# any case failed.

set -u

SCRIPTS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$SCRIPTS_DIR/weekly-curate.sh"
PS_SCRIPT="$SCRIPTS_DIR/weekly-curate.ps1"
SH_LIB="$SCRIPTS_DIR/lib/machine-env.sh"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
failures=0

check() {
  # check <name> <condition...>
  local name="$1"; shift
  if "$@"; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    failures=$((failures + 1))
  fi
}

FAKE_BIN="$SCRATCH/fake-bin"
VAULT_DIR="$SCRATCH/my vault"
PROJECT_DIR="$SCRATCH/project"
mkdir -p "$FAKE_BIN" "$VAULT_DIR" "$PROJECT_DIR"
: > "$PROJECT_DIR/pyproject.toml"

# uv is called as `uv --directory <project> run ingest <command> <stage> ...`:
# $5 is curate or report, $6 the stage (retrievals for the report).
cat > "$FAKE_BIN/uv" <<'FAKE'
#!/usr/bin/env bash
printf '[%s]' "$@" >> "$FAKE_ARGV_LOG"; printf '\n' >> "$FAKE_ARGV_LOG"
echo "FAKE-UV $5 $6"
stage="$6"
if [ "$5" = "report" ] && [ "$6" = "retrievals" ]; then
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --json-out) echo '{}' > "$2"; shift ;;
      --html) echo '<html></html>' > "$2"; shift ;;
    esac
    shift
  done
fi
code_var="FAKE_CODE_$(printf '%s' "$stage" | tr '[:lower:]' '[:upper:]')"
exit "${!code_var:-0}"
FAKE
chmod +x "$FAKE_BIN/uv"
[ -x "$FAKE_BIN/uv" ] || { echo "FAIL harness -- the fake uv is not executable"; exit 1; }

LOG_FILE=""
ARGV_FILE=""
REPORTS=""
run_code=0

run_weekly() {
  # run_weekly <name> [--flag...] [VAR=value...]: one run in a subshell. Words
  # starting with -- go to the script; the rest are exported. VAR= (empty) lets
  # the machine file supply VAR. Sets LOG_FILE, ARGV_FILE, REPORTS and run_code.
  local name="$1"; shift
  LOG_FILE="$SCRATCH/$name.log"
  ARGV_FILE="$SCRATCH/$name.argv"
  REPORTS="$SCRATCH/$name-reports"
  : > "$ARGV_FILE"
  (
    unset CURATE_MODEL CURATE_MAX_CALLS CURATE_MAX_TOKENS CURATE_GIT CURATE_STAGES
    for stage in INVENTORY EXTRACT LEDGER STATUS HISTORY REPORT RETRIEVALS; do unset "FAKE_CODE_$stage"; done
    export HARNESS_MACHINE_ENV="$SCRATCH/absent.env"
    export HARNESS_VAULT="$VAULT_DIR" HARNESS_INGEST_PROJECT="$PROJECT_DIR" HARNESS_UV="$FAKE_BIN/uv"
    export HARNESS_WEEKLY_LOG="$LOG_FILE" HARNESS_REPORTS_DIR="$REPORTS" FAKE_ARGV_LOG="$ARGV_FILE"
    export PATH="$FAKE_BIN:$PATH"
    local word
    local -a flags=()
    for word in "$@"; do
      case "$word" in
        --*) flags+=("$word") ;;
        *) export "${word?}" ;;
      esac
    done
    bash "$SCRIPT" ${flags[@]+"${flags[@]}"} > /dev/null 2>&1
  )
  run_code=$?
}

log_has() { grep -qF -- "$1" "$LOG_FILE"; }
# A log that is not there proves nothing, so it lacks nothing.
log_lacks() { [ -f "$LOG_FILE" ] && ! log_has "$1"; }
exit_is() { [ "$run_code" -eq "$1" ]; }
# The argv line of one stage's call, empty when it was not called.
call_of() { grep -F -- "[$1][$2]" "$ARGV_FILE" | head -n 1; }
called() { [ -n "$(call_of "$1" "$2")" ]; }
not_called() { ! called "$1" "$2"; }
call_has() { call_of "$1" "$2" | grep -qF -- "$3"; }
call_lacks() { called "$1" "$2" && ! call_has "$1" "$2" "$3"; }
calls_are() {
  # calls_are <stage...>: exactly these stages were called, in this order.
  local actual
  actual="$(sed -n 's/^\[--directory\]\[[^]]*\]\[run\]\[ingest\]\[[a-z]*\]\[\([a-z]*\)\].*/\1/p' "$ARGV_FILE" | tr '\n' ' ')"
  [ "$actual" = "${*:+$* }" ]
}
no_reports() { [ ! -e "$REPORTS" ] || [ -z "$(ls -A "$REPORTS")" ]; }
ALL_STAGES=(inventory extract ledger status history report)

# (1) static.
check "the script passes bash -n" bash -n "$SCRIPT"
last_line_is_exit() { [ "$(grep -v '^[[:space:]]*$' "$SCRIPT" | tail -n 1)" = 'exit "$run_status"' ]; }
check "the last line is exit \"\$run_status\"" last_line_is_exit
header_names() { sed -n '1,30p' "$SCRIPT" | grep -q "$1"; }
for key in HARNESS_WEEKLY_LOG HARNESS_REPORTS_DIR CURATE_MODEL CURATE_MAX_CALLS CURATE_MAX_TOKENS CURATE_GIT CURATE_STAGES; do
  check "the header lists $key" header_names "$key"
done
sh_stages() { sed -n "s/^WEEKLY_STAGES='\(.*\)'$/\1/p" "$SCRIPT"; }
ps_stages() { sed -n "s/^\$script:WeeklyStages = @(\(.*\))[[:space:]]*$/\1/p" "$PS_SCRIPT" | tr -d "'\r" | tr ',' ' ' | tr -s ' '; }
same_stages() { [ -n "$(sh_stages)" ] && [ "$(sh_stages)" = "$(ps_stages)" ]; }
check "weekly-curate.sh and .ps1 list the same stages in the same order" same_stages
stage_list_is_contract() { [ "$(sh_stages)" = "inventory extract ledger status history report retrievals" ]; }
check "the stage list is the contract's weekly order" stage_list_is_contract

# (2) a clean week: every stage, in order, with its arguments.
run_weekly clean
check "a clean week exits 0 (exit $run_code)" exit_is 0
check "the stages run in the contract's order" calls_are inventory extract ledger status history report retrievals
check "inventory gets the vault path as one argument" call_has curate inventory "[--path][$VAULT_DIR]"
check "inventory gets no --all" call_lacks curate inventory "[--all]"
for stage in extract ledger status history report; do
  check "$stage gets --path <vault> --all" call_has curate "$stage" "[--path][$VAULT_DIR][--all]"
done
for flag in --model --max-calls --max-tokens --no-git --dry-run; do
  check "with no CURATE_* set, no stage gets $flag" bash -c "! grep -qF -- '[$flag]' '$ARGV_FILE'"
done
today="$(date -u +%Y-%m-%d)"
check "retrievals writes the dated JSON and the dashboard" call_has report retrievals "[--quiet][--json-out][$REPORTS/retrievals-$today.json][--html][$REPORTS/retrievals-dashboard.html]"
check "the reports folder is created and both files are there" test -f "$REPORTS/retrievals-$today.json" -a -f "$REPORTS/retrievals-dashboard.html"
check "a stage's own output reaches the log" log_has "extract | FAKE-UV curate extract"
check "the finish line lists every stage's code" log_has "(inventory 0, extract 0, ledger 0, status 0, history 0, report 0, retrievals 0) ==="
check "a clean week logs no \"ended with\"" log_lacks "ended with"

# (3) the CURATE_* settings, and which stages take which flag.
run_weekly flags CURATE_MODEL=fake-model CURATE_MAX_CALLS=7 CURATE_MAX_TOKENS=9000 CURATE_GIT=skip
check "a week with every setting exits 0 (exit $run_code)" exit_is 0
for stage in extract ledger status history report; do
  check "$stage gets --model --max-calls --max-tokens" call_has curate "$stage" "[--model][fake-model][--max-calls][7][--max-tokens][9000]"
done
check "inventory gets no --model (it calls no judge)" call_lacks curate inventory "[--model]"
check "inventory gets no --max-calls" call_lacks curate inventory "[--max-calls]"
for stage in inventory ledger status history report; do
  check "CURATE_GIT=skip gives $stage --no-git" call_has curate "$stage" "[--no-git]"
done
check "extract gets no --no-git (it reads no git)" call_lacks curate extract "[--no-git]"
check "retrievals gets none of the curate flags" call_lacks report retrievals "[--model]"

run_weekly git-apply CURATE_GIT=apply
check "CURATE_GIT=apply adds no --no-git" bash -c "! grep -qF -- '[--no-git]' '$ARGV_FILE'"

# (4) exit 3 and exit 1 are logged and the run goes on.
run_weekly budget FAKE_CODE_EXTRACT=3
check "extract stopped by budget still exits 0 (exit $run_code)" exit_is 0
check "the budget stop is logged" log_has "extract ended with 3 (stopped by budget)"
check "every later stage still runs" calls_are inventory extract ledger status history report retrievals
check "the finish line carries the 3" log_has "(inventory 0, extract 3, ledger 0,"

run_weekly findings FAKE_CODE_LEDGER=1 FAKE_CODE_INVENTORY=1
check "findings still exit 0 (exit $run_code)" exit_is 0
check "the ledger's findings are logged" log_has "ledger ended with 1 (findings)"
check "inventory's findings are logged" log_has "inventory ended with 1 (findings)"
check "every stage still runs after findings" calls_are inventory extract ledger status history report retrievals

# (5) exit 2 from any stage: logged, the run goes on, the script exits 2.
for stage in "${ALL_STAGES[@]}" retrievals; do
  upper="$(printf '%s' "$stage" | tr '[:lower:]' '[:upper:]')"
  run_weekly "fail-$stage" "FAKE_CODE_$upper=2"
  check "exit 2 from $stage makes the week exit 2 (exit $run_code)" exit_is 2
  check "exit 2 from $stage is logged" log_has "$stage ended with 2 (could not run)"
  check "every stage still runs after $stage could not run" calls_are inventory extract ledger status history report retrievals
done
check "the finish line carries the 2" log_has "retrievals 2) ==="

run_weekly odd-code FAKE_CODE_HISTORY=127
check "an unexpected exit code counts as could not run (exit $run_code)" exit_is 2

# (6) --dry-run: every curate stage gets it, and no report file is written.
run_weekly dry --dry-run
check "a dry run exits 0 (exit $run_code)" exit_is 0
for stage in "${ALL_STAGES[@]}"; do
  check "$stage gets --dry-run" call_has curate "$stage" "[--dry-run]"
done
check "the retrievals command does not run" not_called report retrievals
check "no report file and no reports folder" no_reports
check "the log says what would be written" log_has "retrievals: dry run, would write $REPORTS/retrievals-"

# (7) CURATE_STAGES narrows the run; comma or space separated.
run_weekly only-comma CURATE_STAGES=status,report
check "CURATE_STAGES=status,report exits 0 (exit $run_code)" exit_is 0
check "CURATE_STAGES=status,report runs only those" calls_are status report
check "a stage left out is logged as skipped" log_has "extract: skipped by CURATE_STAGES"
check "no report file when retrievals is left out" no_reports

run_weekly only-space "CURATE_STAGES=report status"
check "a space-separated list works, and the order stays the contract's" calls_are status report

run_weekly only-retrievals CURATE_STAGES=retrievals
check "CURATE_STAGES=retrievals runs only the retrievals report" calls_are retrievals

# (8) bad settings are refused before anything runs, and never echoed.
run_weekly bad-stage CURATE_STAGES=status,bogus-stage-name
check "an unknown stage name exits 2 (exit $run_code)" exit_is 2
check "nothing runs after an unknown stage name" calls_are
check "the refusal is a FATAL line" log_has "FATAL CURATE_STAGES"
check "the unknown name is not echoed" log_lacks "bogus-stage-name"

run_weekly bad-git CURATE_GIT=sometimes-maybe
check "a bad CURATE_GIT exits 2 (exit $run_code)" exit_is 2
check "nothing runs after a bad CURATE_GIT" calls_are
check "the bad CURATE_GIT value is not echoed" log_lacks "sometimes-maybe"

run_weekly bad-calls CURATE_MAX_CALLS=lots-of-calls
check "a non-integer CURATE_MAX_CALLS exits 2 (exit $run_code)" exit_is 2
check "the bad CURATE_MAX_CALLS value is not echoed" log_lacks "lots-of-calls"

run_weekly bad-tokens CURATE_MAX_TOKENS=0
check "CURATE_MAX_TOKENS=0 exits 2 (exit $run_code)" exit_is 2

run_weekly bad-arg --no-such-flag
check "an unknown argument exits 2 (exit $run_code)" exit_is 2
check "nothing runs after an unknown argument" calls_are

# (9) the vault, project and uv checks, as in the nightly script.
run_weekly no-vault HARNESS_VAULT="$SCRATCH/no such vault"
check "a missing vault exits 2 (exit $run_code)" exit_is 2
check "a missing vault is a FATAL line" log_has "FATAL vault not found"
check "nothing runs without a vault" calls_are

run_weekly no-project HARNESS_INGEST_PROJECT="$SCRATCH/no-project"
check "a missing project exits 2 (exit $run_code)" exit_is 2
check "a missing project is a FATAL line" log_has "FATAL ingest project not found"

# (10) the machine file: its paths are used, its values never reach the log.
machine_file="$SCRATCH/machine.env"
file_log="$SCRATCH/from-file/weekly.log"
file_reports="$SCRATCH/from-file/reports"
{
  echo "HARNESS_WEEKLY_LOG=$file_log"
  echo "HARNESS_REPORTS_DIR=$file_reports"
  echo 'DATABASE_URL=postgres://weekly-user:weekly-sekrit-7731@db.invalid:5432/harness'
  echo 'DATABASE_CA_CERT=/etc/weekly-ca-cert-7731.pem'
  echo 'ANTHROPIC_API_KEY=sk-ant-weekly-fake-7731'
  echo 'CURATE_MODEL=file-model-x9'
} > "$machine_file"
run_weekly machine-file HARNESS_MACHINE_ENV="$machine_file" HARNESS_WEEKLY_LOG= HARNESS_REPORTS_DIR=
LOG_FILE="$file_log"
check "a week configured by the machine file exits 0 (exit $run_code)" exit_is 0
check "HARNESS_WEEKLY_LOG from the file names the log" test -f "$file_log"
check "HARNESS_REPORTS_DIR from the file names the reports folder" test -f "$file_reports/retrievals-dashboard.html"
check "the database URL never reaches the log" log_lacks "weekly-sekrit-7731"
check "no machine-file value but the two paths reaches the log" log_lacks "-7731"
if grep -q 'CURATE_MODEL' "$SH_LIB"; then
  check "CURATE_MODEL from the file reaches the judge stages" call_has curate extract "[--model][file-model-x9]"
else
  echo "SKIP CURATE_MODEL from the file (lib/machine-env.sh does not accept CURATE_* keys yet)"
fi

run_weekly env-wins HARNESS_MACHINE_ENV="$machine_file"
check "the environment wins over the file for the log path" test -f "$SCRATCH/env-wins.log"

if [ "$failures" -gt 0 ]; then
  echo "$failures case(s) failed."
  exit 1
fi
echo "All cases passed."
exit 0
