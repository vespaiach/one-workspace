import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../../lib/auth/password'
import { authenticateAndCreateSession } from '../../lib/auth/login'
import { loginAction } from '../../app/login/actions'
import { InvalidCredentialsError, RateLimitError } from '../../lib/auth/errors'
import { __resetForTest } from '../../lib/auth/rate-limit'

const db = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } }
})

declare const __testCookies: { reset(): void; set(name: string, value: string): void }
declare const __testNav: { getLastRedirect(): string | null; resetRedirect(): void }

const WORKSPACE_ID = 'login-test-workspace'
const TEAM_ID = 'login-test-team'

const TEST_HEADERS = new Headers({ 'x-forwarded-for': '10.0.0.1' })

async function setupWorkspace() {
  await db.workspace.upsert({
    where: { id: WORKSPACE_ID },
    update: {},
    create: { id: WORKSPACE_ID, name: 'Login Test Workspace' }
  })
  await db.team.upsert({
    where: { id: TEAM_ID },
    update: { workspaceId: WORKSPACE_ID },
    create: { id: TEAM_ID, name: 'Login Test Team', workspaceId: WORKSPACE_ID }
  })
}

async function createUser(
  email: string,
  password: string,
  opts: {
    role?: 'ADMIN' | 'MEMBER'
    status?: 'ACTIVE' | 'SUSPENDED'
    deletedAt?: Date
    mustChangePassword?: boolean
  } = {}
) {
  const passwordHash = await hashPassword(password)
  const user = await db.user.create({
    data: {
      email,
      passwordHash,
      mustChangePassword: opts.mustChangePassword ?? false,
      deletedAt: opts.deletedAt
    }
  })
  await db.membership.create({
    data: {
      userId: user.id,
      teamId: TEAM_ID,
      role: opts.role ?? 'MEMBER',
      status: opts.status ?? 'ACTIVE'
    }
  })
  return user
}

before(async () => {
  await setupWorkspace()
})

beforeEach(async () => {
  __testCookies.reset()
  __testNav.resetRedirect()
  __resetForTest()
  await db.session.deleteMany({})
  await db.membership.deleteMany({})
  await db.user.deleteMany({})
  await setupWorkspace()
})

after(async () => {
  await db.session.deleteMany({})
  await db.membership.deleteMany({})
  await db.user.deleteMany({})
  await db.team.deleteMany({})
  await db.workspace.deleteMany({})
  await db.$disconnect()
})

describe('authenticateAndCreateSession', () => {
  it('succeeds with correct credentials and active membership', async () => {
    await createUser('user@example.com', 'correct-pw-123')
    const result = await authenticateAndCreateSession({
      email: 'user@example.com',
      password: 'correct-pw-123',
      headers: TEST_HEADERS
    })
    assert.equal(result.mustChangePassword, false)
  })

  it('returns mustChangePassword=true for bootstrap user', async () => {
    await createUser('admin@example.com', 'correct-pw-123', { mustChangePassword: true })
    const result = await authenticateAndCreateSession({
      email: 'admin@example.com',
      password: 'correct-pw-123',
      headers: TEST_HEADERS
    })
    assert.equal(result.mustChangePassword, true)
  })

  it('throws InvalidCredentialsError for wrong password', async () => {
    await createUser('user@example.com', 'correct-pw-123')
    await assert.rejects(
      () =>
        authenticateAndCreateSession({
          email: 'user@example.com',
          password: 'wrong-password',
          headers: TEST_HEADERS
        }),
      InvalidCredentialsError
    )
  })

  it('throws InvalidCredentialsError for unknown email', async () => {
    await assert.rejects(
      () =>
        authenticateAndCreateSession({
          email: 'nobody@example.com',
          password: 'some-password',
          headers: TEST_HEADERS
        }),
      InvalidCredentialsError
    )
  })

  it('throws InvalidCredentialsError for deleted user', async () => {
    await createUser('deleted@example.com', 'pw-123456', { deletedAt: new Date() })
    await assert.rejects(
      () =>
        authenticateAndCreateSession({
          email: 'deleted@example.com',
          password: 'pw-123456',
          headers: TEST_HEADERS
        }),
      InvalidCredentialsError
    )
  })

  it('throws InvalidCredentialsError for suspended user', async () => {
    await createUser('suspended@example.com', 'pw-123456', { status: 'SUSPENDED' })
    await assert.rejects(
      () =>
        authenticateAndCreateSession({
          email: 'suspended@example.com',
          password: 'pw-123456',
          headers: TEST_HEADERS
        }),
      InvalidCredentialsError
    )
  })

  it('throws InvalidCredentialsError for disallowed domain', async () => {
    const prev = process.env.ALLOWED_EMAIL_DOMAIN
    process.env.ALLOWED_EMAIL_DOMAIN = 'allowed.com'
    try {
      await createUser('user@other.com', 'pw-123456')
      await assert.rejects(
        () =>
          authenticateAndCreateSession({
            email: 'user@other.com',
            password: 'pw-123456',
            headers: TEST_HEADERS
          }),
        InvalidCredentialsError
      )
    } finally {
      if (prev === undefined) delete process.env.ALLOWED_EMAIL_DOMAIN
      else process.env.ALLOWED_EMAIL_DOMAIN = prev
    }
  })

  it('throws InvalidCredentialsError for malformed email input', async () => {
    await assert.rejects(
      () =>
        authenticateAndCreateSession({
          email: 'not-an-email',
          password: 'some-password',
          headers: TEST_HEADERS
        }),
      InvalidCredentialsError
    )
  })

  it('throws InvalidCredentialsError for non-string email', async () => {
    await assert.rejects(
      () =>
        authenticateAndCreateSession({
          email: 42,
          password: 'some-password',
          headers: TEST_HEADERS
        }),
      InvalidCredentialsError
    )
  })

  it('throws RateLimitError after 5 failed attempts from same IP', async () => {
    await createUser('target@example.com', 'real-password')
    for (let i = 0; i < 5; i++) {
      await authenticateAndCreateSession({
        email: 'target@example.com',
        password: 'wrong-pw',
        headers: TEST_HEADERS
      }).catch(() => {})
    }
    await assert.rejects(
      () =>
        authenticateAndCreateSession({
          email: 'target@example.com',
          password: 'wrong-pw',
          headers: TEST_HEADERS
        }),
      RateLimitError
    )
  })

  it('refunds reservation on successful login', async () => {
    await createUser('refund@example.com', 'correct-pw-123')
    // Burn 4 slots then succeed — bucket should not be blocked
    for (let i = 0; i < 4; i++) {
      await authenticateAndCreateSession({
        email: 'refund@example.com',
        password: 'wrong',
        headers: TEST_HEADERS
      }).catch(() => {})
    }
    // Successful login refunds
    await authenticateAndCreateSession({
      email: 'refund@example.com',
      password: 'correct-pw-123',
      headers: TEST_HEADERS
    })
    __testCookies.reset()
    // After refund, one more failed attempt is still allowed (not blocked)
    const err = await authenticateAndCreateSession({
      email: 'refund@example.com',
      password: 'wrong',
      headers: TEST_HEADERS
    }).catch((e: unknown) => e)
    assert.ok(err instanceof InvalidCredentialsError, 'should be credential error, not rate limit')
  })

  it('blocks distributed email attack across different IPs', async () => {
    await createUser('victim@example.com', 'pw-123456')
    for (let i = 0; i < 5; i++) {
      await authenticateAndCreateSession({
        email: 'victim@example.com',
        password: 'wrong',
        headers: new Headers({ 'x-forwarded-for': `10.0.1.${i + 1}` })
      }).catch(() => {})
    }
    await assert.rejects(
      () =>
        authenticateAndCreateSession({
          email: 'victim@example.com',
          password: 'wrong',
          headers: new Headers({ 'x-forwarded-for': '10.0.1.99' })
        }),
      RateLimitError
    )
  })
})

