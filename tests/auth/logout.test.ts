import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../../lib/auth/password'
import { createSession, hashSessionToken } from '../../lib/auth/session'
import { logoutAction } from '../../app/change-password/actions'
import { SESSION_COOKIE_LOCAL } from '../../lib/auth/constants'

const db = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } }
})

declare const __testCookies: {
  reset(): void
  set(name: string, value: string): void
  store: { get(name: string): { value: string } | undefined }
}
declare const __testNav: { getLastRedirect(): string | null; resetRedirect(): void }

const WORKSPACE_ID = 'logout-test-workspace'
const TEAM_ID = 'logout-test-team'

async function setupWorkspace() {
  await db.workspace.upsert({
    where: { id: WORKSPACE_ID },
    update: {},
    create: { id: WORKSPACE_ID, name: 'Logout Test Workspace' }
  })
  await db.team.upsert({
    where: { id: TEAM_ID },
    update: { workspaceId: WORKSPACE_ID },
    create: { id: TEAM_ID, name: 'Logout Test Team', workspaceId: WORKSPACE_ID }
  })
}

async function createUser(email: string) {
  const passwordHash = await hashPassword('TestPassword1!')
  const user = await db.user.create({ data: { email, passwordHash } })
  await db.membership.create({
    data: { userId: user.id, teamId: TEAM_ID, role: 'MEMBER', status: 'ACTIVE' }
  })
  return user
}

before(async () => {
  await setupWorkspace()
})

beforeEach(async () => {
  __testCookies.reset()
  __testNav.resetRedirect()
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

describe('logoutAction', () => {
  it('deletes the current session from DB and redirects to /login', async () => {
    const user = await createUser('logout@example.com')
    const { rawToken } = await createSession(user.id)
    __testCookies.reset()
    __testCookies.set(SESSION_COOKIE_LOCAL, rawToken)

    await logoutAction().catch(() => {})

    assert.equal(__testNav.getLastRedirect(), '/login')

    const session = await db.session.findUnique({ where: { tokenHash: hashSessionToken(rawToken) } })
    assert.equal(session, null)
  })

  it('clears the session cookie after logout', async () => {
    const user = await createUser('clearcookie@example.com')
    const { rawToken } = await createSession(user.id)
    __testCookies.reset()
    __testCookies.set(SESSION_COOKIE_LOCAL, rawToken)

    await logoutAction().catch(() => {})

    assert.equal(__testCookies.store.get(SESSION_COOKIE_LOCAL), undefined)
  })

  it('is idempotent — no error when no session cookie is present', async () => {
    // No cookie set
    await logoutAction().catch(() => {})

    assert.equal(__testNav.getLastRedirect(), '/login')
  })

  it('only deletes the current session, not other sessions for the same user', async () => {
    const user = await createUser('twosessions@example.com')

    // Create session A (the one we log out from)
    const { rawToken: tokenA } = await createSession(user.id)
    __testCookies.reset()

    // Create session B (a second active session)
    const { rawToken: tokenB } = await createSession(user.id)
    __testCookies.reset()

    // Log out from session A
    __testCookies.set(SESSION_COOKIE_LOCAL, tokenA)
    await logoutAction().catch(() => {})

    const sessionA = await db.session.findUnique({ where: { tokenHash: hashSessionToken(tokenA) } })
    const sessionB = await db.session.findUnique({ where: { tokenHash: hashSessionToken(tokenB) } })

    assert.equal(sessionA, null, 'session A should be deleted')
    assert.ok(sessionB !== null, 'session B should still exist')
  })

  it('does not delete another users session when logging out', async () => {
    const userA = await createUser('usera@example.com')
    const userB = await createUser('userb@example.com')

    const { rawToken: tokenA } = await createSession(userA.id)
    __testCookies.reset()

    const { rawToken: tokenB } = await createSession(userB.id)
    __testCookies.reset()

    // Log out as user A
    __testCookies.set(SESSION_COOKIE_LOCAL, tokenA)
    await logoutAction().catch(() => {})

    const sessionB = await db.session.findUnique({ where: { tokenHash: hashSessionToken(tokenB) } })
    assert.ok(sessionB !== null, 'user B session should not be affected by user A logout')
  })
})
