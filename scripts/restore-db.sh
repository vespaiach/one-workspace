#!/bin/sh
set -eu

DUMP_FILE=""
CONFIRM_DB=""
REPLACE_PRODUCTION=false
VERIFY_ONLY=false

log() {
  printf '{"level":"%s","message":"%s","timestamp":"%s"}\n' \
    "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

die() {
  log error "$1"
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage:
  restore-db.sh --dump <file> --confirm-database one_workspace [--verify]
  restore-db.sh --dump <file> --confirm-database one_workspace --replace-production

  --dump <file>               Path to the pg_dump custom-format archive.
  --confirm-database NAME     Must equal "one_workspace"; guards against wrong target.
  --verify                    Restore into a temporary DB, check counts, then drop it.
  --replace-production        Restore into the live one_workspace DB (requires --verify to pass first).
EOF
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dump) DUMP_FILE="$2"; shift 2 ;;
    --confirm-database) CONFIRM_DB="$2"; shift 2 ;;
    --verify) VERIFY_ONLY=true; shift ;;
    --replace-production) REPLACE_PRODUCTION=true; shift ;;
    *) usage ;;
  esac
done

[ -n "$DUMP_FILE" ] || usage
[ -n "$CONFIRM_DB" ] || usage
[ "$CONFIRM_DB" = "one_workspace" ] || die "Confirmation mismatch: got '$CONFIRM_DB', expected 'one_workspace'"
[ -r "$DUMP_FILE" ] || die "Dump file is not readable: $DUMP_FILE"

log info "Validating archive"
docker compose exec -T db pg_restore --list < "$DUMP_FILE" > /dev/null 2>&1 || die "Archive validation failed"

VERIFY_DB="one_workspace_restore_verify_$$"

log info "Restoring into verification database: $VERIFY_DB"
docker compose exec -T db psql -U postgres -c "CREATE DATABASE \"$VERIFY_DB\";" || die "Failed to create verification DB"

cleanup() {
  log info "Dropping verification database"
  docker compose exec -T db psql -U postgres \
    -c "DROP DATABASE IF EXISTS \"$VERIFY_DB\";" 2>/dev/null || true
}
trap cleanup EXIT

if ! docker compose exec -T db pg_restore \
    -U postgres \
    -d "$VERIFY_DB" \
    --no-owner \
    --no-privileges < "$DUMP_FILE"; then
  die "pg_restore into verification DB failed"
fi

log info "Checking row counts in verification database"
WORKSPACE_COUNT="$(docker compose exec -T db psql -U postgres -d "$VERIFY_DB" -At \
  -c 'SELECT COUNT(*) FROM "Workspace";')"
ADMIN_COUNT="$(docker compose exec -T db psql -U postgres -d "$VERIFY_DB" -At \
  -c "SELECT COUNT(*) FROM \"Membership\" WHERE role = 'ADMIN' AND status = 'ACTIVE';")"

[ "$WORKSPACE_COUNT" -ge 1 ] || die "Verification failed: no workspace rows"
[ "$ADMIN_COUNT" -ge 1 ] || die "Verification failed: no active admin"
log info "Verification passed"

if $VERIFY_ONLY; then
  log info "Verify-only mode: restore drill successful, production DB unchanged"
  exit 0
fi

if ! $REPLACE_PRODUCTION; then
  die "Pass --replace-production to overwrite the live database, or --verify for a drill"
fi

log info "Stopping web service before production restore"
docker compose stop web

log info "Creating pre-restore safety dump"
PRE_RESTORE="$(date -u +%Y-%m-%dT%H%M%SZ)-pre-restore.pgdump"
docker compose exec -T db pg_dump \
  -U postgres \
  --format=custom \
  one_workspace > "/tmp/$PRE_RESTORE" || die "Pre-restore safety dump failed"
log info "Safety dump written to /tmp/$PRE_RESTORE"

log info "Restoring into production database"
docker compose exec -T db psql -U postgres \
  -c 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '"'"'one_workspace'"'"' AND pid <> pg_backend_pid();'
docker compose exec -T db dropdb -U postgres one_workspace
docker compose exec -T db createdb -U postgres one_workspace
docker compose exec -T db pg_restore \
  -U postgres \
  -d one_workspace \
  --no-owner \
  --no-privileges < "$DUMP_FILE" || die "Production pg_restore failed"

log info "Production restore complete — restart web with: docker compose start web"
