import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../../lib/auth/password'
import {
  generateSessionToken,
  hashSessionToken,
  createSession,
  deleteCurrentSession,
  deleteAllUserSessions,
  deleteExpiredSessions
} from '../../lib/auth/session'
import { SESSION_COOKIE_LOCAL } from '../../lib/auth/constants'

const db = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } }
})

declare const __testCookies: { reset(): void; set(name: string, value: string): void }

const WORKSPACE_ID = 'test-workspace'
const TEAM_ID = 'test-team'

async function setupWorkspace() {
  await db.workspace.upsert({
    where: { id: WORKSPACE_ID },
    update: {},
    create: { id: WORKSPACE_ID, name: 'Test Workspace' }
  })
  await db.team.upsert({
    where: { id: TEAM_ID },
    update: { workspaceId: WORKSPACE_ID },
    create: { id: TEAM_ID, name: 'Test Team', workspaceId: WORKSPACE_ID }
  })
}

async function createUser(email: string, opts: { mustChangePassword?: boolean } = {}) {
  const passwordHash = await hashPassword('TestPassword1!')
  const user = await db.user.create({
    data: { email, passwordHash, mustChangePassword: opts.mustChangePassword ?? false }
  })
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

describe('token generation and hashing', () => {
  it('raw token and tokenHash differ', () => {
    const raw = generateSessionToken()
    const hash = hashSessionToken(raw)
    assert.notEqual(raw, hash)
  })

  it('same raw token always produces the same hash', () => {
    const raw = generateSessionToken()
    assert.equal(hashSessionToken(raw), hashSessionToken(raw))
  })

  it('different raw tokens produce different hashes', () => {
    const h1 = hashSessionToken(generateSessionToken())
    const h2 = hashSessionToken(generateSessionToken())
    assert.notEqual(h1, h2)
  })
})

describe('createSession', () => {
  it('stores only tokenHash in the database, never the raw token', async () => {
    const user = await createUser('session-create@example.com')
    const { rawToken } = await createSession(user.id)
    const tokenHash = hashSessionToken(rawToken)

    const rows = await db.$queryRaw<{ token_hash: string }[]>`
      SELECT token_hash FROM sessions WHERE user_id = ${user.id}
    `
    assert.equal(rows.length, 1)
    assert.equal(rows[0].token_hash, tokenHash)
    // Raw token must not appear in any column
    const raw = await db.$queryRaw<{ token_hash: string }[]>`
      SELECT token_hash FROM sessions WHERE token_hash = ${rawToken}
    `
    assert.equal(raw.length, 0)
  })

  it('sets the session cookie with the raw token', async () => {
    const user = await createUser('cookie-set@example.com')
    const { rawToken } = await createSession(user.id)
    const cookieStore = __testCookies as unknown as {
      store: { get(n: string): { value: string } | undefined }
    }
    const cookie = cookieStore.store.get(SESSION_COOKIE_LOCAL)
    assert.ok(cookie)
    assert.equal(cookie.value, rawToken)
  })

  it('opportunistically deletes expired sessions on create', async () => {
    const user = await createUser('cleanup@example.com')
    // Insert an already-expired session directly
    const pastDate = new Date(Date.now() - 1000)
    await db.session.create({
      data: { tokenHash: hashSessionToken('expired-token'), userId: user.id, expiresAt: pastDate }
    })
    await createSession(user.id)
    const expired = await db.session.findFirst({
      where: { userId: user.id, expiresAt: { lte: new Date() } }
    })
    assert.equal(expired, null)
  })
})

describe('deleteCurrentSession', () => {
  it('deletes only the current session, not others', async () => {
    const user = await createUser('delete-current@example.com')
    const { rawToken: token1 } = await createSession(user.id)
    __testCookies.reset()
    await createSession(user.id) // second session

    // Set cookie back to first token
    __testCookies.set(SESSION_COOKIE_LOCAL, token1)
    await deleteCurrentSession()

    const remaining = await db.session.findMany({ where: { userId: user.id } })
    assert.equal(remaining.length, 1)
    // The remaining session must not be the one we deleted
    assert.notEqual(remaining[0].tokenHash, hashSessionToken(token1))
  })
})

describe('deleteAllUserSessions', () => {
  it('deletes every session for a user', async () => {
    const user = await createUser('revoke-all@example.com')
    await createSession(user.id)
    __testCookies.reset()
    await createSession(user.id)
    __testCookies.reset()
    await createSession(user.id)

    await deleteAllUserSessions(user.id)
    const remaining = await db.session.findMany({ where: { userId: user.id } })
    assert.equal(remaining.length, 0)
  })
})

describe('deleteExpiredSessions', () => {
  it('removes only expired rows', async () => {
    const user = await createUser('expired@example.com')
    // Create active session first, then insert expired rows directly so
    // createSession's opportunistic cleanup does not remove them.
    const { rawToken } = await createSession(user.id)
    const past = new Date(Date.now() - 1000)
    await db.session.createMany({
      data: [
        { tokenHash: hashSessionToken('exp1'), userId: user.id, expiresAt: past },
        { tokenHash: hashSessionToken('exp2'), userId: user.id, expiresAt: past }
      ]
    })

    const count = await deleteExpiredSessions()
    assert.ok(count >= 2)
    const active = await db.session.findFirst({ where: { tokenHash: hashSessionToken(rawToken) } })
    assert.ok(active)
  })
})
