import 'server-only'
import { logger } from '../logger'
import { normalizeEmail, isAllowedEmailDomain } from './email'
import { parsePassword, verifyPassword, performDummyVerify } from './password'
import { getTrustedClientIp } from './client-ip'
import { reserveLoginAttempt } from './rate-limit'
import { createSession } from './session'
import { InvalidCredentialsError, RateLimitError } from './errors'
import { db } from '../db'
import { randomUUID } from 'node:crypto'

type LoginInput = { email: unknown; password: unknown; headers: Headers | { get(k: string): string | null } }
type LoginResult = { mustChangePassword: boolean }

export async function authenticateAndCreateSession(input: LoginInput): Promise<LoginResult> {
  const ip = getTrustedClientIp(input.headers as Headers)

  // Normalize email — use a stable invalid-input key if normalization fails
  const emailResult = normalizeEmail(input.email)
  const normalizedEmail = emailResult.ok ? emailResult.email : `invalid:${String(input.email).slice(0, 32)}`

  const passwordResult = parsePassword(input.password)

  // Reserve both limiter buckets before any Argon2 work
  const reservation = reserveLoginAttempt({ ip, normalizedEmail })
  if (!reservation.allowed) {
    throw new RateLimitError()
  }

  try {
    // If input is malformed, run dummy verify and throw credential error
    if (!emailResult.ok || !passwordResult.ok) {
      await performDummyVerify(String(input.password).slice(0, 128))
      throw new InvalidCredentialsError()
    }

    const user = await db.user.findUnique({
      where: { email: normalizedEmail },
      include: {
        memberships: { where: { status: 'ACTIVE' }, take: 1 }
      }
    })

    const hashToVerify = user?.passwordHash ?? null
    const passwordValid =
      hashToVerify ?
        await verifyPassword(hashToVerify, passwordResult.password)
      : (await performDummyVerify(passwordResult.password), false)

    if (
      !passwordValid ||
      !user ||
      user.deletedAt !== null ||
      user.memberships.length === 0 ||
      !isAllowedEmailDomain(normalizedEmail)
    ) {
      throw new InvalidCredentialsError()
    }

    const session = await createSession(user.id)
    reservation.refund()
    return { mustChangePassword: user.mustChangePassword }
  } catch (err) {
    if (err instanceof InvalidCredentialsError || err instanceof RateLimitError) {
      throw err
    }
    const correlationId = randomUUID()
    logger.error('Login infrastructure failure', {
      correlationId,
      errorName: err instanceof Error ? err.name : 'UnknownError'
    })
    throw new Error('Sign-in temporarily unavailable')
  }
}
