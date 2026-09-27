#!/usr/bin/env bash
# One command brings up a machine (R-H6), for Linux, macOS and Git Bash. Mirrors
# bootstrap.ps1 step for step; the dev-VM runbook in docs/portable.md is the
# source of the steps and says what stays MANUAL.
#
#   scripts/bootstrap.sh --dry-run   # print every step and its exact command; run nothing
#   scripts/bootstrap.sh             # run them, stopping at the first failure
#
# The steps, in order (STEP_NAMES; bootstrap.ps1 holds the same list):
#   0 preflight      the machine file exists; git, uv, node, npm and docker are found
#   1 clone          agentic-harness to ~/agentic-harness (skipped when it is a clone of it)
#   2 uv-sync        uv sync in ingest/
#   3 mcp-build      npm ci, then npm run build, in mcp-server/
#   4 store          docker compose up -d --wait in db/, then pg_isready in the container
#   5 embed-migrate  uv run ingest embed-check, db migrate --dry-run, db migrate
#   6 realms         clone each realm HARNESS_REALMS names into HARNESS_VAULT (skipped when there)
#   7 config         clone claude-config to ~/claude-config, then install.mjs --config --apply
#   8 install        node hooks/install.mjs --register-mcp
#   9 doctor         node hooks/doctor.mjs --strict; its exit 1 (a problem row) fails the run
#
# Reads ~/.harness/machine.env (or HARNESS_MACHINE_ENV) through lib/machine-env.sh,
# the environment winning: HARNESS_VAULT (default ~/vault), HARNESS_REALMS
# (<realm>:<push|local>,...), HARNESS_REALM_REMOTE_BASE (a realm is cloned from
# <base>/vault-<realm>.git), HARNESS_REALM_REMOTE_<REALM> (one realm's URL, the
# name upper-cased with - as _; wins over the base), HARNESS_STORE_CONTAINER and
# HARNESS_STORE_DB (default harness-postgres and harness, as backup-store.sh).
#
# A dry run runs no tool. It does look: whether each clone target exists and,
# for one that does, `git -C <dir> remote get-url origin` (read-only). A failure
# it can already see (no machine file, a clone of the wrong remote, a realm with
# no remote) stops it the same way it would stop a real run.
#
# Exit 0 every step passed (or the dry run finished); 1 a step failed, named on
# the `bootstrap: step <n> <name> failed (exit <code>)` line; 2 a bad argument.
# A second run on a finished machine skips every clone and ends at doctor.

set -u

# The steps, in order; the index is the step number. The tests compare this line with bootstrap.ps1's.
STEP_NAMES=(preflight clone uv-sync mcp-build store embed-migrate realms config install doctor)
# The tools the steps call, checked before any of them runs.
REQUIRED_TOOLS=(git uv node npm docker)
HARNESS_REMOTE='https://github.com/emstacho-su/agentic-harness.git'
CONFIG_REMOTE='https://github.com/emstacho-su/claude-config.git'
# The realm name rule of hooks/lib/realm-sync.mjs (REALM_NAME) and its two policies.
REALM_NAME_RE='^[a-z0-9][a-z0-9-]{0,31}$'
REALM_POLICY_RE='^(push|local)$'
# How long compose waits for the container's healthcheck (db/docker-compose.yml).
STORE_WAIT_SECONDS=120

usage() { echo "usage: bootstrap.sh [--dry-run]" >&2; }

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "bootstrap: unknown argument '$arg'" >&2; usage; exit 2 ;;
  esac
done

native_path() {
  # native_path <path>: C:/Users/... on Git Bash, where node and uv cannot read /c/Users/...
  if command -v cygpath > /dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

HOME_DIR="$(native_path "$HOME")"
REPO_DIR="$HOME_DIR/agentic-harness"
CONFIG_DIR="$HOME_DIR/claude-config"
MACHINE_FILE="${HARNESS_MACHINE_ENV:-$HOME_DIR/.harness/machine.env}"
MACHINE_ENV_LIB="$(dirname "$0")/lib/machine-env.sh"

redact_url() {
  # redact_url <text>: https://user:token@host -> https://***@host, so a credential never reaches the output.
  printf '%s' "$1" | sed -E 's#://[^/@[:space:]]+@#://***@#g'
}

show_command() {
  # show_command <dir or ''> <command...>: the command as printed, a credential in a URL masked.
  local dir="$1"; shift
  local shown="" word
  for word in "$@"; do
    case "$word" in *[[:space:]]*) word="\"$word\"" ;; esac
    shown="${shown:+$shown }$(redact_url "$word")"
  done
  if [ -n "$dir" ]; then printf '(in %s) %s' "$dir" "$shown"; else printf '%s' "$shown"; fi
}

