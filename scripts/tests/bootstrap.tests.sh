#!/usr/bin/env bash
# Self-test for scripts/bootstrap.sh. No framework, no network, no Docker.
#
#   bash scripts/tests/bootstrap.tests.sh
#
# Runs bootstrap.sh against a scratch HOME (its name holds a space) with fake
# git, uv, node, npm and docker first on PATH. Every fake appends one line to a
# calls log ("<tool> [<cwd folder>] <args>") and exits with FAKE_EXIT_<TOOL>
# (0 by default). The fake git clone makes the target folder with a .git that
# remembers its URL, which the fake `git -C <dir> remote get-url origin` prints
# back. The fake uv exits FAKE_EXIT_EMBED on embed-check; the fake node prints
# FAKE_DOCTOR_OUTPUT when it runs doctor.mjs, and exits FAKE_EXIT_DOCTOR only
# when it was given --strict. Nothing real runs: no clone, no store, no ~/.claude.
#
# The cases: the step list (and that bootstrap.ps1 holds the same one), step
# order, --dry-run runs nothing, stop at the first failure with the step named,
# skip-if-present for every clone, the doctor gate, the realm remotes, and the
# MANUAL reminders. The scratch folder is removed on exit. Exits 1 if any case
# failed.

set -u

SCRIPTS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$SCRIPTS_DIR/bootstrap.sh"
PS_SCRIPT="$SCRIPTS_DIR/bootstrap.ps1"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
failures=0

# The order R-H6 and the dev-VM runbook in docs/portable.md fix.
EXPECTED_STEPS='preflight clone uv-sync mcp-build store embed-migrate realms config install doctor'
HARNESS_URL='https://github.com/emstacho-su/agentic-harness.git'
CONFIG_URL='https://github.com/emstacho-su/claude-config.git'
REALM_BASE='https://github.com/work-acct'

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
mkdir -p "$FAKE_BIN"

# One fake per tool. $1 of `git clone -- <url> <dir>` is clone, $3 the url, $4 the dir.
cat > "$FAKE_BIN/git" <<'FAKE'
#!/usr/bin/env bash
echo "git [$(basename "$PWD")] $*" >> "$FAKE_CALLS"
case "$1" in
  clone)
    mkdir -p "$4/.git" "$4/ingest" "$4/mcp-server" "$4/db" "$4/hooks"
    printf '%s\n' "$3" > "$4/.git/fake-origin"
    exit "${FAKE_EXIT_GIT:-0}" ;;
  -C)
    [ -f "$2/.git/fake-origin" ] || exit 2
    cat "$2/.git/fake-origin"; exit 0 ;;
esac
exit "${FAKE_EXIT_GIT:-0}"
FAKE
cat > "$FAKE_BIN/uv" <<'FAKE'
#!/usr/bin/env bash
echo "uv [$(basename "$PWD")] $*" >> "$FAKE_CALLS"
[ "${3:-}" = "embed-check" ] && exit "${FAKE_EXIT_EMBED:-0}"
exit "${FAKE_EXIT_UV:-0}"
FAKE
cat > "$FAKE_BIN/node" <<'FAKE'
#!/usr/bin/env bash
echo "node [$(basename "$PWD")] $*" >> "$FAKE_CALLS"
if [ "$1" = "hooks/doctor.mjs" ]; then
  echo "machine file  fake"
  [ -n "${FAKE_DOCTOR_OUTPUT:-}" ] && echo "$FAKE_DOCTOR_OUTPUT"
  [ "${2:-}" = "--strict" ] || exit 0
  exit "${FAKE_EXIT_DOCTOR:-0}"
fi
exit "${FAKE_EXIT_NODE:-0}"
FAKE
for tool in npm docker; do
  upper="$(echo "$tool" | tr '[:lower:]' '[:upper:]')"
  printf '#!/usr/bin/env bash\necho "%s [$(basename "$PWD")] $*" >> "$FAKE_CALLS"\nexit "${FAKE_EXIT_%s:-0}"\n' "$tool" "$upper" > "$FAKE_BIN/$tool"
