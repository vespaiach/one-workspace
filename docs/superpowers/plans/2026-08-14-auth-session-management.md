# Auth & Session Management Implementation Plan

> **For implementation agents:** Execute tasks in order. Do not skip the migration-history gate, secure guards, direct-entry-point tests, or required PR workflow.

**Goal:** Implement first-party credential authentication with Argon2id, hashed opaque PostgreSQL sessions, defense-in-depth authorization, bounded dual-key throttling, and safe bootstrap-password rotation.

**Architecture:** The login Server Action is the only password-verification entry point. It calls server-only services that normalize input, reserve IP/email rate-limit capacity, verify one Argon2 hash, check user/membership/domain eligibility, create a seven-day database session, and set an HTTP-only raw-token cookie. PostgreSQL stores only SHA-256 token hashes. `proxy.ts` performs optimistic cookie-presence redirects; protected layouts, Server Actions, Route Handlers, data access, and Socket.IO call shared secure guards.

**Tech stack:** Next.js 16.3, React 19, Node.js 22 `crypto`, Argon2 0.45.1, Prisma 6.19.3, PostgreSQL, Node test runner through `tsx`, Playwright 1.62.1.

**Spec:** `docs/superpowers/specs/2026-08-14-auth-session-design.md`

## Global Constraints

- Never store or log a raw session token, password, token hash, cookie header, or raw email limiter key.
- Store only SHA-256 session-token hashes in PostgreSQL.
- All user emails are canonicalized through one shared function before lookup or write.
- Credential/policy failures return exactly `"Invalid credentials"`; infrastructure failures return `"Sign-in temporarily unavailable"` with a safe correlation ID in logs.
- Proxy is an optimistic navigation layer, not the authorization boundary.
- Every protected Server Action, Route Handler, DAL function, and Socket.IO entry point calls a server-only guard.
- Page requests redirect; API requests return JSON `401`/`403`.
- `ALLOWED_EMAIL_DOMAIN`, when set, applies to seed, invite, login, and existing-session eligibility.
- Password changes revoke all sessions and require a fresh login.
- TypeScript strict mode: no `any`, unchecked casts, or returning Prisma records to Client Components.
- React Aria `Button` uses `isDisabled`, not `disabled`.
- Follow `AGENTS.md`: work on a feature branch, commit atomically, push, and open a PR.

---

### Task 1: Migration-history gate and feature branch

**Files:**

- Inspect: `prisma/migrations/*/migration.sql`
- Inspect: every accessible shared database `_prisma_migrations` table
- Create/modify migration files only after determining applied history

- [ ] **Step 1: Create the implementation branch**

```bash
git switch -c feat/auth-session-management
```

- [ ] **Step 2: Reproduce the empty-database problem**

The repository contains two ordered init migrations that both create `MemberRole` and the full schema. Run `prisma migrate deploy` against a disposable empty PostgreSQL database and save the exact failure in the PR notes.

- [ ] **Step 3: Audit shared migration history**

For each non-disposable database, run a read-only query:

```sql
SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations
ORDER BY started_at;
```

If shared database access is unavailable, stop migration-history edits and request the result. Do not delete or rewrite a possibly applied migration.

- [ ] **Step 4: Repair safely**

Choose exactly one path:

- **No shared migration applied:** replace the duplicate history with one canonical snake-case init migration.
- **Shared history exists:** preserve applied files/checksums and add a reviewed reconciliation/baseline path that produces the current schema without replaying duplicate creates.

- [ ] **Step 5: Prove the repaired baseline**

Against a new empty PostgreSQL database:

```bash
npx --no-install prisma migrate deploy
BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
BOOTSTRAP_ADMIN_PASSWORD='temporary-test-password' \
npm run db:seed
```

Expected: migrations and seed complete once; a second seed is a no-op.

- [ ] **Step 6: Commit the baseline repair separately**

```bash
git add prisma/migrations
git commit -m "fix: repair initial migration history"
```

---

### Task 2: Session schema and canonical-email constraint

**Files:**