describe('loginAction (Server Action)', () => {
  it('returns error state for wrong password', async () => {
    await createUser('formuser@example.com', 'correct-pw-123')
    const fd = new FormData()
    fd.set('email', 'formuser@example.com')
    fd.set('password', 'wrong-pw')
    const state = await loginAction({ error: null }, fd)
    assert.equal(state.error, 'Invalid credentials')
  })

  it('redirects to / on successful login', async () => {
    await createUser('goodlogin@example.com', 'correct-pw-123')
    const fd = new FormData()
    fd.set('email', 'goodlogin@example.com')
    fd.set('password', 'correct-pw-123')
    await loginAction({ error: null }, fd).catch(() => {})
    assert.equal(__testNav.getLastRedirect(), '/')
  })

  it('redirects to /change-password when mustChangePassword', async () => {
    await createUser('newadmin@example.com', 'correct-pw-123', { mustChangePassword: true })
    const fd = new FormData()
    fd.set('email', 'newadmin@example.com')
    fd.set('password', 'correct-pw-123')
    await loginAction({ error: null }, fd).catch(() => {})
    assert.equal(__testNav.getLastRedirect(), '/change-password')
  })

  it('uses safe returnTo for redirect', async () => {
    await createUser('returnto@example.com', 'correct-pw-123')
    const fd = new FormData()
    fd.set('email', 'returnto@example.com')
    fd.set('password', 'correct-pw-123')
    fd.set('returnTo', '/dashboard')
    await loginAction({ error: null }, fd).catch(() => {})
    assert.equal(__testNav.getLastRedirect(), '/dashboard')
  })

  it('rejects unsafe returnTo and falls back to /', async () => {
    await createUser('unsafe@example.com', 'correct-pw-123')
    const fd = new FormData()
    fd.set('email', 'unsafe@example.com')
    fd.set('password', 'correct-pw-123')
    fd.set('returnTo', '//evil.com')
    await loginAction({ error: null }, fd).catch(() => {})
    assert.equal(__testNav.getLastRedirect(), '/')
  })

  it('rejects /login as returnTo', async () => {
    await createUser('noloop@example.com', 'correct-pw-123')
    const fd = new FormData()
    fd.set('email', 'noloop@example.com')
    fd.set('password', 'correct-pw-123')
    fd.set('returnTo', '/login')
    await loginAction({ error: null }, fd).catch(() => {})
    assert.equal(__testNav.getLastRedirect(), '/')
  })
})