done
chmod +x "$FAKE_BIN"/*
for tool in git uv node npm docker; do
  [ -x "$FAKE_BIN/$tool" ] || { echo "FAIL harness -- the fake $tool is not executable"; exit 1; }
done

FAKE_HOME=""
OUT_FILE=""
CALLS=""
run_code=0

new_home() {
  # new_home <name> [machine.env line...]: a fresh scratch HOME holding only the machine file.
  local name="$1"; shift
  FAKE_HOME="$SCRATCH/$name/fake home"
  mkdir -p "$FAKE_HOME/.harness"
  {
    printf '%s\n' "HARNESS_VAULT=$FAKE_HOME/vault"
    local line
    for line in "$@"; do printf '%s\n' "$line"; done
  } > "$FAKE_HOME/.harness/machine.env"
}

run_bootstrap() {
  # run_bootstrap <case> [VAR=value...] [-- <script args...>]: one run in a subshell.
  local name="$1"; shift
  OUT_FILE="$SCRATCH/$name.out"
  CALLS="$SCRATCH/$name.calls"
  : > "$CALLS"
  (
    unset HARNESS_MACHINE_ENV HARNESS_VAULT HARNESS_REALMS HARNESS_REALM_REMOTE_BASE HARNESS_REALM_REMOTE_WORK_VM \
      HARNESS_STORE_CONTAINER HARNESS_STORE_DB FAKE_EXIT_GIT FAKE_EXIT_UV FAKE_EXIT_EMBED FAKE_EXIT_NODE \
      FAKE_EXIT_NPM FAKE_EXIT_DOCKER FAKE_EXIT_DOCTOR FAKE_DOCTOR_OUTPUT
    export HOME="$FAKE_HOME" PATH="$FAKE_BIN:$PATH" FAKE_CALLS="$CALLS"
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do export "${1?}"; shift; done
    [ "${1:-}" = "--" ] && shift
    bash "$SCRIPT" "$@" > "$OUT_FILE" 2>&1
  )
  run_code=$?
}

out_has() { grep -qF -- "$1" "$OUT_FILE"; }
out_lacks() { ! out_has "$1"; }
calls_has() { grep -qF -- "$1" "$CALLS"; }
calls_lack() { ! calls_has "$1"; }
calls_empty() { [ ! -s "$CALLS" ]; }
exit_is() { [ "$run_code" -eq "$1" ]; }
exit_nonzero() { [ "$run_code" -ne 0 ]; }
line_in() { grep -nF -- "$2" "$1" | head -n 1 | cut -d: -f1; }
in_order() {
  # in_order <file> <text...>: each text's first line comes after the one before.
  local file="$1" previous=0 text at; shift
  for text in "$@"; do
    at="$(line_in "$file" "$text")"
    [ -n "$at" ] && [ "$at" -gt "$previous" ] || return 1
    previous="$at"
  done
}
headers_in_order() {
  local n=0 name args=()
  for name in $EXPECTED_STEPS; do args+=("== step $n $name"); n=$((n + 1)); done
  in_order "$OUT_FILE" "${args[@]}"
}
reminders_printed() { out_has "MANUAL" && out_has "PAT" && out_has "Front Matter Title"; }

# (1) static: the syntax and the step list, here and in bootstrap.ps1.
check "the script passes bash -n" bash -n "$SCRIPT"
sh_steps() { sed -n 's/^STEP_NAMES=(\(.*\))[[:space:]]*$/\1/p' "$SCRIPT" | tr -s ' ' ' '; }
ps_steps() { sed -n "s/^\$StepNames = @(\(.*\))[[:space:]]*\r\{0,1\}$/\1/p" "$PS_SCRIPT" | tr -d "' \r" | tr ',' ' '; }
sh_list_is_expected() { [ "$(sh_steps)" = "$EXPECTED_STEPS" ]; }
same_lists() { [ -n "$(sh_steps)" ] && [ "$(sh_steps)" = "$(ps_steps)" ]; }
check "bootstrap.sh's step list is the runbook order" sh_list_is_expected
check "bootstrap.sh and bootstrap.ps1 hold the same step list" same_lists

# (2) --dry-run on a fresh machine: every step and command printed, nothing run or made.
new_home dry "HARNESS_REALMS=work-vm:push" "HARNESS_REALM_REMOTE_BASE=$REALM_BASE"
run_bootstrap dry -- --dry-run
check "a dry run exits 0 (exit $run_code)" exit_is 0
check "a dry run calls no tool at all" calls_empty
check "a dry run prints every step header in order" headers_in_order
check "a dry run names the tools it found on PATH" out_has "fake-bin/git"
check "a dry run shows the harness clone" out_has "would run: git clone -- $HARNESS_URL"
check "a dry run shows uv sync in ingest/" out_has "ingest) uv sync"
check "a dry run shows npm ci then the build in mcp-server/" in_order "$OUT_FILE" "mcp-server) npm ci" "mcp-server) npm run build"
check "a dry run shows compose up in db/ and the readiness probe" in_order "$OUT_FILE" "db) docker compose up -d --wait" "docker exec harness-postgres pg_isready -U harness -d harness"
plain_migrate_last() {
  # The plain migrate line ends the command; its text is a prefix of the --dry-run line.
  local dry plain
  dry="$(line_in "$OUT_FILE" "uv run ingest db migrate --dry-run")"
  plain="$(grep -n "uv run ingest db migrate$" "$OUT_FILE" | head -n 1 | cut -d: -f1)"
  [ -n "$dry" ] && [ -n "$plain" ] && [ "$plain" -gt "$dry" ]
}
check "a dry run shows embed-check, then migrate --dry-run" in_order "$OUT_FILE" "uv run ingest embed-check" "uv run ingest db migrate --dry-run"
check "a dry run shows the real migrate after its dry run" plain_migrate_last
check "a dry run shows the realm clone from the base remote" out_has "git clone -- $REALM_BASE/vault-work-vm.git"
check "a dry run shows the config clone and install --config" in_order "$OUT_FILE" "git clone -- $CONFIG_URL" "node hooks/install.mjs --config --apply --config-repo"
check "a dry run shows install --register-mcp, then doctor --strict" in_order "$OUT_FILE" "node hooks/install.mjs --register-mcp" "node hooks/doctor.mjs --strict"
check "a dry run creates no repo, vault or config folder" [ ! -e "$FAKE_HOME/agentic-harness" ] && [ ! -e "$FAKE_HOME/vault" ] && [ ! -e "$FAKE_HOME/claude-config" ]
check "a dry run says nothing was run" out_has "bootstrap: dry run, nothing was run"
check "a dry run prints the MANUAL reminders" reminders_printed

# (3) a real run on a fresh machine: every step, in order, in the right folder.
new_home fresh "HARNESS_REALMS=work-vm:push" "HARNESS_REALM_REMOTE_BASE=$REALM_BASE"
run_bootstrap fresh
check "a fresh run exits 0 (exit $run_code)" exit_is 0
check "the calls run in the runbook order" in_order "$CALLS" \
  "clone -- $HARNESS_URL" "uv [ingest] sync" "npm [mcp-server] ci" "npm [mcp-server] run build" \
  "docker [db] compose up -d --wait" "docker [db] exec harness-postgres pg_isready" \
  "uv [ingest] run ingest embed-check" "uv [ingest] run ingest db migrate --dry-run" \
  "clone -- $REALM_BASE/vault-work-vm.git" "clone -- $CONFIG_URL" \
  "node [agentic-harness] hooks/install.mjs --config --apply --config-repo" \
  "node [agentic-harness] hooks/install.mjs --register-mcp" "node [agentic-harness] hooks/doctor.mjs --strict"
real_migrate() { grep -qxF -- "uv [ingest] run ingest db migrate" "$CALLS"; }
check "the migrate runs for real after its dry run" real_migrate
check "the realm is cloned into the vault" [ -d "$FAKE_HOME/vault/work-vm/.git" ]
check "the config repo is cloned to ~/claude-config" [ -d "$FAKE_HOME/claude-config/.git" ]
check "--config-repo is the config clone's path" calls_has "fake home/claude-config"
check "doctor's report is printed" out_has "machine file  fake"
check "a fresh run ends with the MANUAL reminders" reminders_printed
check "a fresh run says all steps are done" out_has "bootstrap: all steps done"

# (4) a second run on the finished machine skips every clone and still ends at doctor.
run_bootstrap again
check "a second run exits 0 (exit $run_code)" exit_is 0
check "a second run clones nothing" calls_lack " clone "
check "a second run notes the harness clone is there" out_has "is already a clone of emstacho-su/agentic-harness"
check "a second run notes the realm is there" out_has "work-vm is already cloned"
check "a second run still ends at doctor" calls_has "hooks/doctor.mjs"

# (5) the harness folder is a clone of something else: step 1 stops the run.
new_home wrong-remote "HARNESS_REALMS="
mkdir -p "$FAKE_HOME/agentic-harness/.git"
printf '%s\n' 'https://github.com/someone/other.git' > "$FAKE_HOME/agentic-harness/.git/fake-origin"
run_bootstrap wrong-remote
check "a clone of the wrong remote fails the run (exit $run_code)" exit_nonzero
check "the failure names step 1 clone" out_has "bootstrap: step 1 clone failed (exit 1)"
check "nothing after step 1 runs" calls_lack "uv "
check "a failed run prints no \"all steps done\"" out_lacks "all steps done"

# (6) stop at the first failure: npm fails, so nothing from step 4 on runs.
new_home npm-fails "HARNESS_REALMS="
run_bootstrap npm-fails FAKE_EXIT_NPM=7
check "a failing build fails the run (exit $run_code)" exit_nonzero
check "the failure names step 3 mcp-build and npm's code" out_has "bootstrap: step 3 mcp-build failed (exit 7)"
check "npm run build is not attempted after npm ci failed" calls_lack "npm [mcp-server] run build"
check "docker never runs after the failed step" calls_lack "docker "
check "node never runs after the failed step" calls_lack "node "

# (7) embed-check failing stops before any migrate.
new_home embed-fails "HARNESS_REALMS="
run_bootstrap embed-fails FAKE_EXIT_EMBED=1
check "a failing embed-check names step 5 (exit $run_code)" out_has "bootstrap: step 5 embed-migrate failed (exit 1)"
check "no migrate runs after a failed embed-check" calls_lack "db migrate"

# (8) the store never answers: step 4 stops the run.
new_home store-fails "HARNESS_REALMS="
run_bootstrap store-fails FAKE_EXIT_DOCKER=1
check "a store that never comes up names step 4 (exit $run_code)" out_has "bootstrap: step 4 store failed (exit 1)"
check "embed-check never runs without a store" calls_lack "embed-check"

# (9) doctor decides, by its --strict exit code: 1 fails step 9, 0 passes whatever the report says.
new_home doctor-problem "HARNESS_REALMS="
run_bootstrap doctor-problem FAKE_EXIT_DOCTOR=1 "FAKE_DOCTOR_OUTPUT=  problem: mcp-server build"
check "doctor --strict exiting 1 fails step 9 (exit $run_code)" out_has "bootstrap: step 9 doctor failed (exit 1)"
check "the problem row doctor names is shown" out_has "problem: mcp-server build"
check "doctor is run with --strict" calls_has "node [agentic-harness] hooks/doctor.mjs --strict"
check "a failed doctor prints no \"all steps done\"" out_lacks "all steps done"
run_bootstrap doctor-clean FAKE_EXIT_DOCTOR=0 "FAKE_DOCTOR_OUTPUT=mcp-server build  /x/dist/index.js (not built: npm run build)"
check "doctor --strict exiting 0 passes, whatever its text says (exit $run_code)" exit_is 0
check "the report is printed as doctor wrote it" out_has "(not built: npm run build)"
run_bootstrap doctor-usage FAKE_EXIT_DOCTOR=2
check "any other doctor exit fails step 9 with that code" out_has "bootstrap: step 9 doctor failed (exit 2)"

# (10) preflight: no machine file stops everything before a single call.
new_home no-machine-file
rm -f "$FAKE_HOME/.harness/machine.env"
run_bootstrap no-machine-file
check "a missing machine file fails step 0 preflight (exit $run_code)" out_has "bootstrap: step 0 preflight failed (exit 1)"
check "the missing file is named" out_has ".harness/machine.env"
check "no tool runs when preflight fails" calls_empty
run_bootstrap no-machine-file-dry -- --dry-run
check "a dry run stops at the same preflight failure" out_has "bootstrap: step 0 preflight failed (exit 1)"

# (11) the realm remotes: a per-realm key wins over the base; no remote is a named failure.
new_home realm-override "HARNESS_REALMS=work-vm:local" "HARNESS_REALM_REMOTE_BASE=$REALM_BASE" \
  "HARNESS_REALM_REMOTE_WORK_VM=https://example.test/notes/vm.git"
run_bootstrap realm-override -- --dry-run
check "HARNESS_REALM_REMOTE_<NAME> wins over the base" out_has "git clone -- https://example.test/notes/vm.git"
new_home realm-no-remote "HARNESS_REALMS=work-vm:push"
run_bootstrap realm-no-remote
check "a realm with no remote fails step 6 (exit $run_code)" out_has "bootstrap: step 6 realms failed (exit 1)"
check "the failure names the settings to add" out_has "HARNESS_REALM_REMOTE_BASE"
check "no realm clone ran" calls_lack "vault-work-vm"
check "config never runs after the failed realm step" calls_lack "claude-config"
new_home realm-bad-name "HARNESS_REALMS=../evil:push" "HARNESS_REALM_REMOTE_BASE=$REALM_BASE"
run_bootstrap realm-bad-name
check "a realm name outside the pattern fails step 6" out_has "bootstrap: step 6 realms failed (exit 1)"
check "no clone runs for a bad realm name" calls_lack "evil"
new_home realm-present "HARNESS_REALMS=work-vm:push"
mkdir -p "$FAKE_HOME/vault/work-vm/.git"
run_bootstrap realm-present
check "a realm already on disk needs no remote and is skipped (exit $run_code)" exit_is 0
check "the present realm is noted" out_has "work-vm is already cloned"

# (12) a remote carrying a credential is never printed with it.
new_home redact "HARNESS_REALMS=work-vm:push" "HARNESS_REALM_REMOTE_BASE=https://user:tok3n-secret@github.com/work-acct"
run_bootstrap redact -- --dry-run
check "a credential in a remote URL is not printed" out_lacks "tok3n-secret"
check "the redacted URL is still shown" out_has "https://***@github.com/work-acct/vault-work-vm.git"

# (13) --skip-config skips step 7 with a line that says so; every other step still runs.
new_home skip-config "HARNESS_REALMS="
run_bootstrap skip-config -- --skip-config
check "--skip-config exits 0 (exit $run_code)" exit_is 0
check "--skip-config still prints the step 7 header" out_has "== step 7 config"
check "--skip-config says step 7 was skipped and why" out_has "skipped (--skip-config)"
check "--skip-config clones no claude-config" calls_lack "claude-config"
check "--skip-config runs no install --config" calls_lack "--config --apply"
check "--skip-config still runs install and doctor" in_order "$CALLS" "hooks/install.mjs --register-mcp" "hooks/doctor.mjs --strict"
check "--skip-config creates no config folder" [ ! -e "$FAKE_HOME/claude-config" ]
run_bootstrap skip-config-dry -- --dry-run --skip-config
check "--skip-config with --dry-run says so and shows no config command" out_has "skipped (--skip-config)" && out_lacks "install.mjs --config"
new_home config-fails "HARNESS_REALMS="
run_bootstrap config-fails FAKE_EXIT_NODE=1
check "without --skip-config a failing step 7 still stops the run" out_has "bootstrap: step 7 config failed (exit 1)"

# (14) an unknown argument is refused before anything runs.
new_home bad-arg "HARNESS_REALMS="
run_bootstrap bad-arg -- --apply
check "an unknown argument exits 2 (exit $run_code)" exit_is 2
check "an unknown argument runs nothing" calls_empty

if [ "$failures" -gt 0 ]; then
  echo "$failures case(s) failed."
  exit 1
fi
echo "All cases passed."
exit 0
