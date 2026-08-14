# Auth & Session Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement credential-based authentication with Argon2id, DB-backed sessions via Auth.js v5 + Prisma adapter, centralized route protection via proxy.ts, in-memory rate limiting, and a forced-password-change flow for the bootstrap admin.

**Architecture:** Auth.js v5 (`next-auth@beta`) Credentials provider hashes passwords with Argon2id and stores sessions in the existing `sessions` DB table via `@auth/prisma-adapter`. All route protection is centralized in `proxy.ts` (Next.js 16's Node.js-runtime successor to `middleware.ts`), which validates the DB session, checks ACTIVE membership, and redirects to `/change-password` when `mustChangePassword = true`. An in-memory sliding-window rate limiter on the login server action caps attempts at 5 per 15 minutes per IP.

**Tech Stack:** next-auth@beta, @auth/prisma-adapter, argon2 (already installed), Prisma + PostgreSQL (already configured), React 19 `useActionState`, Next.js 16 proxy.ts (Node.js runtime)

**Spec:** `docs/superpowers/specs/2026-08-14-auth-session-design.md`

## Global Constraints

- `next-auth@beta` (Auth.js v5) — NOT v4; `signIn` throws `NEXT_REDIRECT` on success (must be re-thrown), throws `AuthError` on failure (must be caught and return generic message)
- `proxy.ts` at project root — named export `proxy`, NOT `middleware.ts` and NOT default export
- All login failure messages must be exactly `"Invalid credentials"` — no enumeration of email/password/domain/rate-limit specifics
- Session strategy: `"database"` — no JWTs
- `NEXTAUTH_SECRET` env var required; `ALLOWED_EMAIL_DOMAIN` env var optional
- TypeScript strict mode — no `any`, no unsafe property access
- UI: React Aria Components `Button` uses `isDisabled` prop (not `disabled`)
- `@/` alias maps to project root (e.g., `@/auth` resolves to `./auth.ts`)
- NEVER commit to `main` — all commits go on the feature branch created in Task 1

---

### Task 1: Create feature branch and install packages

**Files:**

- Modify: `package.json` (via npm install)
- Modify: `package-lock.json` (via npm install)

**Interfaces:**

- Produces: `next-auth` and `@auth/prisma-adapter` available as imports in subsequent tasks

- [ ] **Step 1: Create feature branch**

```bash
git checkout -b feat/auth-session-management
```

- [ ] **Step 2: Install packages**

```bash
npm install next-auth@beta @auth/prisma-adapter
```

Expected: packages install without errors.

- [ ] **Step 3: Generate dummy hash**

Run this command and **save the output** — you will paste it into `auth.ts` in Task 2:

```bash
node -e "const argon2 = require('argon2'); argon2.hash('timing-dummy-constant', { type: argon2.argon2id }).then(h => { console.log(h); process.exit(0) })"
```

The output looks like `$argon2id$v=19$m=65536,t=3,p=4$...`. Copy the whole line.

- [ ] **Step 4: Verify typecheck passes**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install next-auth@beta and @auth/prisma-adapter"
```

---

### Task 2: Auth.js v5 configuration (`auth.ts`)

**Files:**

- Create: `auth.ts` (project root)

**Interfaces:**

- Consumes: `@/lib/db` (`db: PrismaClient`), `argon2`, `NEXTAUTH_SECRET` env var, `ALLOWED_EMAIL_DOMAIN` env var (optional), DUMMY_HASH string from Task 1 Step 3
- Produces:
  - `auth(): Promise<Session | null>` — call with no args to get current session from request context
  - `signIn(provider: 'credentials', options: { email: string; password: string; redirectTo: string }): Promise<never>` — throws `NEXT_REDIRECT` on success, throws `AuthError` on failure
  - `signOut(): Promise<void>`
  - `handlers: { GET: Handler; POST: Handler }` — for the Next.js route handler
  - TypeScript: `Session["user"]["id"]: string` and `Session["user"]["mustChangePassword"]: boolean` available globally via module augmentation

- [ ] **Step 1: Create `auth.ts`**

Replace `<PASTE_DUMMY_HASH_HERE>` with the exact hash string from Task 1 Step 3.

```ts
import NextAuth, { type DefaultSession } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { PrismaAdapter } from '@auth/prisma-adapter'
import argon2 from 'argon2'
import { db } from '@/lib/db'

declare module 'next-auth' {
  interface User {
    mustChangePassword: boolean
  }
  interface Session {
    user: {
      id: string
      mustChangePassword: boolean
    } & DefaultSession['user']
  }
}

const DUMMY_HASH = '<PASTE_DUMMY_HASH_HERE>'

export const { auth, signIn, signOut, handlers } = NextAuth({
  adapter: PrismaAdapter(db),
  session: { strategy: 'database' },
  secret: process.env.NEXTAUTH_SECRET,
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' }
      },
      async authorize(credentials) {
        const email = ((credentials.email as string) ?? '').toLowerCase()
        const password = (credentials.password as string) ?? ''

        const allowedDomain = process.env.ALLOWED_EMAIL_DOMAIN
        if (allowedDomain && !email.endsWith(`@${allowedDomain}`)) {
          await argon2.verify(DUMMY_HASH, password)
          return null
        }

        const user = await db.user.findUnique({ where: { email } })
        if (!user) {
          await argon2.verify(DUMMY_HASH, password)
          return null
        }

        const valid = await argon2.verify(user.passwordHash, password)
        if (!valid) return null

        return {
          id: user.id,
          email: user.email,
          name: user.name ?? null,
          mustChangePassword: user.mustChangePassword
        }
      }
    })
  ],
  callbacks: {
    session({ session, user }) {
      session.user.id = user.id
      session.user.mustChangePassword = user.mustChangePassword
      return session
    }
  }
})
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add auth.ts
git commit -m "feat: add Auth.js v5 config with Credentials provider and Prisma adapter"
```

---

### Task 3: Rate limiter and Auth.js route handler

**Files:**

- Create: `lib/rate-limit.ts`
- Create: `app/api/auth/[...nextauth]/route.ts`

**Interfaces:**

- Produces:
  - `checkRateLimit(key: string): { allowed: boolean }` — 5 attempts per 15-minute sliding window per key; entries auto-prune on each call
  - `/api/auth/[...nextauth]` GET/POST — delegates session callbacks and sign-out to Auth.js internals

- [ ] **Step 1: Create `lib/rate-limit.ts`**

```ts
const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 5

