import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { db } from '../db'
import { logger } from '../logger'
import { getTrustedClientIp } from './client-ip'
import { isAllowedEmailDomain, normalizeEmail } from './email'
import { hashPassword } from './password'
import {
  buildPasswordResetUrl,
  sendPasswordResetEmail,
  type PasswordResetMessage
} from './password-reset-email'
import { reservePasswordResetAttempt } from './password-reset-rate-limit'

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000
const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export const FORGOT_PASSWORD_MESSAGE = "If that email is registered, you'll receive a link"
export type PasswordResetMailer = (message: PasswordResetMessage) => Promise<void>

class InvalidPasswordResetError extends Error {}

export function generatePasswordResetToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashPasswordResetToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

function isPlausibleRawToken(value: unknown): value is string {
  return typeof value === 'string' && RAW_TOKEN_PATTERN.test(value)
}

type RequestPasswordResetInput = {
  email: unknown
  headers: Headers | { get(name: string): string | null }
}

export async function requestPasswordReset(
  input: RequestPasswordResetInput,
  mailer: PasswordResetMailer = sendPasswordResetEmail
): Promise<void> {
  const ip = getTrustedClientIp(input.headers as Headers)
  if (!reservePasswordResetAttempt(ip)) return

  const emailResult = normalizeEmail(input.email)
  if (!emailResult.ok || !isAllowedEmailDomain(emailResult.email)) return

  let resetId: string | null = null
  try {
    const user = await db.user.findUnique({
      where: { email: emailResult.email },
      include: { memberships: { where: { status: 'ACTIVE' }, take: 1 } }
    })
    if (!user || user.deletedAt !== null || user.memberships.length === 0) return

    const rawToken = generatePasswordResetToken()
    const reset = await db.passwordReset.create({
      data: {
        userId: user.id,
        tokenHash: hashPasswordResetToken(rawToken),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS)
      }
    })
    resetId = reset.id

    await mailer({
      to: user.email,
      resetUrl: buildPasswordResetUrl(rawToken)
    })
  } catch (error) {
    if (resetId) {
      await db.passwordReset.deleteMany({ where: { id: resetId, consumedAt: null } }).catch(() => null)
    }
    logger.error('Password reset request failed', {
      correlationId: randomUUID(),
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
  }
}

export async function isPasswordResetTokenValid(rawToken: unknown): Promise<boolean> {
  if (!isPlausibleRawToken(rawToken)) return false

  const reset = await db.passwordReset.findUnique({
    where: { tokenHash: hashPasswordResetToken(rawToken) },
    include: {
      user: {
        include: { memberships: { where: { status: 'ACTIVE' }, take: 1 } }
      }
    }
  })

  return Boolean(
    reset &&
      reset.consumedAt === null &&
      reset.expiresAt > new Date() &&
      reset.user.deletedAt === null &&
      reset.user.memberships.length > 0 &&
      isAllowedEmailDomain(reset.user.email)
  )
}

export async function resetPasswordWithToken(
  rawToken: unknown,
  newPassword: string
): Promise<'success' | 'invalid'> {
  if (!isPlausibleRawToken(rawToken)) return 'invalid'
  if (!(await isPasswordResetTokenValid(rawToken))) return 'invalid'

  const tokenHash = hashPasswordResetToken(rawToken)
  const passwordHash = await hashPassword(newPassword)
  const now = new Date()

  try {
    await db.$transaction(async (tx) => {
      const reset = await tx.passwordReset.findUnique({
        where: { tokenHash },
        include: {
          user: {
            include: { memberships: { where: { status: 'ACTIVE' }, take: 1 } }
          }
        }
      })
      if (
        !reset ||
        reset.consumedAt !== null ||
        reset.expiresAt <= now ||
        reset.user.deletedAt !== null ||
        reset.user.memberships.length === 0 ||
        !isAllowedEmailDomain(reset.user.email)
      ) {
        throw new InvalidPasswordResetError()
      }

      const consumed = await tx.passwordReset.updateMany({
        where: { id: reset.id, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now }
      })
      if (consumed.count !== 1) throw new InvalidPasswordResetError()

      const updated = await tx.user.updateMany({
        where: {
          id: reset.userId,
          deletedAt: null,
          memberships: { some: { status: 'ACTIVE' } }
        },
        data: { passwordHash, mustChangePassword: false }
      })
      if (updated.count !== 1) throw new InvalidPasswordResetError()

      await tx.session.deleteMany({ where: { userId: reset.userId } })
    })
  } catch (error) {
    if (error instanceof InvalidPasswordResetError) return 'invalid'
    throw error
  }

  return 'success'
}
