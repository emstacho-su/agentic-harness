# shellcheck shell=bash
# ~/.harness/machine.env reader for the bash scripts (backup-store.sh,
# nightly-ingest.sh). Sourced, never executed:
#
#   . "$(dirname "$0")/lib/machine-env.sh" && load_machine_env
#
# The file is KEY=value lines, the same file the hooks, ingest and the MCP server
# read. It is data, never code: nothing here evals, sources or expands a line.
# A key reaches the environment only when it is a plain shell identifier AND
# either starts with HARNESS_ or is one of MACHINE_ENV_SETTINGS. Without that, a
# line like `a[$(cmd)]=1` would run cmd through `${!key}`, and a name like
# LD_PRELOAD, BASH_ENV or DOCKER_HOST would be exported into every child.
#
# Rules: the shell always wins (a non-empty variable is never overridden); blank
# lines and `#` comments are skipped; `export ` is stripped; a trailing CR (a
# file saved on Windows) is stripped; a value in matching quotes loses them; a
# last line without a newline is still read. A rejected key is reported on
# stderr by name, never with its value.
#
# Plain assignments rather than readonly, so sourcing the lib twice is harmless.

# A shell identifier: nothing that bash could expand, subscript or evaluate.
MACHINE_ENV_KEY_RE='^[A-Za-z_][A-Za-z0-9_]*$'
# Every harness setting carries this prefix.
MACHINE_ENV_PREFIX='HARNESS_'
# The un-prefixed settings nightly-ingest.sh reads; exactly those, nothing more.
MACHINE_ENV_SETTINGS=' REALM_SYNC TRANSCRIPT_IDLE_HOURS STALE_AFTER_HOURS '
# Keys the file holds for programs that read it themselves (ingest, the hooks,
# the MCP server). Skipped quietly: not exported, and not reported as mistakes.
# Exporting DATABASE_URL here would also make it beat the repo .env, which the
# documented precedence forbids.
MACHINE_ENV_LEFT_TO_READERS=' DATABASE_URL DATABASE_SSL DATABASE_CA_CERT FASTEMBED_CACHE_DIR '

_machine_env_trim() {
  # _machine_env_trim <text>: print it without leading or trailing whitespace.
  local text="$1"
  text="${text#"${text%%[![:space:]]*}"}"
  text="${text%"${text##*[![:space:]]}"}"
  printf '%s' "$text"
}

_machine_env_unquote() {
  # _machine_env_unquote <text>: drop one pair of matching surrounding quotes.
  local text="$1" first last
  if [ "${#text}" -ge 2 ]; then
    first="${text:0:1}"; last="${text: -1}"
    if [ "$first" = "$last" ] && { [ "$first" = '"' ] || [ "$first" = "'" ]; }; then
      text="${text:1:${#text}-2}"
    fi
  fi
  printf '%s' "$text"
}

_machine_env_verdict() {
  # _machine_env_verdict <key>: print accept, skip or reject.
  local key="$1"
  if ! [[ "$key" =~ $MACHINE_ENV_KEY_RE ]]; then
    echo reject
  elif [ "${key#"$MACHINE_ENV_PREFIX"}" != "$key" ]; then
    echo accept
  elif [[ "$MACHINE_ENV_SETTINGS" == *" $key "* ]]; then
    echo accept
  elif [[ "$MACHINE_ENV_LEFT_TO_READERS" == *" $key "* ]]; then
    echo skip
  else
    echo reject
  fi
}

load_machine_env() {
  # Export the accepted keys of the machine file that the shell does not set.
  local file="${HARNESS_MACHINE_ENV:-$HOME/.harness/machine.env}"
  local line key value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="$(_machine_env_trim "$line")"
    case "$line" in ''|\#*) continue ;; esac
    case "$line" in 'export '*) line="$(_machine_env_trim "${line#export }")" ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="$(_machine_env_trim "${line%%=*}")"
    value="$(_machine_env_unquote "$(_machine_env_trim "${line#*=}")")"
    case "$(_machine_env_verdict "$key")" in
      accept) ;;
      skip) continue ;;
      *) printf "machine.env: ignoring key '%s'\n" "$key" >&2; continue ;;
    esac
    # Only now, with $key a plain identifier, is it safe to look it up.
    [ -n "$(printenv "$key")" ] && continue
    export "$key=$value"
  done < "$file"
  return 0
}