run_cmd() {
  # run_cmd <dir or ''> <command...>: print it, and in a real run run it there; returns its exit code.
  local dir="$1"; shift
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  would run: $(show_command "$dir" "$@")"
    return 0
  fi
  echo "  run: $(show_command "$dir" "$@")"
  if [ -n "$dir" ]; then (cd "$dir" && "$@"); else "$@"; fi
}

remote_slug() {
  # remote_slug <url>: owner/name for a GitHub remote (https or ssh), else the URL; lower case, no .git.
  local url
  url="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's#/+$##; s#\.git$##')"
  case "$url" in
    *github.com[:/]*) printf '%s' "${url#*github.com[:/]}" | sed -E 's#^/##' ;;
    *) printf '%s' "$url" ;;
  esac
}

ensure_clone() {
  # ensure_clone <url> <dir>: skip a clone of <url>, refuse anything else in the way, else clone.
  local url="$1" dir="$2" origin
  if [ -e "$dir/.git" ]; then
    origin="$(git -C "$dir" remote get-url origin 2> /dev/null)"
    if [ "$(remote_slug "$origin")" = "$(remote_slug "$url")" ]; then
      echo "  skip: $dir is already a clone of $(remote_slug "$url")"
      return 0
    fi
    echo "  $dir is a clone of '$(redact_url "${origin:-no origin}")', not $(remote_slug "$url"); move it aside and run again"
    return 1
  fi
  if [ -d "$dir" ] && [ -n "$(ls -A "$dir" 2> /dev/null)" ]; then
    echo "  $dir exists and is not a git clone; move it aside and run again"
    return 1
  fi
  run_cmd "" git clone -- "$url" "$dir"
}

step_preflight() {
  local problems=0 tool found
  if [ -f "$MACHINE_FILE" ]; then
    echo "  machine file: $MACHINE_FILE"
  else
    echo "  no machine file at $MACHINE_FILE: write it first (docs/portable.md, dev-VM runbook)"
    problems=1
  fi
  if [ -f "$MACHINE_ENV_LIB" ]; then
    # shellcheck source=lib/machine-env.sh
    . "$MACHINE_ENV_LIB" && load_machine_env || { echo "  could not read the machine file"; problems=1; }
  else
    echo "  $MACHINE_ENV_LIB is missing: run the script from a clone of agentic-harness"
    problems=1
  fi
  for tool in "${REQUIRED_TOOLS[@]}"; do
    found="$(command -v "$tool" || true)"
    if [ -z "$found" ] && [ "$tool" = uv ] && [ -x "$HOME/.local/bin/uv" ]; then
      PATH="$HOME/.local/bin:$PATH"; found="$HOME/.local/bin/uv"
    fi
    if [ -n "$found" ]; then echo "  $tool: $found"; else echo "  $tool: not found on PATH (runbook step 1)"; problems=1; fi
  done
  return "$problems"
}

step_clone() { ensure_clone "$HARNESS_REMOTE" "$REPO_DIR"; }

step_uv_sync() { run_cmd "$REPO_DIR/ingest" uv sync; }

step_mcp_build() {
  run_cmd "$REPO_DIR/mcp-server" npm ci || return
  run_cmd "$REPO_DIR/mcp-server" npm run build
}

step_store() {
  local container="${HARNESS_STORE_CONTAINER:-harness-postgres}" database="${HARNESS_STORE_DB:-harness}"
  run_cmd "$REPO_DIR/db" docker compose up -d --wait --wait-timeout "$STORE_WAIT_SECONDS" || return
  run_cmd "$REPO_DIR/db" docker exec "$container" pg_isready -U harness -d "$database"
}

step_embed_migrate() {
  run_cmd "$REPO_DIR/ingest" uv run ingest embed-check || return
  run_cmd "$REPO_DIR/ingest" uv run ingest db migrate --dry-run || return
  run_cmd "$REPO_DIR/ingest" uv run ingest db migrate
}

