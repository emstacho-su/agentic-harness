#!/usr/bin/env bash
# Dump the local store to a host folder and keep the newest KEEP dumps, for
# Linux and macOS (cron or launchd). Mirrors backup-store.ps1; its header
# explains the order, the restore, and why a dump rather than a volume copy.
#
#   scripts/backup-store.sh             # dump, check, prune
#   scripts/backup-store.sh --dry-run   # print the command and the prune list
#
# Settings, environment first, then ~/.harness/machine.env, then the default:
#   OUT_DIR    $HOME/backups/harness-store (a host folder, never inside Docker's disk)
#   KEEP       14 dumps remain after a run, the new one included
#   CONTAINER  $HARNESS_STORE_CONTAINER, else harness-postgres
#   DATABASE   $HARNESS_STORE_DB, else harness
#   USER_NAME  harness (the Postgres role)
#
# Restore:  docker exec -i harness-postgres pg_restore -U harness -d harness --clean --if-exists < <file>
#
# Exit 0 dump written and checked; 1 dump good but pruning failed; 2 no backup.
# Never starts Docker or the container.

set -u

readonly EXIT_OK=0
readonly EXIT_PRUNE_FAILED=1
readonly EXIT_NO_BACKUP=2
# The first bytes of every pg_dump custom-format (-Fc) file.
readonly DUMP_MAGIC="PGDMP"
# Only files of exactly this form are ever pruned.
readonly DUMP_NAME_RE='^harness-[0-9]{8}-[0-9]{6}\.dump$'
# Names go on docker's command line; keep them to what Docker and Postgres use.
readonly SAFE_NAME_RE='^[A-Za-z0-9][A-Za-z0-9_.-]*$'

fail() {
  # fail <message> <fix>
  printf '%s\n  Fix: %s\n' "$1" "$2" >&2
  exit "$EXIT_NO_BACKUP"
}

dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit "$EXIT_OK" ;;
    *) fail "unknown argument: $arg" "Use --dry-run, or set OUT_DIR, KEEP, CONTAINER, DATABASE, USER_NAME." ;;
  esac
done

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

OUT_DIR="${OUT_DIR:-$HOME/backups/harness-store}"
KEEP="${KEEP:-14}"
CONTAINER="${CONTAINER:-${HARNESS_STORE_CONTAINER:-harness-postgres}}"
DATABASE="${DATABASE:-${HARNESS_STORE_DB:-harness}}"
USER_NAME="${USER_NAME:-harness}"

[[ "$KEEP" =~ ^[0-9]+$ ]] && [ "$KEEP" -ge 1 ] || fail "KEEP=$KEEP is not a whole number of 1 or more." "Set KEEP=14 (or any count >= 1)."
for pair in "CONTAINER=$CONTAINER" "DATABASE=$DATABASE" "USER_NAME=$USER_NAME"; do
  [[ "${pair#*=}" =~ $SAFE_NAME_RE ]] || fail "${pair%%=*}='${pair#*=}' has characters this script will not pass on." "Use letters, digits, '_', '.' and '-' only."
done

command -v docker >/dev/null 2>&1 || fail "docker was not found on PATH." "Install the docker CLI, or add it to PATH; cron and launchd do not read your shell profile."

running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>&1)"; inspect_code=$?
if [ "$inspect_code" -ne 0 ] || [ "$running" != "true" ]; then
  fail "container $CONTAINER is not running (docker inspect exit $inspect_code: $running)." "Start it yourself (cd db && docker compose up -d); this script never starts it."
fi

# Dumps this script may prune, newest first by mtime (ls -t: GNU and BSD alike),
# except the one named in $1. The names are fixed-form, so ls output is safe here.
old_dumps() {
  local skip="$1" name
  [ -d "$OUT_DIR" ] || return 0
  ( cd "$OUT_DIR" && ls -1t -- harness-*.dump 2>/dev/null ) | while IFS= read -r name; do
    [[ "$name" =~ $DUMP_NAME_RE ]] || continue
    [ "$name" = "$skip" ] && continue
    printf '%s\n' "$name"
  done
}

# The old dumps that go so that KEEP remain, counting the new one.
prune_list() {
  old_dumps "$1" | tail -n "+$KEEP"
}

name="harness-$(date +%Y%m%d-%H%M%S).dump"
dump="$OUT_DIR/$name"
partial="$dump.partial"

if [ "$dry_run" -eq 1 ]; then
  echo "dry run: would run: docker exec $CONTAINER pg_dump -U $USER_NAME -Fc $DATABASE > \"$partial\""
  echo "dry run: would check it and rename it to $dump"
  count=0
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    echo "dry run: would remove $OUT_DIR/$old"; count=$((count + 1))
  done < <(prune_list "")
  echo "dry run: would keep $KEEP, remove $count; nothing written"
  exit "$EXIT_OK"
fi

mkdir -p "$OUT_DIR" || fail "could not create $OUT_DIR." "Set OUT_DIR to a folder you can write."
[ -e "$dump" ] || [ -e "$partial" ] && fail "$dump already exists." "Wait a second and run again; a dump is never overwritten."

docker exec "$CONTAINER" pg_dump -U "$USER_NAME" -Fc "$DATABASE" > "$partial"; dump_code=$?
if [ "$dump_code" -ne 0 ]; then
  rm -f "$partial"
  fail "pg_dump failed (exit $dump_code); nothing was kept." "Check the message above; try: docker exec $CONTAINER pg_dump -U $USER_NAME -Fc $DATABASE --schema-only"
fi
if [ ! -s "$partial" ]; then
  rm -f "$partial"
  fail "pg_dump exited 0 but wrote nothing; the empty file was removed." "Check the container's logs: docker logs $CONTAINER"
fi
if [ "$(head -c 5 "$partial")" != "$DUMP_MAGIC" ]; then
  rm -f "$partial"
  fail "the dump does not start with $DUMP_MAGIC, so it is not a custom-format dump; it was removed." "Check that the container runs pg_dump, not something that prints to stdout first."
fi
mv -- "$partial" "$dump" || { rm -f "$partial"; fail "could not rename the dump to $dump." "Check permissions on $OUT_DIR."; }
size="$(wc -c < "$dump" | tr -d ' ')"

prune_failed=0
while IFS= read -r old; do
  [ -n "$old" ] || continue
  if rm -f -- "$OUT_DIR/$old"; then
    echo "removed $OUT_DIR/$old"
  else
    echo "could not remove $OUT_DIR/$old" >&2; prune_failed=1
  fi
done < <(prune_list "$name")

kept="$(old_dumps "" | wc -l | tr -d ' ')"
echo "backup: $dump ($size bytes), kept $kept"
[ "$prune_failed" -eq 0 ] || exit "$EXIT_PRUNE_FAILED"
exit "$EXIT_OK"
