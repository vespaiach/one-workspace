import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../../lib/auth/password'
import { createSession } from '../../lib/auth/session'
import { changePasswordAction } from '../../app/change-password/actions'
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

const WORKSPACE_ID = 'pwchange-test-workspace'
const TEAM_ID = 'pwchange-test-team'

async function setupWorkspace() {
  await db.workspace.upsert({
    where: { id: WORKSPACE_ID },
    update: {},
    create: { id: WORKSPACE_ID, name: 'PwChange Test Workspace' }
  })
  await db.team.upsert({
    where: { id: TEAM_ID },
    update: { workspaceId: WORKSPACE_ID },
    create: { id: TEAM_ID, name: 'PwChange Test Team', workspaceId: WORKSPACE_ID }
  })
}

async function createUser(
  email: string,
  opts: { mustChangePassword?: boolean; role?: 'ADMIN' | 'MEMBER' } = {}
) {
  const passwordHash = await hashPassword('OldPassword1!')
  const user = await db.user.create({
    data: { email, passwordHash, mustChangePassword: opts.mustChangePassword ?? true }
  })
  await db.membership.create({
    data: { userId: user.id, teamId: TEAM_ID, role: opts.role ?? 'MEMBER', status: 'ACTIVE' }
  })
  return user
}

async function setupSession(userId: string): Promise<string> {
  const { rawToken } = await createSession(userId)
  __testCookies.reset()
  __testCookies.set(SESSION_COOKIE_LOCAL, rawToken)
  return rawToken
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

function makeFormData(newPassword: string, confirmPassword: string): FormData {
  const fd = new FormData()
  fd.set('newPassword', newPassword)
  fd.set('confirmPassword', confirmPassword)
  return fd
}

describe('changePasswordAction', () => {
  it('redirects to /login?passwordChanged=1 on success', async () => {
    const user = await createUser('change@example.com', { mustChangePassword: true })
    await setupSession(user.id)

    await changePasswordAction({ error: null }, makeFormData('NewPassword1!', 'NewPassword1!')).catch(
      () => {}
    )

    assert.equal(__testNav.getLastRedirect(), '/login?passwordChanged=1')
  })

  it('clears session cookie after successful change', async () => {
    const user = await createUser('clearcookie@example.com', { mustChangePassword: true })
    await setupSession(user.id)

    await changePasswordAction({ error: null }, makeFormData('NewPassword1!', 'NewPassword1!')).catch(
      () => {}
    )

    assert.equal(__testCookies.store.get(SESSION_COOKIE_LOCAL), undefined)
  })

  it('deletes all sessions for the user after successful change', async () => {
    const user = await createUser('allsessions@example.com', { mustChangePassword: true })

    // Create two sessions for the same user
    const { rawToken: token1 } = await createSession(user.id)
    __testCookies.reset()
    const { rawToken: token2 } = await createSession(user.id)
    __testCookies.reset()

    // Authenticate as session 1
    __testCookies.set(SESSION_COOKIE_LOCAL, token1)

    await changePasswordAction({ error: null }, makeFormData('NewPassword1!', 'NewPassword1!')).catch(
      () => {}
    )

    const remaining = await db.session.count({ where: { userId: user.id } })
    assert.equal(remaining, 0)

    // Also verify session 2 is gone (not just the current session)
    const { hashSessionToken } = await import('../../lib/auth/session')
    const session2 = await db.session.findUnique({ where: { tokenHash: hashSessionToken(token2) } })
    assert.equal(session2, null)
  })

  it('sets mustChangePassword to false after successful change', async () => {
    const user = await createUser('flagreset@example.com', { mustChangePassword: true })
    await setupSession(user.id)

    await changePasswordAction({ error: null }, makeFormData('NewPassword1!', 'NewPassword1!')).catch(
      () => {}
    )

    const updated = await db.user.findUniqueOrThrow({ where: { id: user.id } })
    assert.equal(updated.mustChangePassword, false)
  })

  it('returns error when passwords do not match', async () => {
    const user = await createUser('mismatch@example.com', { mustChangePassword: true })
    await setupSession(user.id)

    const state = await changePasswordAction(
      { error: null },
      makeFormData('NewPassword1!', 'DifferentPassword1!')
    )

    assert.equal(state.error, 'Passwords do not match')
    assert.equal(__testNav.getLastRedirect(), null)
  })

  it('returns error when new password is too short', async () => {
    const user = await createUser('tooshort@example.com', { mustChangePassword: true })
    await setupSession(user.id)

    const state = await changePasswordAction({ error: null }, makeFormData('short', 'short'))

    assert.equal(state.error, 'Password must be 8–128 characters')
  })

  it('returns error state when mustChangePassword already cleared (concurrent race)', async () => {
    const user = await createUser('concurrent@example.com', { mustChangePassword: true })
    await setupSession(user.id)

    // Simulate a concurrent request that already completed the change in DB
    await db.user.update({ where: { id: user.id }, data: { mustChangePassword: false } })

    // This request still has a valid session but mustChangePassword is now false —
    // the updateMany WHERE mustChangePassword=true returns 0, triggering StalePasswordChangeError
    const state = await changePasswordAction({ error: null }, makeFormData('NewPassword1!', 'NewPassword1!'))

    assert.ok(state.error !== null, 'should return error for stale concurrent submission')
  })

  it('returns error when user does not have mustChangePassword set', async () => {
    const user = await createUser('nonforced@example.com', { mustChangePassword: false })
    await setupSession(user.id)

    const state = await changePasswordAction({ error: null }, makeFormData('NewPassword1!', 'NewPassword1!'))

    assert.ok(state.error !== null, 'should return error when mustChangePassword is false')
  })

  it('redirects to /login when not authenticated', async () => {
    // No cookie set
    await changePasswordAction({ error: null }, makeFormData('NewPassword1!', 'NewPassword1!')).catch(
      () => {}
    )

    assert.equal(__testNav.getLastRedirect(), '/login')
  })
})