- Modify: `prisma/schema.prisma`
- Create: next Prisma migration
- Inspect: `.env.example`, `compose.yml`, `compose.prod.yml`, `docker/entrypoint.sh`, `docs/runbooks/operations.md`
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Define the Session model**

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

- [ ] **Step 2: Add the database email invariant**

Generate a migration, then add a reviewed PostgreSQL check constraint:

```sql
ALTER TABLE "users"
ADD CONSTRAINT "users_email_canonical"
CHECK ("email" = lower(btrim("email")));
```

Before applying the constraint to existing data, query for whitespace/case collisions and stop if canonicalization would merge two users.

- [ ] **Step 3: Add explicit dependencies and test scripts**

```bash
npm install --save-exact server-only@0.0.1
npm install --save-dev --save-exact @playwright/test@1.62.1
```

Add scripts:

```json
{
  "test": "tsx --test tests/**/*.test.ts",
  "test:browser": "playwright test",
  "verify": "npm run lint && npm run typecheck && npm test && npm run build"
}
```

- [ ] **Step 4: Validate and commit**

```bash
npx --no-install prisma format
npx --no-install prisma validate
sh -n docker/entrypoint.sh
docker compose config >/dev/null
git diff --check
git add prisma package.json package-lock.json
git commit -m "feat: prepare first-party session storage"
```

---

### Task 3: Shared authentication primitives

**Files:**

- Create: `lib/auth/constants.ts`
- Create: `lib/auth/errors.ts`
- Create: `lib/auth/email.ts`
- Create: `lib/auth/password.ts`
- Create: `lib/auth/client-ip.ts`
- Modify: `prisma/seed.ts`
- Create: corresponding unit tests under `tests/auth/`

- [ ] **Step 1: Define constants**

`constants.ts` exports:

```ts
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
export const SESSION_COOKIE_SECURE = '__Host-one-workspace-session'
export const SESSION_COOKIE_LOCAL = 'one-workspace-session'
export const LOGIN_WINDOW_MS = 15 * 60 * 1000
export const LOGIN_MAX_FAILURES = 5
export const LOGIN_LIMITER_MAX_KEYS = 10_000
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1
} as const
```

- [ ] **Step 2: Implement canonical email/domain parsing**

`normalizeEmail(value: unknown)` must:

- accept strings only;
- trim and lowercase;
- enforce maximum length 254;
- require exactly one usable `@` split;
- convert the domain with `url.domainToASCII` and reject an empty/invalid result; and
- return a typed result rather than throwing raw parser errors.

`isAllowedEmailDomain(email)` compares the parsed domain for exact equality. It must not use suffix-only matching.

- [ ] **Step 3: Implement password parsing and hashing**

Expose:

- `parsePassword(value: unknown)` with 8–128 character bounds;
- `hashPassword(password)` using `ARGON2_OPTIONS`;
- `verifyPassword(hash, password)`;
- `performDummyVerify(passwordCandidate)` using a committed hash with identical parameters; and
- `needsPasswordRehash(hash)`.

Malformed credentials still run the dummy verification before a public credential failure.

- [ ] **Step 4: Implement the Traefik IP contract**

`getTrustedClientIp(headers)` validates IP syntax and selects the rightmost `x-forwarded-for` entry because `web` is reachable only through the single Traefik hop. If the header is absent or malformed, use a stable `unknown` bucket rather than accepting arbitrary text as a key.

- [ ] **Step 5: Update the seed**

The seed must use `normalizeEmail`, `isAllowedEmailDomain`, and `hashPassword`. A bootstrap email outside the configured domain fails before any transaction. Do not duplicate Argon2 options.

- [ ] **Step 6: Unit-test and commit**

Cover mixed case, surrounding whitespace, Unicode/invalid domains, exact domain comparison, non-string values, password limits, IP chains, spoofed malformed headers, and seed-domain rejection.

```bash
npm test -- --test-name-pattern="email|password|client IP"
git add lib/auth prisma/seed.ts tests/auth
git commit -m "feat: add authentication primitives"
```

