# Operations Runbook

## 1. Local startup

```bash
cp .env.example .env          # one-time; keep out of git
npm run db:up                 # start postgres on 127.0.0.1:5432
npm run db:migrate            # create/apply migrations
npm run db:seed               # bootstrap admin (reads .env)
npm run dev                   # start custom server on :3000
```

Clean reset (destroys all local data):

```bash
docker compose down -v
npm run db:up
npm run db:migrate
npm run db:seed
```

Full local Compose stack (db + web + traefik):

```bash
docker compose up --build --wait
curl http://localhost/health    # should return {"ok":true}
```

## 2. Production host env file and secret files

All files under `/etc/one-workspace/` must be owned by `root` with mode `0600`.

```
/etc/one-workspace/compose.env          # host env vars (POSTGRES_PASSWORD, DATABASE_URL, APP_HOST, …)
/etc/one-workspace/secrets/
  credentials_master_key               # exactly 64 hex chars (AES-256 key)
  smtp_password                        # SMTP account password
```

Set `CREDENTIALS_MASTER_KEY_FILE` and `SMTP_PASSWORD_FILE` in `compose.env` to the paths above.

The `CREDENTIALS_MASTER_KEY` file must be backed up **separately** from database dumps — a different location or medium. Losing it means permanent loss of all stored credentials.

## 3. First bootstrap vs. later deploys

First production start (creates admin):

```bash
# Create /etc/one-workspace/secrets/bootstrap_admin_password with the initial password.
export BOOTSTRAP_ADMIN_PASSWORD_FILE=/etc/one-workspace/secrets/bootstrap_admin_password

docker compose \
  --env-file /etc/one-workspace/compose.env \
  -f compose.yml -f compose.prod.yml -f compose.bootstrap.yml \
  up -d --build --wait

# Verify admin was created, then delete the bootstrap password file.
shred -u /etc/one-workspace/secrets/bootstrap_admin_password
```

Later deploys (no bootstrap secret needed):

```bash
docker compose \
  --env-file /etc/one-workspace/compose.env \
  -f compose.yml -f compose.prod.yml \
  up -d --build --wait
```

The seed checks for an existing active admin before reading credentials. Later restarts succeed without `BOOTSTRAP_ADMIN_PASSWORD`.

## 4. DNS, firewall, Traefik ACME, and certificate expiry

Prerequisites for production TLS:

- DNS A record for `APP_HOST` pointing to the server's public IP.
- Ports 80 and 443 open inbound.
- `TRAEFIK_ACME_EMAIL` set to a monitored address.
- `TRAEFIK_BIND_ADDRESS` set to the server's public IP.

Verify TLS after first deploy:

```bash
curl --fail --head "https://${APP_HOST}/health"
# HTTP should redirect permanently:
curl -o /dev/null -w '%{http_code}' "http://${APP_HOST}/health"   # expect 301
```

Certificate expiry check (add to weekly cron):

```bash
echo | openssl s_client -connect "${APP_HOST}:443" -servername "${APP_HOST}" 2>/dev/null \
  | openssl x509 -noout -enddate
```

Traefik renews automatically via ACME before expiry. If renewal fails, logs appear in:

```bash
docker compose -f compose.yml -f compose.prod.yml logs traefik | grep -i acme
```

## 5. Backup scheduling

Add to `/etc/cron.d/one-workspace-backup`:

```cron
0 2 * * * root BACKUP_SSH_KEY_FILE=/etc/one-workspace/secrets/backup_ssh_key \
  BACKUP_SSH_TARGET=backup-recv@backup-server:/backups/one-workspace \
  BACKUP_DIR=/var/backups/one-workspace \
  /opt/one-workspace/scripts/backup-db.sh >> /var/log/one-workspace-backup.log 2>&1
```

Or as a systemd timer — see `scripts/backup-db.sh` for all required env vars.

## 6. Dedicated restricted SSH key for off-box backups

On the backup target server, create a restricted user:

```bash
useradd --system --shell /bin/sh backup-recv
mkdir -p /home/backup-recv/.ssh
# Restrict the key to a single receive command in authorized_keys:
echo 'command="rsync --server -vlogDtpRre.iLsfxCIvu . /backups/one-workspace/",no-pty,no-agent-forwarding,no-port-forwarding ssh-ed25519 AAAA...' \
  >> /home/backup-recv/.ssh/authorized_keys
chmod 700 /home/backup-recv/.ssh
chmod 600 /home/backup-recv/.ssh/authorized_keys
```