const store = new Map<string, number[]>()

export function checkRateLimit(key: string): { allowed: boolean } {
  const now = Date.now()
  const cutoff = now - WINDOW_MS
  const timestamps = (store.get(key) ?? []).filter((t) => t > cutoff)
  timestamps.push(now)
  store.set(key, timestamps)
  return { allowed: timestamps.length <= MAX_ATTEMPTS }
}
```

- [ ] **Step 2: Create `app/api/auth/[...nextauth]/route.ts`**

```ts
import { handlers } from '@/auth'

export const { GET, POST } = handlers
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add lib/rate-limit.ts "app/api/auth/[...nextauth]/route.ts"
git commit -m "feat: add in-memory rate limiter and Auth.js route handler"
```

---

### Task 4: Login feature

**Files:**

- Create: `app/login/actions.ts`
- Create: `app/login/page.tsx`

**Interfaces:**

- Consumes:
  - `checkRateLimit(key: string): { allowed: boolean }` from `@/lib/rate-limit`
  - `signIn('credentials', { email, password, redirectTo })` from `@/auth` — throws `NEXT_REDIRECT` on success; throws `AuthError` on credential failure
  - `headers()` from `next/headers` — async function, returns `ReadonlyHeaders`
  - `AuthError` from `next-auth` — error class for credential failures
- Produces: `/login` route with a server-action-driven form; on success Auth.js sets session cookie and triggers redirect to `/`

- [ ] **Step 1: Create `app/login/actions.ts`**

```ts
'use server'

import { headers } from 'next/headers'
import { AuthError } from 'next-auth'
import { signIn } from '@/auth'
import { checkRateLimit } from '@/lib/rate-limit'

export type LoginState = { error: string } | undefined

export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const email = ((formData.get('email') as string | null) ?? '').toLowerCase()
  const password = (formData.get('password') as string | null) ?? ''

  const headersList = await headers()
  const forwarded = headersList.get('x-forwarded-for')
  const ip = forwarded ? forwarded.split(',')[0].trim() : 'unknown'

  const { allowed } = checkRateLimit(ip)
  if (!allowed) return { error: 'Invalid credentials' }

  try {
    await signIn('credentials', { email, password, redirectTo: '/' })
  } catch (error) {
    if (error instanceof AuthError) return { error: 'Invalid credentials' }
    throw error
  }
}
```

- [ ] **Step 2: Create `app/login/page.tsx`**

```tsx
'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { login } from './actions'