---

### Task 4: Bounded dual-bucket login limiter

**Files:**

- Create: `lib/auth/rate-limit.ts`
- Create: `tests/auth/rate-limit.test.ts`

- [ ] **Step 1: Implement reservation/refund semantics**

Expose a small interface:

```ts
type LoginReservation = {
  allowed: boolean
  refund(): void
}

export function reserveLoginAttempt(input: { ip: string; normalizedEmail: string }): LoginReservation
```

Requirements:

- derive independent namespaced IP and SHA-256 email keys;
- synchronously reserve both buckets before Argon2 work;
- roll back the first reservation if the second bucket rejects;
- refund both only after successful session/cookie creation;
- prune timestamps older than 15 minutes;
- delete empty keys;
- cap the map at 10,000 keys;
- evict expired keys before rejecting new capacity;
- return fail-closed (deny the request) when the map remains at capacity after eviction; and
- use an `unref()` cleanup timer with a test reset hook unavailable to production imports.

- [ ] **Step 2: Test real abuse paths**

Tests must cover:

- sixth failed attempt by IP;
- sixth failed attempt by email across different IPs;
- successful-login refund;
- simultaneous reservations;
- TTL expiry;
- bounded memory under unique keys;
- fail-closed when the map is at capacity and eviction yields no free slot; and
- one office IP attacking many accounts versus many IPs attacking one account.

- [ ] **Step 3: Commit**

```bash
npm test -- --test-name-pattern="rate limit"
git add lib/auth/rate-limit.ts tests/auth/rate-limit.test.ts
git commit -m "feat: add bounded login throttling"
```

---

### Task 5: Opaque session service and secure guards

**Files:**

- Create: `lib/auth/session.ts`
- Create: `lib/auth/authorization.ts`
- Create: `tests/auth/session.test.ts`
- Create: `tests/auth/authorization.test.ts`

- [ ] **Step 1: Implement token and cookie helpers**

```ts
function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}
```

Keep `hashSessionToken` server-only. Never return token hashes to the client.

Cookie options must match the spec exactly. Production is determined from the validated `APP_URL` protocol, not solely from `NODE_ENV`; production refuses non-HTTPS `APP_URL`.

- [ ] **Step 2: Implement session lifecycle**

Expose:

- `createSession(userId)` — delete expired rows opportunistically, create the hash row, return raw token plus expiry;
- `readSessionCookie()` — accept only expected cookie names and plausible base64url length;
- `deleteCurrentSession()` — hash and delete one row, then clear both cookie variants;
- `deleteAllUserSessions(userId, tx?)`; and
- `deleteExpiredSessions()` for operations/tests.

Session-row creation and cookie issuance must be ordered so failure cannot report login success without both pieces. If cookie mutation fails, delete the newly created row before returning an availability error.

- [ ] **Step 3: Implement secure guards**

`getSessionPrincipal()` performs a joined query and validates:

- session exists and `expiresAt > now`;
- user `deletedAt` is null;
- one membership is `ACTIVE`;
- email remains domain-eligible; and
- returned DTO contains only the approved principal fields.

`requireActiveMember()` and `requireAdmin()` wrap the principal result in typed page/API policies. They do not rely on Proxy.

- [ ] **Step 4: Integration-test against PostgreSQL**

Prove the raw token differs from `tokenHash`, raw values never appear in queried rows/log capture, expired sessions fail, suspension/deletion/domain changes revoke access, current-session deletion is scoped, and revoke-all deletes every session.

- [ ] **Step 5: Commit**

```bash
npm test -- --test-name-pattern="session|authorization"
git add lib/auth tests/auth
git commit -m "feat: add opaque sessions and auth guards"
```

---

### Task 6: Authoritative login service and UI

**Files:**

- Create: `lib/auth/login.ts`
- Create: `app/login/actions.ts`
- Create: `app/login/page.tsx`
- Create: `app/login/login-form.tsx`
- Create: `tests/auth/login.test.ts`

- [ ] **Step 1: Implement the only password-verification service**

