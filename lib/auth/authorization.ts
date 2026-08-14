import 'server-only'
import { db } from '../db'
import { isAllowedEmailDomain } from './email'
import { hashSessionToken, readSessionCookie } from './session'
import { ForbiddenError, UnauthorizedError } from './errors'

export type SessionPrincipal = {
  sessionId: string
  userId: string
  email: string
  name: string | null
  role: 'ADMIN' | 'MEMBER'
  teamId: string
  mustChangePassword: boolean
  expiresAt: Date
}

export async function getSessionPrincipal(): Promise<SessionPrincipal | null> {
  const rawToken = await readSessionCookie()
  if (!rawToken) return null

  const tokenHash = hashSessionToken(rawToken)
  const now = new Date()

  const session = await db.session.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: {
          memberships: {
            where: { status: 'ACTIVE' },
            take: 1
          }
        }
      }
    }
  })

  if (!session) return null
  if (session.expiresAt <= now) return null
  if (session.user.deletedAt !== null) return null

  const membership = session.user.memberships[0]
  if (!membership) return null

  if (!isAllowedEmailDomain(session.user.email)) return null

  return {
    sessionId: session.id,
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: membership.role,
    teamId: membership.teamId,
    mustChangePassword: session.user.mustChangePassword,
    expiresAt: session.expiresAt
  }
}

type RequireOptions = { allowPasswordChange?: boolean }

export async function requireActiveMember(opts: RequireOptions = {}): Promise<SessionPrincipal> {
  const principal = await getSessionPrincipal()
  if (!principal) throw new UnauthorizedError()
  if (principal.mustChangePassword && !opts.allowPasswordChange) throw new ForbiddenError()
  return principal
}

export async function requireAdmin(opts: RequireOptions = {}): Promise<SessionPrincipal> {
  const principal = await requireActiveMember(opts)
  if (principal.role !== 'ADMIN') throw new ForbiddenError()
  return principal
}