export default function LoginPage() {
  const [state, action, isPending] = useActionState(login, undefined)

  return (
    <div className='min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950'>
      <form
        action={action}
        className='flex flex-col gap-4 w-full max-w-sm p-8 bg-white dark:bg-zinc-900 rounded-lg shadow'>
        <h1 className='text-xl font-semibold'>Sign in</h1>
        {state?.error && (
          <p
            className='text-sm text-destructive'
            role='alert'>
            {state.error}
          </p>
        )}
        <div className='flex flex-col gap-1'>
          <label
            htmlFor='email'
            className='text-sm font-medium'>
            Email
          </label>
          <input
            id='email'
            name='email'
            type='email'
            required
            autoComplete='email'
            className='h-9 rounded-md border border-input bg-background px-3 text-sm'
          />
        </div>
        <div className='flex flex-col gap-1'>
          <label
            htmlFor='password'
            className='text-sm font-medium'>
            Password
          </label>
          <input
            id='password'
            name='password'
            type='password'
            required
            autoComplete='current-password'
            className='h-9 rounded-md border border-input bg-background px-3 text-sm'
          />
        </div>
        <Button
          type='submit'
          isDisabled={isPending}>
          {isPending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  )
}
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add app/login/actions.ts app/login/page.tsx
git commit -m "feat: add login page with server action and rate limiting"
```

---

### Task 5: Change-password feature

**Files:**

- Create: `app/change-password/actions.ts`
- Create: `app/change-password/page.tsx`

**Interfaces:**

- Consumes:
  - `auth(): Promise<Session | null>` from `@/auth` — reads current session from request context
  - `Session["user"]["id"]: string` — set by session callback in Task 2
  - `db.user.update(...)` from `@/lib/db`
  - `argon2.hash(password, { type: argon2.argon2id }): Promise<string>` from `argon2`
  - `redirect(path: string): never` from `next/navigation` — throws NEXT_REDIRECT; do NOT catch it
- Produces: `/change-password` route; on success clears `mustChangePassword` flag and redirects to `/`

- [ ] **Step 1: Create `app/change-password/actions.ts`**

```ts
'use server'

import { redirect } from 'next/navigation'
import argon2 from 'argon2'
import { auth } from '@/auth'
import { db } from '@/lib/db'

export type ChangePasswordState = { error: string } | undefined

export async function changePassword(
  _prevState: ChangePasswordState,
  formData: FormData
): Promise<ChangePasswordState> {
  const session = await auth()
  if (!session) redirect('/login')

  const newPassword = (formData.get('password') as string | null) ?? ''
  const confirmPassword = (formData.get('confirmPassword') as string | null) ?? ''

  if (newPassword.length < 8) return { error: 'Password must be at least 8 characters' }
  if (newPassword !== confirmPassword) return { error: 'Passwords do not match' }

  const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id })
  await db.user.update({
    where: { id: session.user.id },
    data: { passwordHash, mustChangePassword: false }
  })

  redirect('/')
}
```

- [ ] **Step 2: Create `app/change-password/page.tsx`**

```tsx
'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { changePassword } from './actions'

