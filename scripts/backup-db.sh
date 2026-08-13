#!/bin/sh
set -eu
umask 077

BACKUP_DIR="${BACKUP_DIR:-/backups/one-workspace}"
RETENTION_DAILY="${BACKUP_RETENTION_DAILY:-7}"
RETENTION_WEEKLY="${BACKUP_RETENTION_WEEKLY:-4}"
WEEKDAY="${BACKUP_WEEKLY_WEEKDAY:-0}"

LOCK_FILE="/tmp/backup-db.lock"
DATE="$(date -u +%Y-%m-%d)"
WEEKDAY_NOW="$(date -u +%w)"

log() {
  printf '{"level":"%s","message":"%s","timestamp":"%s"}\n' \
    "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

die() {
  log error "$1"
  exit 1
}

# Exclusive lock to prevent concurrent runs.
exec 9>"$LOCK_FILE"
flock -n 9 || die "Another backup is already running"

[ -d "$BACKUP_DIR" ] || mkdir -p "$BACKUP_DIR"
[ -n "${BACKUP_SSH_KEY_FILE:-}" ] || die "BACKUP_SSH_KEY_FILE must be set"
[ -r "$BACKUP_SSH_KEY_FILE" ] || die "BACKUP_SSH_KEY_FILE is not readable: $BACKUP_SSH_KEY_FILE"
[ -n "${BACKUP_SSH_TARGET:-}" ] || die "BACKUP_SSH_TARGET must be set"

DAILY_FILE="$BACKUP_DIR/daily-$DATE.pgdump"
TMP_FILE="$DAILY_FILE.tmp"

log info "Starting database dump"
if ! docker compose exec -T db pg_dump \
    -U postgres \
    --format=custom \
    one_workspace > "$TMP_FILE"; then
  rm -f "$TMP_FILE"
  die "pg_dump failed"
fi

log info "Validating dump archive"
if ! pg_restore --list "$TMP_FILE" > /dev/null 2>&1; then
  rm -f "$TMP_FILE"
  die "Dump validation failed: pg_restore --list returned non-zero"
fi

mv "$TMP_FILE" "$DAILY_FILE"
log info "Daily dump written"

# Weekly copy on the configured weekday.
if [ "$WEEKDAY_NOW" = "$WEEKDAY" ]; then
  WEEK="$(date -u +%Y-W%V)"
  WEEKLY_FILE="$BACKUP_DIR/weekly-$WEEK.pgdump"
  cp "$DAILY_FILE" "$WEEKLY_FILE"
  log info "Weekly copy written"
fi

# Retention: keep only the N most recent of each type.
ls -1t "$BACKUP_DIR"/daily-*.pgdump 2>/dev/null \
  | tail -n "+$((RETENTION_DAILY + 1))" \
  | xargs -r rm --
ls -1t "$BACKUP_DIR"/weekly-*.pgdump 2>/dev/null \
  | tail -n "+$((RETENTION_WEEKLY + 1))" \
  | xargs -r rm --

log info "Copying dump off-box"
if ! scp -i "$BACKUP_SSH_KEY_FILE" \
    -o StrictHostKeyChecking=yes \
    -o BatchMode=yes \
    "$DAILY_FILE" \
    "$BACKUP_SSH_TARGET/$(basename "$DAILY_FILE")"; then
  die "Off-box transfer failed"
fi

log info "Backup complete"
