import 'server-only'
import { randomBytes, createHash } from 'node:crypto'
import { db } from '../db'
import { normalizeEmail, isAllowedEmailDomain } from '../auth/email'
import { hashPassword } from '../auth/password'
import { InvalidInviteTokenError, InviteValidationError } from '../auth/errors'
import { sendMail } from './smtp'

const INVITE_EXPIRY_MS = 48 * 60 * 60 * 1000

function generateInviteToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashInviteToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

type CreateInviteInput = {
  actorId: string
  email: unknown
  role: unknown
}

export async function createInvite(input: CreateInviteInput): Promise<void> {
  const emailResult = normalizeEmail(input.email)
  if (!emailResult.ok) throw new InviteValidationError('Invalid email address')
  if (!isAllowedEmailDomain(emailResult.email)) throw new InviteValidationError('Email domain is not allowed')

  const role = input.role === 'ADMIN' || input.role === 'MEMBER' ? input.role : null
  if (!role) throw new InviteValidationError('Invalid role')

  const rawToken = generateInviteToken()
  const tokenHash = hashInviteToken(rawToken)
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS)

  await db.$transaction(async (tx) => {
    const invite = await tx.invite.create({
      data: {
        email: emailResult.email,
        role,
        tokenHash,
        expiresAt,
        createdById: input.actorId
      }
    })
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: 'invite_sent',
        entityType: 'Invite',
        entityId: invite.id,
        metadata: { email: emailResult.email, role }
      }
    })
  })

  const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '')
  await sendMail({
    to: emailResult.email,
    subject: 'You have been invited to One Workspace',
    text: [
      `You have been invited to join One Workspace as a ${role}.`,
      '',
      `Set up your account (expires in 48 hours):`,
      `${appUrl}/signup?token=${rawToken}`
    ].join('\n'),
    html: [
      `<p>You've been invited to join <strong>One Workspace</strong> as a <strong>${role}</strong>.</p>`,
      `<p><a href="${appUrl}/signup?token=${rawToken}">Set up your account</a> (expires in 48 hours)</p>`
    ].join('')
  })
}

type ActivateInviteInput = {
  rawToken: unknown
  name: unknown
  password: string
}

export async function activateInvite(input: ActivateInviteInput): Promise<void> {
  if (typeof input.rawToken !== 'string' || !input.rawToken) throw new InvalidInviteTokenError()
  const tokenHash = hashInviteToken(input.rawToken)

  const invite = await db.invite.findUnique({ where: { tokenHash } })
  if (!invite) throw new InvalidInviteTokenError()
  if (invite.consumedAt !== null) throw new InvalidInviteTokenError()
  if (invite.expiresAt <= new Date()) throw new InvalidInviteTokenError()

  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) throw new InviteValidationError('Name is required')

  const passwordHash = await hashPassword(input.password)

  // Resolve the team from the invite creator's membership (single-team system).
  const creatorMembership = await db.membership.findFirst({
    where: { userId: invite.createdById },
    select: { teamId: true }
  })
  if (!creatorMembership) throw new InvalidInviteTokenError()

  await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email: invite.email, name, passwordHash }
    })
    const membership = await tx.membership.create({
      data: {
        userId: user.id,
        teamId: creatorMembership.teamId,
        role: invite.role,
        status: 'ACTIVE'
      }
    })
    await tx.invite.update({
      where: { id: invite.id },
      data: { consumedAt: new Date() }
    })
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: 'account_activated',
        entityType: 'Membership',
        entityId: membership.id,
        metadata: { email: user.email, role: invite.role, inviteId: invite.id }
      }
    })
  })
}
