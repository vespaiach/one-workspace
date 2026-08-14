# Auth & Session Management — Design Spec

**Date:** 2026-08-14
**Issue:** [#2 — Authentication & Session Management](https://github.com/vespaiach/one-workspace/issues/2)
**Status:** Approved

---

## 1. Overview

Implements the full authentication stack for One Workspace: credential-based login with Argon2id password hashing, DB-backed sessions via Auth.js v5 + Prisma adapter, route protection via Next.js 16 `proxy.ts`, in-memory rate limiting, and a forced-password-change flow for the bootstrap admin.

All route protection is centralized in `proxy.ts` (Node.js runtime, the Next.js 16 successor to `middleware.ts`). Every request passes through a single choke point that validates the DB session and ACTIVE membership before any page renders.

---

## 2. Dependencies

| Package                | Version              | Purpose                                       |
| ---------------------- | -------------------- | --------------------------------------------- |
| `next-auth`            | `@beta` (Auth.js v5) | Credentials provider, session management      |
| `@auth/prisma-adapter` | latest               | DB-backed sessions via existing Prisma schema |
| `argon2`               | already installed    | Password hashing and verification             |

No schema changes required — `User` and `Session` models already exist.

---

## 3. New Files

| File                                  | Purpose                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `auth.ts`                             | Auth.js v5 config — Credentials provider, Prisma adapter, exports `auth`, `signIn`, `signOut`, `handlers` |
| `proxy.ts`                            | Route protection — session check + ACTIVE membership + `mustChangePassword` redirect                      |
| `lib/rate-limit.ts`                   | In-memory sliding-window rate limiter                                                                     |
| `app/api/auth/[...nextauth]/route.ts` | Auth.js v5 route handler                                                                                  |
| `app/login/page.tsx`                  | Login form (email + password)                                                                             |
| `app/login/actions.ts`                | Server action — rate check → `signIn("credentials")` → redirect                                           |
| `app/change-password/page.tsx`        | Forced password change form                                                                               |
| `app/change-password/actions.ts`      | Server action — update hash, clear flag, redirect to `/`                                                  |

No existing files are modified.

---

## 4. Auth.js v5 Configuration (`auth.ts`)

```
export { auth, signIn, signOut, handlers } from configured NextAuth instance
```

- **Provider:** Credentials only (email + password). No OAuth/SSO.
- **Adapter:** `@auth/prisma-adapter` with the existing `db` client → sessions stored in the `sessions` table.
- **Session strategy:** `"database"` (explicit, adapter default).
- **Cookie:** Auth.js sets HTTP-only, `Secure`, `SameSite=Lax` automatically.
- **Secret:** `NEXTAUTH_SECRET` env var, used for signing.
- **Credentials provider logic:**
  1. Normalize email to lowercase.
  2. If `ALLOWED_EMAIL_DOMAIN` is set and the email domain doesn't match → run dummy Argon2id verify (constant-time) → return `null`.
  3. Look up user by email. If not found → run dummy Argon2id verify → return `null`.
  4. Run `argon2.verify(user.passwordHash, password)` (constant-time).
  5. If hash mismatch → return `null`.
  6. Return `{ id, email, name, mustChangePassword }`.
- All failure paths return `null` (identical timing, no enumeration).
- **TypeScript session extension:** `mustChangePassword` is not part of the default Auth.js session type. The `auth.ts` file must augment `next-auth` module types (`declare module "next-auth"`) to add `mustChangePassword: boolean` to the `User` and `Session` interfaces, and populate it via the `session` callback.
- **Dummy hash:** A hardcoded Argon2id hash is stored as a module-level constant in `auth.ts` for use in dummy verifications (when user not found). This ensures timing is indistinguishable from a real verify.

---

## 5. Route Handler (`app/api/auth/[...nextauth]/route.ts`)

```ts
import { handlers } from '@/auth'
export const { GET, POST } = handlers
```

Handles Auth.js internal routes: session callbacks, sign-out (deletes DB session row, clears cookie).

---

## 6. Rate Limiter (`lib/rate-limit.ts`)

- **Algorithm:** Sliding window.
- **Limit:** 5 attempts per 15-minute window per key.
- **Key:** Client IP address (from `x-forwarded-for` header, first entry).
- **Storage:** In-memory `Map<string, number[]>` (timestamps). Acceptable for single-instance, <20 users.
- **Interface:** `checkRateLimit(key: string): { allowed: boolean }`.
- Entries are pruned on each check (drop timestamps older than the window).

---

## 7. Login Flow (`app/login/`)

**`actions.ts` — server action `login(formData)`:**

1. Extract and normalize email (lowercase), extract password.
2. Get client IP from request headers.
3. `checkRateLimit(ip)` — if not allowed, return `{ error: "Invalid credentials" }` (same message, no rate-limit hint).
4. Call `await signIn("credentials", { email, password, redirectTo: "/" })` inside a try/catch:
   - Catch `AuthError` (from `next-auth`) → return `{ error: "Invalid credentials" }`.
   - Re-throw anything else (Auth.js v5 throws `NEXT_REDIRECT` on success, which Next.js must receive).
5. On success: Auth.js triggers `NEXT_REDIRECT` to `/`; the proxy intercepts the next request and redirects to `/change-password` if `mustChangePassword = true`. The login action does not need to check `mustChangePassword` itself.

**`page.tsx`:**

- Simple form: email input, password input, submit button.
- Displays error message from action state if present.
- Uses `useActionState` / React 19 form action pattern.
- No client-side validation (server is authoritative).

---

## 8. Proxy (`proxy.ts`)

Named export `proxy` (Next.js 16 convention).

**Skip list (matcher regex):** `_next/static`, `_next/image`, `favicon.ico`, `/health`, `/login`, `/api/auth/*`.

**For every other request:**

1. `const session = await auth()`.
2. If `!session` → `redirect("/login")`.
3. If `session.user.mustChangePassword && pathname !== "/change-password"` → `redirect("/change-password")`.
4. Query DB: `db.membership.findFirst({ where: { userId: session.user.id, status: "ACTIVE" } })`.
5. If no active membership → `redirect("/login")`.
6. `NextResponse.next()`.

Any exception from `auth()` or the DB query → redirect to `/login` (fail-safe).

---

## 9. Change-Password Flow (`app/change-password/`)

**`actions.ts` — server action `changePassword(formData)`:**

1. `const session = await auth()` — if no session, redirect to `/login`.
2. Extract and validate new password (min 8 chars).
3. Hash with `argon2.hash(newPassword, { type: argon2.argon2id })`.
4. `db.user.update({ where: { id: session.user.id }, data: { passwordHash, mustChangePassword: false } })`.
5. `redirect("/")` — current session remains valid.

**`page.tsx`:**

- Form: new password input, confirm password input, submit button.
- Client-side confirm-match check for UX; server action re-validates independently.

---

## 10. Security Controls

| Control                  | Implementation                                                                    |
| ------------------------ | --------------------------------------------------------------------------------- |
| No account enumeration   | Dummy Argon2id verify when user not found; all failures → `"Invalid credentials"` |
| Constant-time comparison | `argon2.verify()` is inherently constant-time                                     |
| Rate limiting            | Sliding window, 5/15 min per IP, in login server action                           |
| Generic error message    | Single message for wrong email, wrong password, domain mismatch, rate limit       |
| HTTP-only Secure cookie  | Auth.js Prisma adapter default                                                    |
| ACTIVE membership check  | Every request in `proxy.ts`                                                       |
| Change-password guard    | `auth()` re-called in server action before any DB write                           |
| `ALLOWED_EMAIL_DOMAIN`   | Enforced inside Credentials provider (not server action)                          |
| Fail-safe proxy          | Any `auth()` exception → redirect to `/login`                                     |

---

## 11. Environment Variables

| Variable               | Required | Description                                            |
| ---------------------- | -------- | ------------------------------------------------------ |
| `NEXTAUTH_SECRET`      | Yes      | Signs session tokens                                   |
| `ALLOWED_EMAIL_DOMAIN` | No       | If set, restricts which email domains can authenticate |
| `DATABASE_URL`         | Yes      | Already required                                       |

---

## 12. Manual Testing Checklist

- [ ] Unauthenticated request to `/` → redirected to `/login`
- [ ] Valid login → session cookie set, redirected to `/`
- [ ] Wrong password → "Invalid credentials", no session created
- [ ] Non-existent email → "Invalid credentials" (same timing as valid email)
- [ ] 6th login attempt in 15 min → rate limiter blocks (still "Invalid credentials")
- [ ] Bootstrap admin first login → redirected to `/change-password`
- [ ] After password change → `mustChangePassword = false`, lands on `/`
- [ ] Direct POST to `/change-password` without session → redirect to `/login`
- [ ] `ALLOWED_EMAIL_DOMAIN` set + wrong domain → "Invalid credentials"
- [ ] `/health` route → accessible without session
- [ ] Logout → session cookie cleared, DB session deleted, redirect to `/login`
- [ ] Suspended member → redirect to `/login` on next request