`authenticateAndCreateSession({ email, password, headers })` follows the spec sequence:

1. Parse email/password and derive the trusted IP.
2. Use a stable invalid-email limiter key when normalization fails.
3. Reserve both limiter buckets.
4. Query canonical user plus membership.
5. Verify exactly one real or dummy Argon2 hash.
6. Require correct password, non-deleted user, active membership, and allowed domain.
7. Create the opaque session and set its cookie.
8. Refund only on complete success.

Do not export password-verification helpers from a client-reachable module. There is no `/api/auth` handler.

- [ ] **Step 2: Implement typed failure handling**

The action maps only expected credential/policy/throttle errors to `"Invalid credentials"`. Database, Argon2, cookie, and programming errors are logged through `lib/logger.ts` with a correlation ID and return `"Sign-in temporarily unavailable"`.

- [ ] **Step 3: Validate safe return destinations**

Accept only relative paths beginning with one `/`. Reject protocol-relative paths, absolute URLs, `/login`, and `/change-password`. Default to `/`.

- [ ] **Step 4: Implement page and form**

The Server Component redirects an already-authenticated principal. The Client Component uses `useActionState`, accessible labels, `autoComplete`, pending state, and client constraints without treating them as security validation.

- [ ] **Step 5: Test bypasses and commit**

Tests must invoke the Server Action transport directly, not only submit the rendered form. Verify malformed input, unknown user, wrong password, suspended/deleted/domain-ineligible user, distributed email attacks, successful reservation refund, safe redirects, and infrastructure failures.

```bash
npm test -- --test-name-pattern="login"
git add lib/auth/login.ts app/login tests/auth/login.test.ts
git commit -m "feat: add first-party credential login"
```

---

### Task 7: Proxy, protected layout, and API behavior

**Files:**

- Create: `proxy.ts`
- Create or modify: protected route-group layout under `app/`
- Create: authorization test fixtures/Route Handlers used only in test builds if needed
- Create: `tests/auth/proxy.test.ts`

- [ ] **Step 1: Add a broad, static-only matcher exclusion**

Use a matcher that excludes Next internals and public files by explicit extension policy. Do not put `login`, `health`, or `api/auth` in a prefix-based negative lookahead.

Within `proxy()` use exact public-path checks:

```ts
const isPublic = pathname === '/login' || pathname === '/health'
```

For other page requests, redirect only when neither supported cookie name contains a plausible token. Proxy performs no Prisma query.

- [ ] **Step 2: Enforce secure page authorization in a layout**

The protected Server Component layout calls `requireActiveMember()`. It redirects forced-password users to `/change-password` and prevents non-forced users from remaining there. Each mutation still rechecks its own guard.

- [ ] **Step 3: Define API helpers**

Create helpers that translate typed unauthorized/forbidden errors to JSON `401`/`403`. No protected Route Handler may inherit page-redirect behavior.

- [ ] **Step 4: Test matcher boundaries**

At minimum assert:

- public: `/login`, `/health`, required login assets;
- protected: `/`, `/login-help`, `/health-records`, `/api/authorization`, `/api/projects`;
- framework exclusions: `/_next/static/*`, `/_next/image/*`; and
- Server Actions still call guards when the containing page passed Proxy.

- [ ] **Step 5: Commit**

```bash
npm test -- --test-name-pattern="proxy|API authorization"
git add proxy.ts app tests/auth/proxy.test.ts
git commit -m "feat: enforce defense-in-depth authorization"
```

---

### Task 8: Forced password change and logout

**Files:**

- Create: `app/change-password/actions.ts`
- Create: `app/change-password/page.tsx`
- Create: `app/change-password/change-password-form.tsx`
- Create: logout action/component in the authenticated shell
- Create: `tests/auth/password-change.test.ts`
- Create: `tests/auth/logout.test.ts`

- [ ] **Step 1: Implement compare-and-set password rotation**

The action calls `requireActiveMember({ allowPasswordChange: true })`, validates both password fields, hashes outside the transaction, then executes:

```ts
await db.$transaction(async (tx) => {
  const result = await tx.user.updateMany({
    where: {
      id: principal.userId,
      mustChangePassword: true,
      deletedAt: null
    },
    data: {
      passwordHash,
      mustChangePassword: false
    }
  })

  if (result.count !== 1) throw new StalePasswordChangeError()
  await tx.session.deleteMany({ where: { userId: principal.userId } })
})
```

Clear cookies after commit and redirect to `/login?passwordChanged=1`. Never preserve the current session.

- [ ] **Step 2: Implement idempotent logout**

Logout hashes/deletes the current session if present, clears both cookie names, and redirects to `/login`. Repeated calls succeed.

- [ ] **Step 3: Test concurrency and revocation**

Use two sessions established from the bootstrap password. Verify rotation deletes both, only one concurrent compare-and-set succeeds, the old password fails, and the new password creates a fresh session. Verify logout deletes only its current session.

- [ ] **Step 4: Commit**

```bash
npm test -- --test-name-pattern="password change|logout"
git add app/change-password app tests/auth
git commit -m "feat: add secure password rotation and logout"
```

---

### Task 9: Browser, Traefik, outage, and operations verification

**Files:**

- Create: `playwright.config.ts`
- Create: `tests/browser/auth.spec.ts`
- Modify: `docs/runbooks/operations.md`
- Optionally create: a safe expired-session cleanup command/script

- [ ] **Step 1: Add browser acceptance coverage**

Cover login, generic credential errors, forced password change, logout, safe return path, suspended user, deleted user, domain change, public assets, and exact look-alike route protection.

- [ ] **Step 2: Verify production cookie through Traefik**

Using the production Compose topology and a test HTTPS host, assert the cookie has:

- name `__Host-one-workspace-session`;
- `HttpOnly`;
- `Secure`;
- `SameSite=Lax`;
- `Path=/`;
- no `Domain`; and
- seven-day `Max-Age`.

Do not claim this passed if Docker/HTTPS is unavailable; keep it as a required deployment acceptance check.

- [ ] **Step 3: Verify outage behavior**

Stop PostgreSQL after loading the login page. Login must show temporary unavailability, logs must contain a correlation ID without credentials, and Proxy must not redirect-loop because it performs no database query.

- [ ] **Step 4: Add session cleanup operations**

Document a command that deletes only `expiresAt <= now` rows, its schedule, expected output, and rollback implications. Run it once in a test database.

- [ ] **Step 5: Commit**

```bash
npm run test:browser
git add playwright.config.ts tests/browser docs/runbooks/operations.md
git commit -m "test: cover authentication end to end"
```

---

### Task 10: Final verification, push, and pull request

- [ ] **Step 1: Run static and automated checks**

```bash
npx --no-install prisma validate
npm run lint
npm run typecheck
npm test
npm run build
git diff --check
```

- [ ] **Step 2: Run database acceptance from empty state**

```bash
npx --no-install prisma migrate deploy
npm run db:seed
npm test
```

- [ ] **Step 3: Inspect scope and secrets**

```bash
git status --short
git diff origin/main...HEAD --check
git grep -nE 'sessionToken|tokenHash|password' -- ':!package-lock.json'
```

Expected: no hardcoded secrets or raw-token logging.

- [ ] **Step 4: Push and open the required PR**

```bash
git push -u origin feat/auth-session-management
gh pr create \
  --title "feat: add first-party authentication and sessions (#2)" \
  --body-file <prepared-pr-body>
```

PR summary must state:

- first-party Argon2 login;
- raw 256-bit cookie token with SHA-256-only database storage;
- active-membership/deleted-user/domain checks at secure entry points;
- dual IP/email bounded throttling at the sole verification path;
- forced-password rotation revokes all sessions;
- Proxy is optimistic and secure guards are authoritative;
- migration-history repair and empty-database proof; and
- exact checks run, including any Docker/HTTPS check that remains unverified.

The PR closes Issue #2 only after every required automated and deployment acceptance check passes.
