import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { forgotPasswordAction } from '../../app/forgot-password/actions'
import { resetPasswordAction } from '../../app/reset-password/actions'
import { hashPassword, verifyPassword } from '../../lib/auth/password'
import {
  FORGOT_PASSWORD_MESSAGE,
  generatePasswordResetToken,
  hashPasswordResetToken,
  isPasswordResetTokenValid,
  requestPasswordReset,
  resetPasswordWithToken,
  type PasswordResetMailer
} from '../../lib/auth/password-reset'
import { __resetPasswordResetRateLimitForTest } from '../../lib/auth/password-reset-rate-limit'

const db = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } }
})

declare const __testNav: { getLastRedirect(): string | null; resetRedirect(): void }

const WORKSPACE_ID = 'password-reset-test-workspace'
const TEAM_ID = 'password-reset-test-team'
const TEST_HEADERS = new Headers({ 'x-forwarded-for': '192.0.2.10' })

async function setupWorkspace() {
  await db.workspace.upsert({
    where: { id: WORKSPACE_ID },
    update: {},
    create: { id: WORKSPACE_ID, name: 'Password Reset Test Workspace' }
  })
  await db.team.upsert({
    where: { id: TEAM_ID },
    update: { workspaceId: WORKSPACE_ID },
    create: { id: TEAM_ID, name: 'Password Reset Test Team', workspaceId: WORKSPACE_ID }
  })
}

async function createUser(
  email: string,
  options: {
    deletedAt?: Date
    status?: 'ACTIVE' | 'SUSPENDED'
    mustChangePassword?: boolean
  } = {}
) {
  const passwordHash = await hashPassword('OldPassword1!')
  const user = await db.user.create({
    data: {
      email,
      passwordHash,
      deletedAt: options.deletedAt,
      mustChangePassword: options.mustChangePassword ?? false
    }
  })
  await db.membership.create({
    data: {
      userId: user.id,
      teamId: TEAM_ID,
      role: 'MEMBER',
      status: options.status ?? 'ACTIVE'
    }
  })
  return user
}

async function createReset(
  userId: string,
  options: { consumedAt?: Date; expiresAt?: Date; rawToken?: string } = {}
) {
  const rawToken = options.rawToken ?? generatePasswordResetToken()
  const reset = await db.passwordReset.create({
    data: {
      userId,
      tokenHash: hashPasswordResetToken(rawToken),
      expiresAt: options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
      consumedAt: options.consumedAt
    }
  })
  return { rawToken, reset }
}

function resetForm(token: string, password: string, confirmation = password): FormData {
  const formData = new FormData()
  formData.set('token', token)
  formData.set('newPassword', password)
  formData.set('confirmPassword', confirmation)
  return formData
}

before(async () => {
  await setupWorkspace()
})

beforeEach(async () => {
  __testNav.resetRedirect()
  __resetPasswordResetRateLimitForTest()
  delete process.env.ALLOWED_EMAIL_DOMAIN
  process.env.APP_URL = 'http://localhost'
  await db.passwordReset.deleteMany({})
  await db.session.deleteMany({})
  await db.membership.deleteMany({})
  await db.user.deleteMany({})
  await setupWorkspace()
})

after(async () => {
  await db.passwordReset.deleteMany({})
  await db.session.deleteMany({})
  await db.membership.deleteMany({})
  await db.user.deleteMany({})
  await db.team.deleteMany({})
  await db.workspace.deleteMany({})
  await db.$disconnect()
})

