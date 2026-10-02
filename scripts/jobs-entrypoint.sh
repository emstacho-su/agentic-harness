#!/usr/bin/env bash
# The jobs container's entrypoint: secrets from files, git set up for the
# realms, then the command.
#
#   ENTRYPOINT ["tini", "--", "bash", "/app/scripts/jobs-entrypoint.sh"]
#   CMD        ["node", "hooks/scheduler.mjs"]
#
# 1. The *_FILE shim. For each name in SECRET_FILE_VARS, `<NAME>_FILE` names a
#    file (a Docker secret under /run/secrets) and `<NAME>` is exported from its
#    content, before any job starts, so psycopg finds DATABASE_URL where it
#    always has. Nothing secret is ever in `environment:`, a build argument or
#    an image layer. A file that is named but missing or empty stops the
#    container: a job that runs without its store would only fail later, at 03:00.
#    The list is explicit on purpose. A loop over every *_FILE variable would
#    also read HARNESS_INGEST_STATE_FILE, which is a path and not a secret.
#    A process started by `docker compose exec` does not pass through here. It
#    has DATABASE_URL_FILE (the service's environment) and not DATABASE_URL, so
#    hooks/scheduler.mjs reads the same list of files itself (envWithSecretFiles)
#    and doctor.mjs reports through it.
# 2. Git. A fresh global config for this container, written at each start to
#    the path GIT_CONFIG_GLOBAL names (fixed by the image, so an exec'd process
#    reads it too). It holds no token:
#    - `safe.directory` for every realm checkout under the vault and every
#      checkpoint repository. A bind-mounted Windows checkout is owned by root
#      as seen from here, and git refuses a repository owned by someone else.
#    - a credential helper for https://github.com that reads the realm PAT from
#      VAULT_REALM_PAT_FILE each time git asks. The token is never exported,
#      never written to the config and never printed. With no token the helper
#      is not set, and a push fails closed with git's `credential` line (the
#      sync turns prompts off).
#
# Exit 78 (EX_CONFIG) on a bad setting. Values are never echoed, only names and paths.

set -eu

EX_CONFIG=78
SECRET_FILE_VARS="DATABASE_URL"
PAT_FILE_VAR="VAULT_REALM_PAT_FILE"
GIT_HOST_URL="https://github.com"
# Any non-empty user name works with a fine-grained token; this is GitHub's own placeholder.
GIT_TOKEN_USER="x-access-token"

fail() {
  echo "jobs-entrypoint: $*" >&2
  exit "$EX_CONFIG"
}

# One line of a secret file, without the CR or LF an editor left at its end.
read_secret() {
  tr -d '\r\n' < "$1"
}

for name in $SECRET_FILE_VARS; do
  file_var="${name}_FILE"
  file="${!file_var:-}"
  [ -n "$file" ] || continue
  [ -z "${!name:-}" ] || fail "$name and $file_var are both set; set only $file_var"
  [ -r "$file" ] || fail "$file_var names $file, which is not a readable file"
  value="$(read_secret "$file")"
  [ -n "$value" ] || fail "$file_var names $file, which is empty"
  export "$name=$value"
  unset value "$file_var"
done

# The image sets GIT_CONFIG_GLOBAL to a fixed path, and that is the file written
# here. A process started later by `docker compose exec` inherits the variable
# from the image, not from this script, so it reads the same file. The fallback
# is for running this script outside the image.
export GIT_CONFIG_GLOBAL="${GIT_CONFIG_GLOBAL:-${HOME}/.gitconfig-jobs}"
: > "$GIT_CONFIG_GLOBAL"

trust_checkout() {
  # trust_checkout <dir>: mark it safe when it is a git checkout.
  [ -e "$1/.git" ] || return 0
  git config --global --add safe.directory "$1"
}

vault="${HARNESS_VAULT:-}"
if [ -n "$vault" ] && [ -d "$vault" ]; then
  trust_checkout "$vault"
  for realm in "$vault"/*/; do
    [ -d "$realm" ] && trust_checkout "${realm%/}"
  done
fi

IFS=',' read -r -a checkpoint_repos <<< "${HARNESS_CHECKPOINT_REPOS:-}"
for repo in "${checkpoint_repos[@]}"; do
  repo="$(printf '%s' "$repo" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -n "$repo" ] && trust_checkout "$repo"
done

pat_file="${!PAT_FILE_VAR:-}"
if [ -n "$pat_file" ] && [ -s "$pat_file" ]; then
  case "$pat_file" in
    *"'"*) fail "$PAT_FILE_VAR must not contain a single quote" ;;
  esac
  # The helper runs in git's shell at the moment of the push and reads the file then.
  git config --global "credential.${GIT_HOST_URL}.helper" \
    "!f() { test \"\$1\" = get || exit 0; printf 'username=%s\\npassword=%s\\n' '${GIT_TOKEN_USER}' \"\$(tr -d '\\r\\n' < '${pat_file}')\"; }; f"
else
  echo "jobs-entrypoint: no realm token ($PAT_FILE_VAR unset or its file empty); realm pushes will fail closed" >&2
fi

exec "$@"