realm_url() {
  # realm_url <realm>: HARNESS_REALM_REMOTE_<REALM>, else <base>/vault-<realm>.git, else nothing.
  local key
  key="HARNESS_REALM_REMOTE_$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_')"
  if [ -n "$(printenv "$key")" ]; then printenv "$key"; return; fi
  [ -n "${HARNESS_REALM_REMOTE_BASE:-}" ] && printf '%s/vault-%s.git' "${HARNESS_REALM_REMOTE_BASE%/}" "$1"
}

step_realms() {
  local vault entry name policy url problems=0 names=()
  vault="$(native_path "${HARNESS_VAULT:-$HOME_DIR/vault}")"
  if [ -z "${HARNESS_REALMS:-}" ]; then
    echo "  skip: HARNESS_REALMS is not set, so there is no realm to clone"
    return 0
  fi
  # Every entry is checked, and every missing realm's URL found, before anything is cloned.
  IFS=',' read -r -a entries <<< "$HARNESS_REALMS"
  for entry in "${entries[@]}"; do
    entry="$(printf '%s' "$entry" | tr -d '[:space:]')"
    [ -n "$entry" ] || continue
    name="${entry%%:*}"; policy="${entry#*:}"
    if ! [[ "$name" =~ $REALM_NAME_RE ]] || ! [[ "$policy" =~ $REALM_POLICY_RE ]] || [ "$name" = "$entry" ]; then
      echo "  HARNESS_REALMS: '$entry' is not <realm>:<push|local>"
      problems=1; continue
    fi
    names+=("$name")
    if [ ! -e "$vault/$name" ] && [ -z "$(realm_url "$name")" ]; then
      echo "  realm $name has no remote: set HARNESS_REALM_REMOTE_BASE or HARNESS_REALM_REMOTE_$(printf '%s' "$name" | tr '[:lower:]-' '[:upper:]_') in the machine file, or make it with init-realm (runbook step 4)"
      problems=1
    fi
  done
  [ "$problems" -eq 0 ] || return 1
  if [ ! -d "$vault" ]; then run_cmd "" mkdir -p "$vault" || return; fi
  for name in "${names[@]}"; do
    if [ -e "$vault/$name/.git" ]; then echo "  skip: realm $name is already cloned at $vault/$name"; continue; fi
    if [ -e "$vault/$name" ]; then echo "  skip: $vault/$name exists and is not a git checkout; left as it is (doctor reports it)"; continue; fi
    url="$(realm_url "$name")"
    run_cmd "" git clone -- "$url" "$vault/$name" || return
  done
}

step_config() {
  ensure_clone "$CONFIG_REMOTE" "$CONFIG_DIR" || return
  run_cmd "$REPO_DIR" node hooks/install.mjs --config --apply --config-repo "$CONFIG_DIR"
}

step_install() { run_cmd "$REPO_DIR" node hooks/install.mjs --register-mcp; }

# doctor --strict prints its report, names each problem row, and exits 1 if there is one.
step_doctor() { run_cmd "$REPO_DIR" node hooks/doctor.mjs --strict; }

print_reminders() {
  echo "MANUAL: the push credential (runbook step 8): a fine-grained PAT of the account that owns this machine's realm, stored once with git credential approve; the nightly sync never prompts."
  echo "MANUAL: Obsidian Front Matter Title (runbook step 4): open ~/vault as a vault, install and enable the plugin, turn on its Graph and Explorer features."
  echo "MANUAL: a realm that exists on no remote yet is made with hooks/init-realm.mjs, not cloned (runbook step 4)."
  echo "MANUAL: register the nightly job and the daily store backup (runbook step 7); first night with -RealmSync DryRun."
  echo "MANUAL: read the minimum cosine of npm run verify:embedder in mcp-server/ (runbook step 6)."
}

n=0
for name in "${STEP_NAMES[@]}"; do
  echo "== step $n $name"
  code=0
  "step_${name//-/_}" || code=$?
  if [ "$code" -ne 0 ]; then
    echo "bootstrap: step $n $name failed (exit $code)"
    echo "bootstrap: fix it and run again; a finished step is safe to repeat"
    exit 1
  fi
  n=$((n + 1))
done

if [ "$DRY_RUN" -eq 1 ]; then echo "bootstrap: dry run, nothing was run"; else echo "bootstrap: all steps done"; fi
print_reminders
exit 0