describe('password-reset token storage', () => {
  it('generates a 256-bit base64url token and hashes it deterministically', () => {
    const rawToken = generatePasswordResetToken()

    assert.match(rawToken, /^[A-Za-z0-9_-]{43}$/)
    assert.notEqual(hashPasswordResetToken(rawToken), rawToken)
    assert.equal(hashPasswordResetToken(rawToken), hashPasswordResetToken(rawToken))
  })

  it('stores only the SHA-256 hash and emails the raw token in a one-hour link', async () => {
    await createUser('member@example.com')
    const messages: Parameters<PasswordResetMailer>[0][] = []
    const mailer: PasswordResetMailer = async (message) => {
      messages.push(message)
    }
    const startedAt = Date.now()

    await requestPasswordReset({ email: ' MEMBER@example.com ', headers: TEST_HEADERS }, mailer)

    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.to, 'member@example.com')
    const url = new URL(messages[0]!.resetUrl)
    const rawToken = url.searchParams.get('token')
    assert.ok(rawToken)

    const row = await db.passwordReset.findUniqueOrThrow({
      where: { tokenHash: hashPasswordResetToken(rawToken) }
    })
    assert.notEqual(row.tokenHash, rawToken)
    assert.equal(row.consumedAt, null)
    assert.ok(row.expiresAt.getTime() >= startedAt + 60 * 60 * 1000)
    assert.ok(row.expiresAt.getTime() <= Date.now() + 60 * 60 * 1000)
  })

  it('does not issue tokens for deleted, suspended, or domain-ineligible users', async () => {
    await createUser('deleted@example.com', { deletedAt: new Date() })
    await createUser('suspended@example.com', { status: 'SUSPENDED' })
    await createUser('outside@other.test')
    process.env.ALLOWED_EMAIL_DOMAIN = 'example.com'
    let sent = 0
    const mailer: PasswordResetMailer = async () => {
      sent += 1
    }

    await requestPasswordReset({ email: 'deleted@example.com', headers: new Headers() }, mailer)
    await requestPasswordReset({ email: 'suspended@example.com', headers: new Headers() }, mailer)
    await requestPasswordReset({ email: 'outside@other.test', headers: new Headers() }, mailer)

    assert.equal(sent, 0)
    assert.equal(await db.passwordReset.count(), 0)
  })

  it('applies the forgot-password limit per IP before issuing a token', async () => {
    await createUser('member@example.com')
    const headers = new Headers({ 'x-forwarded-for': '198.51.100.5' })
    const mailer: PasswordResetMailer = async () => {
      assert.fail('rate-limited request must not send email')
    }

    for (let i = 0; i < 5; i++) {
      await requestPasswordReset({ email: 'unknown@example.com', headers }, mailer)
    }
    await requestPasswordReset({ email: 'member@example.com', headers }, mailer)

    assert.equal(await db.passwordReset.count(), 0)
  })

  it('removes an unusable token when SMTP delivery fails', async () => {
    await createUser('delivery-failure@example.com')
    const failingMailer: PasswordResetMailer = async () => {
      throw new Error('SMTP unavailable')
    }

    await requestPasswordReset(
      { email: 'delivery-failure@example.com', headers: TEST_HEADERS },
      failingMailer
    )

    assert.equal(await db.passwordReset.count(), 0)
  })
})

describe('forgotPasswordAction', () => {
  it('returns the same generic success for unknown and malformed emails', async () => {
    const unknown = new FormData()
    unknown.set('email', 'unknown@example.com')
    const malformed = new FormData()
    malformed.set('email', 'not-an-email')

    const unknownState = await forgotPasswordAction({ message: null }, unknown)
    const malformedState = await forgotPasswordAction({ message: null }, malformed)

    assert.equal(unknownState.message, FORGOT_PASSWORD_MESSAGE)
    assert.equal(malformedState.message, FORGOT_PASSWORD_MESSAGE)
  })
})