export default function ChangePasswordPage() {
  const [state, action, isPending] = useActionState(changePassword, undefined)

  return (
    <div className='min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950'>
      <form
        action={action}
        className='flex flex-col gap-4 w-full max-w-sm p-8 bg-white dark:bg-zinc-900 rounded-lg shadow'>
        <h1 className='text-xl font-semibold'>Set a new password</h1>
        <p className='text-sm text-zinc-500 dark:text-zinc-400'>
          You must change your password before continuing.
        </p>
        {state?.error && (
          <p
            className='text-sm text-destructive'
            role='alert'>
            {state.error}
          </p>
        )}
        <div className='flex flex-col gap-1'>
          <label
            htmlFor='password'
            className='text-sm font-medium'>
            New password
          </label>
          <input
            id='password'
            name='password'
            type='password'
            required
            minLength={8}
            autoComplete='new-password'
            className='h-9 rounded-md border border-input bg-background px-3 text-sm'
          />
        </div>
        <div className='flex flex-col gap-1'>
          <label
            htmlFor='confirmPassword'
            className='text-sm font-medium'>
            Confirm password
          </label>
          <input
            id='confirmPassword'
            name='confirmPassword'
            type='password'
            required
            minLength={8}
            autoComplete='new-password'
            className='h-9 rounded-md border border-input bg-background px-3 text-sm'
          />
        </div>
        <Button
          type='submit'
          isDisabled={isPending}>
          {isPending ? 'Saving…' : 'Set password'}
        </Button>
      </form>
    </div>
  )
}
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add app/change-password/actions.ts app/change-password/page.tsx
git commit -m "feat: add forced password-change page and server action"
```

---

### Task 6: Route protection proxy

**Files:**

- Create: `proxy.ts` (project root)

**Interfaces:**

- Consumes:
  - `auth(): Promise<Session | null>` from `@/auth` — reads session from request context; Node.js runtime allows Prisma calls inside auth()
  - `Session["user"]["id"]: string` and `Session["user"]["mustChangePassword"]: boolean`
  - `db.membership.findFirst({ where: { userId, status: 'ACTIVE' }, select: { id: true } })` from `@/lib/db`
  - `NextResponse` and `NextRequest` from `next/server`
- Produces: Next.js proxy that guards all routes not in the skip list; exported as named `proxy` function per Next.js 16 convention

**Matcher skip list** (proxy does NOT run for these paths):

- `_next/static/*` — static assets
- `_next/image/*` — image optimization
- `favicon.ico` — favicon
- `health` — health check endpoint
- `login` — login page (unauthenticated access required)
- `api/auth/*` — Auth.js internal routes (sign-in callback, sign-out, etc.)

- [ ] **Step 1: Create `proxy.ts`**

```ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { auth } from '@/auth'
import { db } from '@/lib/db'

export async function proxy(request: NextRequest) {
  try {
    const session = await auth()
    if (!session) {
      return NextResponse.redirect(new URL('/login', request.url))
    }

    const { pathname } = request.nextUrl
    if (session.user.mustChangePassword && pathname !== '/change-password') {
      return NextResponse.redirect(new URL('/change-password', request.url))
    }

    const membership = await db.membership.findFirst({
      where: { userId: session.user.id, status: 'ACTIVE' },
      select: { id: true }
    })
    if (!membership) {
      return NextResponse.redirect(new URL('/login', request.url))
    }

    return NextResponse.next()
  } catch {
    return NextResponse.redirect(new URL('/login', request.url))
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|health|login|api/auth).*)']
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Run lint**

```bash
npm run lint
```

Expected: zero errors.

- [ ] **Step 4: Run build**

```bash
npm run build
```

Expected: build completes with zero errors. Dynamic route warnings for `/login` and `/change-password` are acceptable — they're server-rendered by design.

- [ ] **Step 5: Commit**

```bash
git add proxy.ts
git commit -m "feat: add route protection proxy with session, membership, and mustChangePassword checks"
```

---

### Task 7: Push and open PR

- [ ] **Step 1: Push feature branch**

```bash
git push -u origin feat/auth-session-management
```

- [ ] **Step 2: Open PR**

```bash
gh pr create \
  --title "feat: authentication and session management (#2)" \
  --body "$(cat <<'EOF'
## Summary

- Adds Auth.js v5 credential-based login (Argon2id hashing, DB-backed sessions via Prisma adapter)
- Centralizes route protection in `proxy.ts` (Next.js 16 Node.js runtime): validates DB session, ACTIVE membership, and `mustChangePassword` flag on every non-public request
- In-memory sliding-window rate limiter — 5 attempts / 15 min per IP — on the login server action
- Forced password-change flow: proxy redirects to `/change-password` until the bootstrap admin clears the flag
- No account enumeration: dummy Argon2id verify when user not found; all failures return `"Invalid credentials"`
- Optional `ALLOWED_EMAIL_DOMAIN` env var; required `NEXTAUTH_SECRET` env var

## Test plan

- [ ] Unauthenticated request to `/` → redirected to `/login`
- [ ] Valid login → session cookie set, redirected to `/`
- [ ] Wrong password → "Invalid credentials", no session created
- [ ] Non-existent email → "Invalid credentials"
- [ ] 6th login attempt in 15 min → rate limiter blocks (still "Invalid credentials")
- [ ] Bootstrap admin first login → redirected to `/change-password`
- [ ] After password change → `mustChangePassword = false`, lands on `/`
- [ ] Direct access to `/change-password` without session → redirected to `/login`
- [ ] `ALLOWED_EMAIL_DOMAIN` set + wrong domain → "Invalid credentials"
- [ ] `/health` route accessible without session
- [ ] Logout → session cookie cleared, DB session deleted, redirected to `/login`
- [ ] Suspended member → redirected to `/login` on next request

Closes #2

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Manual Testing Setup

Before running through the test plan, ensure these env vars are set (`.env.local`):

```
DATABASE_URL=postgresql://...   # already configured
NEXTAUTH_SECRET=<random-32-char-string>
# ALLOWED_EMAIL_DOMAIN=example.com   # optional
```

Seed the database if not already done:

```bash
BOOTSTRAP_ADMIN_EMAIL=admin@example.com BOOTSTRAP_ADMIN_PASSWORD=bootstrap123 npm run db:seed
```

Start the dev server:

```bash
npm run dev
```

Then work through the test plan checklist in Task 7 manually.
