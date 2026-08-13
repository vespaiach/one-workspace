# PRD — Simplified Linear Clone (Self-Hosted, Minimal-Cost)

**Status:** Final (v3) · **Date:** 2026-08-13 · **Owner:** Team (<20 people)
**Guiding principle:** Minimize build & maintenance cost. Every component must justify its operational weight.
**Process:** Produced via 3-pass design (draft → architect critique → revised). Critique findings referenced inline as `[C#/H#/M#]`.

---

## 1. Summary & Goals

A self-hosted, single-tenant work tracker for **one workspace, one team, fewer than 20 users**, running on **one server instance** with the smallest viable operational footprint. It provides team/member management, lightweight project management (specs, milestones, roadmap, credential resources), and a Trello-style issue board with live updates.

Using shadcn/ui primitives and a Linear-inspired, high-density dark mode layout to minimize design overhead.

**Non-goals (v3):** multi-workspace/multi-team, billing, mobile apps, third-party SSO/OAuth, file/image uploads, object storage, Redis/horizontal scaling, high availability.

**Success criteria**

- A member is invited by email, sets a password via the emailed link, signs in, and manages issues on a live board.
- Two users on the same board see card moves within ~1s (or after reconnect).
- Credentials are never stored or transmitted in plaintext; every reveal is audited.
- A full DB restore from an off-box backup is demonstrated during setup.
- Total running services: **three** (`web`, `db`, `nginx`).

---

## 2. Architecture

**Single server instance.** Three processes; Postgres is the only stateful store.

| Service | Role                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `web`   | Next.js 16 (App Router, TS, Tailwind) + **Socket.IO (in-memory adapter)**. UI, server actions, route handlers, realtime. |
| `db`    | PostgreSQL 16 (persistent volume). **Only** authoritative store.                                                         |
| `nginx` | Reverse proxy, TLS via **Let's Encrypt (certbot)**, HTTP→HTTPS, security headers, **WebSocket upgrade** `[C2]`.          |

