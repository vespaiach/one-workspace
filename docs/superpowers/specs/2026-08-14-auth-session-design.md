# Auth & Session Management — Design Spec

**Date:** 2026-08-14
**Issue:** [#2 — Authentication & Session Management](https://github.com/vespaiach/one-workspace/issues/2)
**Status:** Approved — revised after principal-engineer review

---

## 1. Overview

One Workspace uses a first-party authentication and session layer built with Next.js, Node.js `crypto`, Argon2id, Prisma, and PostgreSQL.

The design provides:

- credential login with canonical email handling and Argon2id verification;
- opaque, database-backed sessions whose raw bearer tokens never enter the database;
- authorization close to Server Actions, Route Handlers, data access, and Socket.IO handlers;
- an optimistic Next.js 16 `proxy.ts` redirect layer that is not a security boundary;
- bounded in-memory login throttling by both trusted client IP and normalized email;
- forced bootstrap-password rotation that revokes every existing session;
- immediate denial for suspended, soft-deleted, or domain-ineligible users; and
- automated unit, integration, matcher, and browser-level acceptance tests.

The deployment remains single-instance with no Redis or horizontal scaling.

---

## 2. Architecture Decisions

### 2.1 First-party authentication

Authentication is implemented in server-only modules. There is no catch-all `/api/auth/*` endpoint and no third-party authentication framework.

The authoritative login path is the `login` Server Action. It calls one server-only authentication service that performs input validation, throttling, user lookup, Argon2 verification, eligibility checks, session creation, and cookie issuance. No alternate endpoint may verify a password.

### 2.2 Opaque database sessions

On successful login:

1. Generate 32 cryptographically random bytes with `crypto.randomBytes(32)`.
2. Encode the raw value as base64url for the browser cookie.
3. Hash the raw value with SHA-256.
4. Store only the hexadecimal hash in PostgreSQL.
5. Send the raw value in an HTTP-only session cookie.

The raw token is a bearer credential and must never be logged or persisted server-side. A database leak does not disclose usable active session tokens because the database contains only one-way token hashes.

Sessions have a seven-day absolute lifetime. They are not extended on reads. Expired sessions are rejected, deleted opportunistically during login/session mutation, and removed by an operations cleanup command.

### 2.3 Defense in depth

`proxy.ts` only checks whether a session-cookie-shaped value is present and provides early page redirects. It does not prove identity, membership, role, password-change state, or domain eligibility.

Secure authorization is performed through shared server-only guards at every protected entry point:

- Server Actions;
- Route Handlers;
- data-access functions;
- protected Server Components/layouts; and
- Socket.IO connection and room-join handlers.

### 2.4 Domain policy

When `ALLOWED_EMAIL_DOMAIN` is set, it is an access policy rather than an invitation-only hint. The normalized domain is enforced during:

- bootstrap seeding;
- invitation creation and acceptance;
- login; and
- every secure session guard.

Changing the environment value therefore denies existing sessions belonging to users outside the new domain on their next secure request. Operators recover from a configuration mistake by correcting or unsetting the value and restarting the web service.

---

## 3. Dependencies

No authentication dependency is added. Existing packages provide the required primitives:

| Package/API       | Purpose                                                       |
| ----------------- | ------------------------------------------------------------- |
| `argon2` `0.45.1` | Password hashing and verification                             |
| `node:crypto`     | Random session tokens, SHA-256 token hashes, email-key hashes |
| Prisma `6.19.3`   | Session/user/membership transactions and queries              |
| Next.js `16.3.0`  | Server Actions, cookies, headers, Proxy                       |
| React `19.2.8`    | `useActionState` login and password forms                     |

---

## 4. Data Model and Migration Prerequisite

### 4.1 Session model

The `Session` model:

```prisma
model Session {
  id        String   @id @default(cuid())
  tokenHash String   @unique @map("token_hash")
  userId    String   @map("user_id")
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime @map("expires_at")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@index([userId])
  @@index([expiresAt])
  @@map("sessions")
}
```

The cookie contains the raw token. `tokenHash` contains `sha256(rawToken)` only.

### 4.2 Canonical email invariant

`User.email` remains unique and stores only the canonical form returned by `normalizeEmail`: trimmed, lowercase, maximum 254 characters, with a syntactically valid local part and normalized ASCII domain.

The migration adds a PostgreSQL check constraint equivalent to:

```sql
CHECK (email = lower(btrim(email)))
```

Every user-creation, invite, seed, login, and password-reset path must use the same normalizer.

### 4.3 Existing migration history must be repaired first

The repository currently contains two ordered init migrations that both create the same enums and schema. Before adding the session/email migration, implementation must determine which migrations exist in every shared database and select one safe repair:

- if no shared database has applied either migration, consolidate to one canonical init migration; or
- if a shared database has applied migration history, preserve it and create an additive reconciliation migration/baseline without editing an applied migration.

Acceptance requires `prisma migrate deploy` against an empty PostgreSQL database followed by a successful seed. The implementation must not guess that an existing migration can be deleted or rewritten safely.

---

## 5. Server-Only Modules

| File                        | Responsibility                                                          |
| --------------------------- | ----------------------------------------------------------------------- |
| `lib/auth/constants.ts`     | Cookie names, seven-day lifetime, Argon2 parameters                     |
| `lib/auth/email.ts`         | Canonical email and allowed-domain parsing                              |
| `lib/auth/password.ts`      | Password validation, hashing, dummy verification, rehash checks         |
| `lib/auth/session.ts`       | Token generation/hashing, cookie options, session CRUD                  |
| `lib/auth/authorization.ts` | `getSessionPrincipal`, `requireActiveMember`, `requireAdmin`            |
| `lib/auth/rate-limit.ts`    | Bounded dual-bucket reservation/refund limiter                          |
| `lib/auth/client-ip.ts`     | Traefik-aware client-IP extraction                                      |
| `lib/auth/login.ts`         | Single authoritative password-verification and session-creation service |
| `lib/auth/errors.ts`        | Typed expected auth errors; no secret-bearing messages                  |

Each module imports `server-only` where appropriate. Client Components receive minimal serializable DTOs, never Prisma records or token values.

---

## 6. Input and Password Handling

### 6.1 Login input

Login accepts only string `email` and `password` values. It rejects Files, arrays, objects, malformed email, email longer than 254 characters, and passwords outside 8–128 characters.

Malformed input still performs one dummy Argon2 verification before returning `"Invalid credentials"` so the fast validation path does not reveal account state.

### 6.2 Password hashing

All password creation paths, including the seed, use one exported Argon2id configuration:

```ts
{
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
}
```

These values must be benchmarked in the production container before release and adjusted if verification exceeds the operational latency budget. A committed dummy hash uses the same parameters. When parameters change, the dummy hash changes in the same commit and successful login may rehash stale user hashes.

The implementation mitigates timing-based enumeration; it does not claim perfect timing equality across database, network, and operating-system behavior.

---

## 7. Login Throttling

The limiter uses a 15-minute sliding window and permits five outstanding/failed attempts for each of these independent keys:

- trusted client IP; and
- SHA-256 of normalized email plus an application namespace.

Before Argon2 verification, the login service atomically reserves capacity in both buckets. A successful login refunds its reservations. Invalid credentials, malformed input, domain rejection, suspended/deleted users, and missing users consume them.

The store has:

- a maximum of 10,000 keys;
- TTL pruning on access plus a periodic unreferenced timer that does not keep the process alive;
- deterministic eviction of expired keys before rejecting new keys; and
- an explicit fail-closed response when capacity remains exhausted.

The web container is reachable only through Traefik. `client-ip.ts` treats the rightmost `x-forwarded-for` value as the direct client address for this one-proxy topology and rejects malformed values. A topology change involving a CDN or second proxy requires revisiting this contract.

Because password verification exists only in `lib/auth/login.ts`, there is no alternate callback endpoint that bypasses throttling.

---

## 8. Authentication and Session Creation

The authoritative login service performs this sequence:

1. Parse untrusted input without unsafe casts.
2. Normalize email and obtain the trusted client IP.
3. Reserve IP and email limiter capacity.
4. Query `User` by canonical email, including membership status and soft-delete state.
5. Select `user.passwordHash` or the dummy hash and perform exactly one Argon2 verification.
6. Reject with `InvalidCredentialsError` unless the password is valid, `deletedAt` is null, an `ACTIVE` membership exists, and the configured domain is eligible.
7. Opportunistically delete expired sessions.
8. Generate a raw token, store its hash and expiry in a transaction, and set the raw-token cookie.
9. Refund rate-limit reservations only after session creation and cookie issuance succeed.
10. Redirect to `/change-password` when required; otherwise redirect to `/`.

Expected credential/policy failures return exactly `"Invalid credentials"`. Infrastructure or data-corruption failures are logged with a generated error ID and return `"Sign-in temporarily unavailable"`; they are not mislabeled as bad credentials.

---

## 9. Session Cookie

| Property   | Production                     | Local HTTP              |
| ---------- | ------------------------------ | ----------------------- |
| Name       | `__Host-one-workspace-session` | `one-workspace-session` |
| `HttpOnly` | `true`                         | `true`                  |
| `Secure`   | `true`                         | `false`                 |
| `SameSite` | `Lax`                          | `Lax`                   |
| `Path`     | `/`                            | `/`                     |
| `Domain`   | omitted                        | omitted                 |
| `Max-Age`  | 604800 seconds                 | 604800 seconds          |

`__Host-` is used only when `Secure=true`. Cookie construction lives in one module and is covered by unit and HTTPS-through-Traefik integration tests.

No session secret is required.

---

## 10. Secure Authorization Guards

`getSessionPrincipal()` reads the raw cookie, hashes it, and performs one query that joins the session, non-deleted user, and membership. It rejects missing, malformed, expired, suspended, soft-deleted, or domain-ineligible sessions.

It returns a minimal principal:

```ts
type SessionPrincipal = {
  sessionId: string
  userId: string
  email: string
  name: string | null
  role: 'ADMIN' | 'MEMBER'
  teamId: string
  mustChangePassword: boolean
  expiresAt: Date
}
```

`requireActiveMember()` throws a typed unauthorized/forbidden error when validation fails. `requireAdmin()` builds on it. Protected data functions call these guards internally rather than relying on callers.

Page entry points redirect unauthenticated users to `/login?returnTo=<same-origin-path>`. Route Handlers return JSON `401` or `403`; they do not redirect API clients to HTML.

---

## 11. Next.js Proxy and Protected Layout

`proxy.ts` runs for application routes except framework/static assets. Its public-path policy uses exact checks:

- pathname equals `/login`;
- pathname equals `/health`; or
- framework/static assets excluded by the matcher.

There is no public `/api/auth/*` prefix. Look-alike routes such as `/login-help`, `/health-records`, and `/api/authorization` remain protected.

For protected page requests, Proxy checks only for a syntactically plausible session cookie and redirects obvious anonymous traffic to `/login`. A protected Server Component layout calls `requireActiveMember()` and enforces `mustChangePassword`. Every Server Action and data-access function rechecks independently.

Authenticated users visiting `/login` are redirected server-side to `/change-password` or `/` after a secure session check.

---

## 12. Login UI

`app/login/page.tsx` is a Server Component that checks for an existing valid session and renders a Client Component form only for anonymous users.

The form:

- uses React 19 `useActionState`;
- includes accessible email/password labels and autocomplete values;
- disables submission while pending;
- has lightweight client constraints for UX; and
- treats the Server Action as authoritative.

The action accepts an optional same-origin relative `returnTo` path. Unsafe, absolute, protocol-relative, login, or change-password destinations fall back to `/`.

---

## 13. Forced Password Change

The change-password page and action require an active, non-deleted, domain-eligible session. Password and confirmation are validated independently on the server.

The action hashes the password, then runs one transaction:

1. Compare-and-set `mustChangePassword` from `true` to `false` for the current user.
2. If no row changed, return a safe stale-submission response.
3. Delete every session for that user, including the current session.

After commit, clear the cookie and redirect to `/login?passwordChanged=1`. The user must authenticate with the new password. This prevents a second session established with the bootstrap password from surviving rotation.

The same revoke-all contract is reused by future password-reset and administrator deprovisioning flows.

---

## 14. Logout

Logout is a same-origin Server Action that does not require a valid principal. It hashes the current cookie token when present, deletes that session row, clears both production and development cookie names defensively, and redirects to `/login`.

It is idempotent: missing, expired, or already-deleted sessions still clear cookies and succeed.

---

## 15. Failure and Observability Policy

- Expected credential, domain, membership, and throttling failures use the same public login message.
- Unauthorized page access redirects; unauthorized API access returns JSON `401`/`403`.
- PostgreSQL, Argon2, and programming failures are logged as structured errors with a generated correlation ID and return an availability response.
- Proxy does not catch database failures because it performs no database query.
- Logs never include passwords, raw session tokens, token hashes, full cookies, or raw email rate-limit keys.
- Login success, logout, password change, session revocation, and rejected eligibility checks emit safe security events.

---

## 16. Environment and Deployment

Authentication uses:

| Variable                                   | Required          | Meaning                                                      |
| ------------------------------------------ | ----------------- | ------------------------------------------------------------ |
| `DATABASE_URL`                             | Yes               | PostgreSQL connection                                        |
| `ALLOWED_EMAIL_DOMAIN`                     | No                | Canonical domain enforced at seed/invite/login/session guard |
| `BOOTSTRAP_ADMIN_EMAIL`                    | First seed only   | Must satisfy the configured domain                           |
| `BOOTSTRAP_ADMIN_PASSWORD` or file variant | First seed only   | Initial password removed after bootstrap                     |
| `APP_URL`                                  | Yes in production | Canonical origin for safe redirects and links                |

`APP_URL` must be parsed and validated during startup. Production must use HTTPS. Traefik remains the only externally reachable path to the web service.

---

## 17. Automated Verification

Implementation is not complete with manual testing alone.

### Unit tests

- email/domain normalization and malformed inputs;
- password bounds and dummy-verification selection;
- token generation/hash determinism without exposing raw tokens;
- production and development cookie attributes;
- dual-bucket reserve/refund, expiry, eviction, and capacity handling;
- trusted IP parsing; and
- safe `returnTo` validation.

### PostgreSQL integration tests

- login stores only `tokenHash`, never the raw token;
- cookie resolves to the intended session and user;
- expired, suspended, deleted, and wrong-domain sessions are denied;
- logout deletes only the current session;
- password change compare-and-set handles concurrent submissions and revokes all sessions;
- fresh migration deploy plus seed succeeds; and
- session cleanup removes expired rows.

### Next.js integration/browser tests

- exact Proxy matching, including look-alike route names and public assets;
- direct Server Action invocation cannot bypass authorization or throttling;
- page redirects preserve only safe relative destinations;
- API routes return `401`/`403`, not HTML redirects;
- production-through-Traefik cookie has `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, and no `Domain`; and
- database outage produces an observable availability failure, not `"Invalid credentials"`.

---

## 18. Manual Acceptance Checklist

- [ ] Fresh PostgreSQL database migrates and seeds successfully
- [ ] Valid active user login creates one hashed-token session and redirects correctly
- [ ] Raw cookie token does not appear in the database or logs
- [ ] Wrong password, unknown email, wrong domain, suspended user, and deleted user show `"Invalid credentials"`
- [ ] Sixth failed attempt by either IP or email is blocked
- [ ] Direct action invocation follows the same limiter and guard path
- [ ] Bootstrap admin is forced to change password
- [ ] Password change revokes all sessions and requires login with the new password
- [ ] Concurrent password-change submissions have one deterministic winner
- [ ] Logout is idempotent and removes the current session
- [ ] Domain configuration changes deny now-ineligible existing sessions
- [ ] `/health` remains public; `/health-records` remains protected
- [ ] `/login` remains public; `/login-help` remains protected
- [ ] Public assets required by the login page load anonymously
- [ ] Unauthorized APIs return JSON `401`/`403`
- [ ] Database failure is logged and shown as temporary unavailability

---

## 19. Out of Scope

- OAuth, SSO, passkeys, and MFA;
- remember-me or sliding sessions;
- session/device management UI;
- Redis or distributed rate limiting;
- horizontal scaling; and
- invite/password-reset implementation beyond the shared contracts defined here.
