import 'server-only'
import { randomBytes, createHash } from 'node:crypto'
import { cookies } from 'next/headers'
import { db } from '../db'
import { SESSION_COOKIE_LOCAL, SESSION_COOKIE_SECURE, SESSION_MAX_AGE_SECONDS } from './constants'

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

function isProductionUrl(): boolean {
  const appUrl = process.env.APP_URL?.trim()
  if (!appUrl) return false
  try {
    return new URL(appUrl).protocol === 'https:'
  } catch {
    return false
  }
}

export function sessionCookieName(): string {
  return isProductionUrl() ? SESSION_COOKIE_SECURE : SESSION_COOKIE_LOCAL
}

function cookieOptions() {
  const secure = isProductionUrl()
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS
  }
}

export type CreatedSession = { rawToken: string; expiresAt: Date }

export async function createSession(userId: string): Promise<CreatedSession> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000)

  // Opportunistically delete expired sessions for this user.
  await db.session.deleteMany({
    where: { userId, expiresAt: { lte: now } }
  })

  const rawToken = generateSessionToken()
  const tokenHash = hashSessionToken(rawToken)

  await db.session.create({ data: { tokenHash, userId, expiresAt } })

  const cookieStore = await cookies()
  cookieStore.set(sessionCookieName(), rawToken, cookieOptions())

  return { rawToken, expiresAt }
}

export async function readSessionCookie(): Promise<string | null> {
  const cookieStore = await cookies()
  const secureCookie = cookieStore.get(SESSION_COOKIE_SECURE)?.value
  const localCookie = cookieStore.get(SESSION_COOKIE_LOCAL)?.value
  const raw = secureCookie ?? localCookie ?? null

  if (!raw) return null
  // Plausible base64url length for 32 bytes = 43 characters
  if (raw.length < 40 || raw.length > 50) return null
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null

  return raw
}

export async function deleteCurrentSession(): Promise<void> {
  const cookieStore = await cookies()
  const raw = (cookieStore.get(SESSION_COOKIE_SECURE) ?? cookieStore.get(SESSION_COOKIE_LOCAL))?.value
  if (raw) {
    const tokenHash = hashSessionToken(raw)
    await db.session.deleteMany({ where: { tokenHash } }).catch(() => null)
  }
  cookieStore.delete(SESSION_COOKIE_SECURE)
  cookieStore.delete(SESSION_COOKIE_LOCAL)
}

export async function deleteAllUserSessions(
  userId: string,
  tx?: Parameters<Parameters<typeof db.$transaction>[0]>[0]
): Promise<void> {
  const client = tx ?? db
  await client.session.deleteMany({ where: { userId } })
}

export async function deleteExpiredSessions(): Promise<number> {
  const result = await db.session.deleteMany({ where: { expiresAt: { lte: new Date() } } })
  return result.count
}