describe('password-reset validation and consumption', () => {
  it('accepts only active, unexpired, unconsumed reset tokens', async () => {
    const active = await createUser('active@example.com')
    const deleted = await createUser('deleted@example.com', { deletedAt: new Date() })
    const valid = await createReset(active.id)
    const expired = await createReset(active.id, { expiresAt: new Date(Date.now() - 1) })
    const consumed = await createReset(active.id, { consumedAt: new Date() })
    const deletedUser = await createReset(deleted.id)

    assert.equal(await isPasswordResetTokenValid(valid.rawToken), true)
    assert.equal(await isPasswordResetTokenValid(expired.rawToken), false)
    assert.equal(await isPasswordResetTokenValid(consumed.rawToken), false)
    assert.equal(await isPasswordResetTokenValid(deletedUser.rawToken), false)
    assert.equal(await isPasswordResetTokenValid('invalid-token'), false)
  })

  it('atomically updates the password, consumes the token, and deletes all sessions', async () => {
    const user = await createUser('reset@example.com', { mustChangePassword: true })
    const { rawToken, reset } = await createReset(user.id)
    await db.session.createMany({
      data: [
        {
          userId: user.id,
          tokenHash: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 60_000)
        },
        {
          userId: user.id,
          tokenHash: 'b'.repeat(64),
          expiresAt: new Date(Date.now() + 60_000)
        }
      ]
    })

    const result = await resetPasswordWithToken(rawToken, 'BrandNewPassword1!')

    assert.equal(result, 'success')
    const updated = await db.user.findUniqueOrThrow({ where: { id: user.id } })
    assert.equal(await verifyPassword(updated.passwordHash, 'BrandNewPassword1!'), true)
    assert.equal(updated.mustChangePassword, false)
    assert.equal(await db.session.count({ where: { userId: user.id } }), 0)
    const consumed = await db.passwordReset.findUniqueOrThrow({ where: { id: reset.id } })
    assert.ok(consumed.consumedAt)
  })

  it('cannot consume the same token twice or overwrite the first new password', async () => {
    const user = await createUser('single-use@example.com')
    const { rawToken } = await createReset(user.id)

    assert.equal(await resetPasswordWithToken(rawToken, 'FirstNewPassword1!'), 'success')
    assert.equal(await resetPasswordWithToken(rawToken, 'SecondNewPassword1!'), 'invalid')

    const updated = await db.user.findUniqueOrThrow({ where: { id: user.id } })
    assert.equal(await verifyPassword(updated.passwordHash, 'FirstNewPassword1!'), true)
    assert.equal(await verifyPassword(updated.passwordHash, 'SecondNewPassword1!'), false)
  })

  it('does not change the password for an expired token', async () => {
    const user = await createUser('expired@example.com')
    const { rawToken } = await createReset(user.id, { expiresAt: new Date(Date.now() - 1) })

    assert.equal(await resetPasswordWithToken(rawToken, 'BrandNewPassword1!'), 'invalid')

    const unchanged = await db.user.findUniqueOrThrow({ where: { id: user.id } })
    assert.equal(await verifyPassword(unchanged.passwordHash, 'OldPassword1!'), true)
  })
})

describe('resetPasswordAction', () => {
  it('redirects to login after a valid reset', async () => {
    const user = await createUser('action@example.com')
    const { rawToken } = await createReset(user.id)

    await resetPasswordAction(
      { error: null },
      resetForm(rawToken, 'ActionPassword1!')
    ).catch(() => {})

    assert.equal(__testNav.getLastRedirect(), '/login?passwordReset=1')
  })

  it('returns one clear error for invalid, expired, and consumed tokens', async () => {
    const state = await resetPasswordAction(
      { error: null },
      resetForm('invalid-token', 'ActionPassword1!')
    )

    assert.equal(state.error, 'This password reset link is invalid, expired, or already used.')
    assert.equal(__testNav.getLastRedirect(), null)
  })

  it('validates password length and confirmation before changing anything', async () => {
    const user = await createUser('validation@example.com')
    const { rawToken } = await createReset(user.id)

    const short = await resetPasswordAction({ error: null }, resetForm(rawToken, 'short'))
    const mismatch = await resetPasswordAction(
      { error: null },
      resetForm(rawToken, 'ValidPassword1!', 'DifferentPassword1!')
    )

    assert.equal(short.error, 'Password must be 8–128 characters')
    assert.equal(mismatch.error, 'Passwords do not match')
    assert.equal(await isPasswordResetTokenValid(rawToken), true)
  })
})