No Redis. No object storage. No file uploads. **One external dependency added:** an SMTP endpoint for invite and password-reset emails (a transactional provider or the team's mail server).

**Data-flow principle:** Postgres is the source of truth; WebSocket events are hints to refetch/patch. On restart/deploy, sockets drop and **clients auto-reconnect + refetch** `[H2]`.

```
Browser ──HTTPS──> nginx (TLS, WS upgrade) ──> Next.js `web`
                                                  ├── Prisma ──> Postgres (authoritative)
                                                  └── Socket.IO (in-memory) ──> connected clients
```

### 2.1 nginx WebSocket config (mandatory) `[C2]`

The reverse-proxy location for the app **must** include:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_set_header Host $host;
proxy_read_timeout 3600s;
```

Without these, realtime silently degrades or fails.

---

## 3. Authentication, Authorization & Membership Lifecycle

### 3.1 Auth

- **Email + password** via the Auth.js Credentials provider. Passwords hashed with **Argon2id** (never stored or logged in plaintext).
- **Sessions: DB-backed** via the Auth.js Prisma adapter (no Redis) — HTTP-only, `Secure`, `SameSite=Lax` cookies.
- **Optional domain restriction:** config `ALLOWED_EMAIL_DOMAIN` limits which emails an admin may invite.

### 3.2 Invite & activation (email-driven)

1. Admin creates an `Invite` (email + role). A **single-use, expiring, hashed-at-rest token** is generated and a **sign-up link is emailed** to that address via SMTP. Rate-limited (in-memory `[H3]`).
2. The invitee opens the link (which proves email ownership) and sets their **name + password**.
3. On a valid, unexpired token → `User` is created (with `passwordHash`) and `Membership` created `ACTIVE`; the token is marked consumed. Expired/consumed/invalid tokens show a clear error and create nothing.

### 3.3 Password reset

- "Forgot password" issues a **single-use, expiring, hashed-at-rest** reset token emailed to the user; the link lets them set a new password.
- Rate-limited, and returns a **generic response whether or not the email exists** (no account enumeration `[S1]`). Setting a new password invalidates existing sessions.

### 3.4 Roles & authorization

- Roles: `ADMIN`, `MEMBER`. Member status: `ACTIVE`, `SUSPENDED`.
- **Every** request/action verifies an `ACTIVE` membership. Admin-only: invite, suspend/remove member, change roles, delete project, **reveal credential**.
- Socket connections authenticate against the session **before** joining any room; authz re-checked on join.

### 3.5 Deprovisioning & invariants

- Admin can suspend/remove a member → sessions invalidated, socket auth revoked.
- **Last-admin invariant:** blocks removing/demoting the final `ADMIN`.

---

## 4. Data Model (Prisma-level)

All rows carry `createdAt`, `updatedAt`; user-content entities carry nullable `deletedAt` (soft delete).

- **User** — id, email (unique), name, **passwordHash (Argon2id)**, avatarUrl.
- **Workspace** / **Team** — singletons (seeded).
- **Membership** — user↔team, `role`, `status`.
- **Invite** — email, role, **tokenHash**, expiresAt, consumedAt.
- **PasswordReset** — userId, **tokenHash**, expiresAt, consumedAt.
- **Project** — name, key, description, archivedAt.
- **Spec** — projectId, markdown body (Overview & Specs).
- **Milestone** — projectId, title, dueDate, status, `rank` (roadmap order).
- **Resource** — projectId, `type` = **`CREDENTIAL`** only (see §5). _(Optional `FIGMA` link — see Open Decisions.)_
- **Board** (projectId 1:1) / **Column** (boardId, name, `rank`).
- **Issue** — boardId, columnId, title, description(md), assigneeId, priority(enum), milestoneId?, `rank` (LexoRank), `deletedAt`.
- **Label** / **IssueLabel** — many-to-many.
- **Comment** — issueId, authorId, body.
- **AuditLog** — actorId, action, entityType, entityId, metadata(json), createdAt. **Mandatory** for credential reveals and member-lifecycle events.

### 4.1 Ordering

Columns, milestones, issues use a **lexicographic `rank` string** (LexoRank-style) so concurrent drags don't collide or renumber siblings. Issue mutations use a version/`updatedAt` check; conflict resolution is **consistent last-write-wins**.

---

## 5. Resources — Credentials Only

The **only** resource type is `CREDENTIAL` (no images, no file storage). Encrypted with Node.js built-in `crypto`.

- **Envelope encryption:** each secret encrypted with **AES-256-GCM** (`node:crypto`); store **ciphertext + IV + auth tag** only.
- **Master key** lives in a file/secret **outside the DB and outside the backup path** `[C1]`. Config: `CREDENTIALS_MASTER_KEY`.
- Decryption is **server-side only**, on **explicit reveal**, restricted to `ADMIN`, and **every reveal is written to `AuditLog`** (actor, secret id, timestamp).
- Secrets are **never** logged, never in error traces, never in the client bundle `[M5]`.
- **Key/backup separation `[C1]`:** the DB dump alone cannot decrypt secrets. The master key is backed up **separately** from DB dumps (different location/medium). Losing the key = permanent loss of stored secrets — documented in the runbook.

---

## 6. Real-Time

- **Socket.IO, in-memory adapter** (single instance — no Redis needed).
- Rooms scoped **per project**, joined only after authz.
- Live updates scoped to **board/issues only** for v2.
- Events: `issue:created|updated|moved|deleted`, `column:updated`.
- Client contract: patch/refetch on event; on disconnect, **auto-reconnect + full refetch** of the active board.
- Deploy/restart drops sockets; expected downtime a few seconds `[H2]`.

---

## 7. Security Controls

- **Transport:** TLS via nginx + Let's Encrypt; HSTS; HTTP→HTTPS redirect.
- **Headers:** strict `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`.
- **CSRF** on server actions; **in-memory rate limiting** on login/invite/password-reset/credential-reveal `[H3]`. Login uses constant-time password verification and generic error messages — no account enumeration `[S1]`.
- **Auth tokens** (invite, reset) are random, single-use, expiring, and **stored hashed at rest**; the raw token exists only in the emailed link.
- **AuthZ** on every request and socket join.
- **Secrets** per §5 `[C1, M5]`.
- **Audit log** for sensitive actions; **soft deletes** for recoverability.
- **Reduced attack surface:** no file uploads → no upload/XSS-via-file/storage-exhaustion class of risks.

---

## 8. Infrastructure & Operations

**Provisioning (single instance):** `web`, `db`, `nginx` (via systemd or a minimal Docker Compose), persistent volume for `db`, auto-restart on crash (`restart: unless-stopped` / systemd) `[H2]`.

**Startup:** entrypoint runs `prisma migrate deploy`, then a **seed** creating the singleton workspace/team + first admin from `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` (first-run only; the admin is required to change the password on first login).

**TLS `[M1]`:** certbot issues/renews the cert; automated `certbot renew` (cron/systemd-timer) + nginx reload. Runbook includes a renewal-health check (expiry silently kills the site in 90 days otherwise).

**Backups (DB only) `[C1, M2, M3]`:**

- `pg_dump` to a file on a **cron** schedule.
- Copy off-box via **`scp`/`rsync` over SSH** using a **dedicated, restricted SSH key** (own user, write-only/`command=`-restricted target — not root or a personal key) `[M3]`.
- Retention: 7 daily / 4 weekly.
- **Master encryption key backed up separately** from DB dumps `[C1]`.
- **One tested restore during setup**, with a documented runbook. (DB is the only state — no object store to snapshot.)

**Observability:** structured JSON logs, `/health` endpoint (**DB connectivity only** `[M4]`), external uptime monitor (operator-owned).

---

## 9. Environment Configuration

`DATABASE_URL`, `NEXTAUTH_SECRET`, `ALLOWED_EMAIL_DOMAIN` (optional), `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` (first-run only), `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `CREDENTIALS_MASTER_KEY` (file/secret, outside DB & backups), `APP_URL`, `BACKUP_SSH_TARGET`, `BACKUP_RETENTION`.

---

## 10. Out of Scope / Future

- Redis, horizontal scaling, high availability.
- File/image uploads, object storage.
- Multi-team / multi-workspace.
- Live sync for specs & roadmap.
- Notifications beyond in-app.

---

## 11. Open Decisions for Owner

1. **Figma links `[H1]`:** re-add a lightweight `FIGMA` resource (validated `figma.com` URL, no file storage — near-zero cost) to preserve the original "figma files" requirement? Currently **excluded** per "credentials only."
2. **Domain restriction:** set `ALLOWED_EMAIL_DOMAIN` to limit invitable emails, or allow any address?
3. **Off-box backup target & key location:** which host for DB dumps, and where the separately-held master key lives.