On the app server, generate a dedicated key (never use a personal or root key):

```bash
ssh-keygen -t ed25519 -f /etc/one-workspace/secrets/backup_ssh_key -N ""
chmod 600 /etc/one-workspace/secrets/backup_ssh_key
```

## 7. Backup retention

`scripts/backup-db.sh` keeps:

- `BACKUP_RETENTION_DAILY` (default 7) most recent daily dumps.
- `BACKUP_RETENTION_WEEKLY` (default 4) most recent weekly dumps.

Weekly dumps are created on the day set by `BACKUP_WEEKLY_WEEKDAY` (default 0 = Sunday).

## 8. Credentials master key — separate backup

The `CREDENTIALS_MASTER_KEY` value must be stored in a separate location from DB dumps. Options:

- A hardware security module or password manager.
- An offline encrypted USB drive.
- A secrets service (e.g., Bitwarden, Vault) with different access controls than the DB backup destination.

Losing the master key means all stored credentials in the `Resource` table are permanently unrecoverable. Document this warning in the team's internal wiki.

## 9. Restore drill

Run after initial setup and after any major infrastructure change.

```bash
# 1. Run the backup script manually.
BACKUP_DIR=/tmp/restore-drill \
BACKUP_SSH_KEY_FILE=/etc/one-workspace/secrets/backup_ssh_key \
BACKUP_SSH_TARGET=backup-recv@backup-server:/backups/one-workspace \
./scripts/backup-db.sh

# 2. Verify the archive in isolation (no production change).
./scripts/restore-db.sh \
  --dump /tmp/restore-drill/daily-$(date -u +%Y-%m-%d).pgdump \
  --confirm-database one_workspace \
  --verify

# 3. Document result: date, workspace count, admin count.
```

Production replacement (downtime required):

```bash
./scripts/restore-db.sh \
  --dump /path/to/dump.pgdump \
  --confirm-database one_workspace \
  --replace-production
# After restore: docker compose start web
```

## 10. Health endpoint and log troubleshooting

Health check:

```bash
curl http://localhost/health          # local
curl https://${APP_HOST}/health       # production
# {"ok":true} = healthy; {"ok":false} = DB unreachable
```

App logs are JSON lines on stdout. Tail them:

```bash
docker compose logs -f web | jq .
```

Filter errors:

```bash
docker compose logs web | jq 'select(.level == "error")'
```

Traefik access logs:

```bash
docker compose logs traefik | jq 'select(.RouterName != null)'
```

## 11. Session management

### Expired-session cleanup

Expired sessions are deleted opportunistically on each new login (per user). For long-running deployments with many inactive users, run a periodic sweep:

```sql
-- Count expired rows before cleanup
SELECT COUNT(*) FROM sessions WHERE expires_at <= NOW();

-- Delete all expired sessions
DELETE FROM sessions WHERE expires_at <= NOW();
```

Or via Node (requires DATABASE_URL):

```bash
DATABASE_URL=... tsx -e "
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const { count } = await db.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
console.log('Deleted', count, 'expired sessions');
await db.\$disconnect();
"
```

Add to weekly cron or a scheduled job to keep the sessions table lean.

### Revoking all sessions for a specific user

Use when an account is compromised or an employee is offboarded:

```sql
-- Revoke all sessions for a specific user (replace with actual user ID)
DELETE FROM sessions WHERE user_id = '<user-id>';
```

Or set `deleted_at` on the user to prevent re-login even if a session somehow persists:

```sql
UPDATE users SET deleted_at = NOW() WHERE email = '<email>';
```

### Session table health check

```sql
-- Session counts by status
SELECT
  COUNT(*) FILTER (WHERE expires_at > NOW()) AS active,
  COUNT(*) FILTER (WHERE expires_at <= NOW()) AS expired,
  COUNT(*) AS total
FROM sessions;

-- Sessions per user (flag users with unusually many sessions)
SELECT user_id, COUNT(*) AS session_count
FROM sessions
WHERE expires_at > NOW()
GROUP BY user_id
ORDER BY session_count DESC
LIMIT 20;
```

Sessions expire after 7 days absolute lifetime. A user with many active sessions is not abnormal (multiple devices/browsers), but counts above ~20 may warrant investigation.
