#!/bin/sh
set -eu

log() {
  printf '{"level":"info","message":"%s","timestamp":"%s"}\n' \
    "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

load_secret() {
  name="$1"
  path="$2"
  [ -z "$path" ] && return 0
  [ -r "$path" ] || {
    printf '{"level":"error","message":"Required secret file is unreadable","secretName":"%s"}\n' "$name"
    exit 1
  }
  value="$(tr -d '\r\n' < "$path")"
  [ -n "$value" ] || {
    printf '{"level":"error","message":"Required secret file is empty","secretName":"%s"}\n' "$name"
    exit 1
  }
  export "$name=$value"
}

load_secret NEXTAUTH_SECRET "${NEXTAUTH_SECRET_FILE:-}"
load_secret CREDENTIALS_MASTER_KEY "${CREDENTIALS_MASTER_KEY_FILE:-}"
load_secret SMTP_PASSWORD "${SMTP_PASSWORD_FILE:-}"
load_secret BOOTSTRAP_ADMIN_PASSWORD "${BOOTSTRAP_ADMIN_PASSWORD_FILE:-}"

log 'Running migrations'
./node_modules/.bin/prisma migrate deploy

log 'Running bootstrap seed'
./node_modules/.bin/prisma db seed

log 'Starting Next.js'
exec ./node_modules/.bin/tsx server.ts
