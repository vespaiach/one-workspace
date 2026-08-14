import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../../lib/auth/password'
import { hashSessionToken, createSession } from '../../lib/auth/session'
import { getSessionPrincipal, requireActiveMember, requireAdmin } from '../../lib/auth/authorization'
import { SESSION_COOKIE_LOCAL } from '../../lib/auth/constants'
import { UnauthorizedError, ForbiddenError } from '../../lib/auth/errors'

const db = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } }
})

declare const __testCookies: { reset(): void; set(name: string, value: string): void }

const WORKSPACE_ID = 'auth-test-workspace'
const TEAM_ID = 'auth-test-team'

async function setupWorkspace() {
  await db.workspace.upsert({
    where: { id: WORKSPACE_ID },
    update: {},
    create: { id: WORKSPACE_ID, name: 'Auth Test Workspace' }
  })
  await db.team.upsert({
    where: { id: TEAM_ID },
    update: { workspaceId: WORKSPACE_ID },
    create: { id: TEAM_ID, name: 'Auth Test Team', workspaceId: WORKSPACE_ID }
  })
}

async function createUser(
  email: string,
  opts: {
    role?: 'ADMIN' | 'MEMBER'
    status?: 'ACTIVE' | 'SUSPENDED'
    deletedAt?: Date
    mustChangePassword?: boolean
  } = {}
) {
  const passwordHash = await hashPassword('TestPassword1!')
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

describe('getSessionPrincipal', () => {
  it('returns null when no cookie is present', async () => {
    assert.equal(await getSessionPrincipal(), null)
  })

  it('returns null for a malformed cookie value', async () => {
    __testCookies.set(SESSION_COOKIE_LOCAL, 'bad!')
    assert.equal(await getSessionPrincipal(), null)
  })

  it('returns a valid principal for an active session', async () => {
    const user = await createUser('active@example.com')
    const { rawToken } = await createSession(user.id)
    __testCookies.reset()
    __testCookies.set(SESSION_COOKIE_LOCAL, rawToken)

    const principal = await getSessionPrincipal()
    assert.ok(principal)
    assert.equal(principal.email, 'active@example.com')
    assert.equal(principal.role, 'MEMBER')
    assert.equal(principal.teamId, TEAM_ID)
  })

  it('returns null for an expired session', async () => {
    const user = await createUser('expired@example.com')
    const rawToken = 'expired-raw-token-placeholder12345678901'
    const tokenHash = hashSessionToken(rawToken)
    await db.session.create({
      data: { tokenHash, userId: user.id, expiresAt: new Date(Date.now() - 1000) }
    })
    __testCookies.set(SESSION_COOKIE_LOCAL, rawToken)

    assert.equal(await getSessionPrincipal(), null)
  })

  it('returns null for a soft-deleted user', async () => {
    const user = await createUser('deleted@example.com', { deletedAt: new Date() })
    const rawToken = 'deleted-user-raw-token-placeholder1234567'
    const tokenHash = hashSessionToken(rawToken)
    await db.session.create({
      data: { tokenHash, userId: user.id, expiresAt: new Date(Date.now() + 86400000) }
    })
    __testCookies.set(SESSION_COOKIE_LOCAL, rawToken)

    assert.equal(await getSessionPrincipal(), null)
  })

  it('returns null for a suspended membership', async () => {
    const user = await createUser('suspended@example.com', { status: 'SUSPENDED' })
    const { rawToken } = await createSession(user.id)
    __testCookies.reset()
    __testCookies.set(SESSION_COOKIE_LOCAL, rawToken)

    assert.equal(await getSessionPrincipal(), null)
  })

  it('returns null when ALLOWED_EMAIL_DOMAIN rejects the user domain', async () => {
    const prev = process.env.ALLOWED_EMAIL_DOMAIN
    process.env.ALLOWED_EMAIL_DOMAIN = 'allowed.com'
    try {
      const user = await createUser('user@other.com')
      const { rawToken } = await createSession(user.id)
      __testCookies.reset()
      __testCookies.set(SESSION_COOKIE_LOCAL, rawToken)
      assert.equal(await getSessionPrincipal(), null)
    } finally {
      if (prev === undefined) delete process.env.ALLOWED_EMAIL_DOMAIN
      else process.env.ALLOWED_EMAIL_DOMAIN = prev
    }
  })

  it('returned principal never includes tokenHash or raw token fields', async () => {
    const user = await createUser('safe@example.com')
    const { rawToken } = await createSession(user.id)
    __testCookies.reset()
    __testCookies.set(SESSION_COOKIE_LOCAL, rawToken)

    const principal = await getSessionPrincipal()
    assert.ok(principal)
    assert.ok(!('tokenHash' in principal))
    assert.ok(!('passwordHash' in principal))
  })
})

describe('requireActiveMember', () => {
  it('throws UnauthorizedError when no session', async () => {
    await assert.rejects(() => requireActiveMember(), UnauthorizedError)
  })

  it('throws ForbiddenError when mustChangePassword and allowPasswordChange not set', async () => {
    const user = await createUser('mustchange@example.com', { mustChangePassword: true })
    const { rawToken } = await createSession(user.id)
    __testCookies.reset()
    __testCookies.set(SESSION_COOKIE_LOCAL, rawToken)
    await assert.rejects(() => requireActiveMember(), ForbiddenError)
  })

  it('succeeds with allowPasswordChange when mustChangePassword is true', async () => {
    const user = await createUser('mustchange2@example.com', { mustChangePassword: true })
    const { rawToken } = await createSession(user.id)
    __testCookies.reset()
    __testCookies.set(SESSION_COOKIE_LOCAL, rawToken)
    const principal = await requireActiveMember({ allowPasswordChange: true })
    assert.equal(principal.mustChangePassword, true)
  })
})

describe('requireAdmin', () => {
  it('throws ForbiddenError for a MEMBER role', async () => {
    const user = await createUser('member@example.com', { role: 'MEMBER' })
    const { rawToken } = await createSession(user.id)
    __testCookies.reset()
    __testCookies.set(SESSION_COOKIE_LOCAL, rawToken)
    await assert.rejects(() => requireAdmin(), ForbiddenError)
  })

  it('succeeds for an ADMIN role', async () => {
    const user = await createUser('admin@example.com', { role: 'ADMIN' })
    const { rawToken } = await createSession(user.id)
    __testCookies.reset()
    __testCookies.set(SESSION_COOKIE_LOCAL, rawToken)
    const principal = await requireAdmin()
    assert.equal(principal.role, 'ADMIN')
  })
})
