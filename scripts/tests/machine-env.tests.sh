#!/usr/bin/env bash
# Self-test for scripts/lib/machine-env.sh. No framework, no Docker.
#
#   bash scripts/tests/machine-env.tests.sh
#
# Writes a scratch machine.env with every awkward line the reader must survive,
# sources the lib in a subshell with a controlled environment, and prints PASS or
# FAIL per case. The scratch folder is removed on exit. Exits 1 if any case failed.

set -u

LIB="$(cd "$(dirname "$0")/.." && pwd)/lib/machine-env.sh"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

FILE="$SCRATCH/machine.env"
ENV_OUT="$SCRATCH/env.out"
ERR_OUT="$SCRATCH/stderr.out"
# A value that must never reach any output: it belongs to a key this reader skips.
SECRET="s3cret-value-never-printed"
failures=0

# The file: comments, a blank, a quoted value, a CRLF line, an injection attempt,
# a dangerous name, the allowlisted setting, a key the shell already has, a key
# left to the programs that read the file themselves, and a last line without a
# newline. printf, not a heredoc, so the CR and the missing newline are exact.
{
  printf '%s\n' '# what this machine is' ''
  printf '%s\n' 'HARNESS_STORE_DB=other'
  printf '%s\n' 'HARNESS_QUOTED="a value with spaces"'
  printf '%s\r\n' 'HARNESS_CRLF=crlf-value'
  printf '%s\n' 'a[$(echo INJECTED >&2)]=1'
  # The same without spaces, which survive a reader that strips them from keys.
  printf '%s\n' 'b[$(echo${IFS}INJECTED2>&2)]=1'
  printf '%s\n' 'LD_PRELOAD=/x'
  printf '%s\n' 'BASH_ENV=/tmp/evil'
  printf '%s\n' 'export HARNESS_X=1'
  printf '%s\n' 'REALM_SYNC=dryrun'
  printf '%s\n' 'HARNESS_ALREADY=from-file'
  printf '%s\n' "DATABASE_URL=postgresql://harness:${SECRET}@localhost:5433/harness"
  printf '%s' 'HARNESS_LAST=no-newline'
} > "$FILE"

# The load runs in a subshell: nothing it exports can leak into this script.
(
  unset LD_PRELOAD BASH_ENV DATABASE_URL REALM_SYNC HARNESS_STORE_DB HARNESS_QUOTED \
    HARNESS_CRLF HARNESS_X HARNESS_LAST
  export HARNESS_MACHINE_ENV="$FILE"
  export HARNESS_ALREADY=from-env
  # shellcheck source=../lib/machine-env.sh
  . "$LIB" || exit 90
  load_machine_env 2> "$ERR_OUT" || exit 91
  env > "$ENV_OUT"
)
load_code=$?

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

value_of() { grep -E "^$1=" "$ENV_OUT" | head -n 1 | cut -d= -f2-; }
exported() { grep -qE "^$1=" "$ENV_OUT"; }
not_exported() { ! exported "$1"; }
equals() { [ "$(value_of "$1")" = "$2" ]; }
stderr_has() { grep -qF -- "$1" "$ERR_OUT"; }
stderr_lacks() { ! stderr_has "$1"; }
stderr_lacks_line() { ! grep -qxF -- "$1" "$ERR_OUT"; }
nothing_has() { ! grep -qF -- "$1" "$ENV_OUT" "$ERR_OUT"; }
cr_free() { ! grep -q $'\r' "$ENV_OUT"; }

check "the lib sources and loads (exit $load_code)" [ "$load_code" -eq 0 ]
check "a last line without a newline is read" equals HARNESS_LAST no-newline
check "a CRLF line is read without its CR" equals HARNESS_CRLF crlf-value
check "no exported value carries a CR" cr_free
check "the injection line never runs" stderr_lacks_line INJECTED
check "the space-free injection line never runs" stderr_lacks_line INJECTED2
check "no key is ever run as a command" stderr_lacks "command not found"
check "the injection line is reported as an ignored key" stderr_has "machine.env: ignoring key 'a[\$(echo INJECTED >&2)]'"
check "LD_PRELOAD is not exported" not_exported LD_PRELOAD
check "LD_PRELOAD is reported as an ignored key" stderr_has "machine.env: ignoring key 'LD_PRELOAD'"
check "BASH_ENV is not exported" not_exported BASH_ENV
check "HARNESS_STORE_DB is exported" equals HARNESS_STORE_DB other
check "a quoted value loses its quotes" equals HARNESS_QUOTED "a value with spaces"
check "a key already in the environment is not overridden" equals HARNESS_ALREADY from-env
check "an 'export ' line is accepted" equals HARNESS_X 1
check "the allowlisted REALM_SYNC is exported" equals REALM_SYNC dryrun
check "DATABASE_URL is left to its readers, not exported" not_exported DATABASE_URL
check "DATABASE_URL is not reported as ignored" stderr_lacks "'DATABASE_URL'"
check "no value from the file reaches the output unasked" nothing_has "$SECRET"

# A missing file is not an error: the reader does nothing.
(
  export HARNESS_MACHINE_ENV="$SCRATCH/absent.env"
  . "$LIB" || exit 90
  load_machine_env 2> "$ERR_OUT"
)
missing_code=$?
quiet_success() { [ "$missing_code" -eq 0 ] && [ ! -s "$ERR_OUT" ]; }
check "a missing machine file is exit 0 and silent (exit $missing_code)" quiet_success

if [ "$failures" -gt 0 ]; then
  echo "$failures case(s) failed."
  exit 1
fi
echo "All cases passed."
exit 0
