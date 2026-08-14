import 'server-only'
import { db } from '../db'
import { deleteAllUserSessions } from '../auth/session'
import { LastAdminError } from '../auth/errors'

type PrismaTx = Parameters<Parameters<typeof db.$transaction>[0]>[0]

async function countActiveAdmins(teamId: string, tx: PrismaTx): Promise<number> {
  return tx.membership.count({ where: { teamId, role: 'ADMIN', status: 'ACTIVE' } })
}

type MemberInput = { actorId: string; targetUserId: string; teamId: string }

export async function suspendMember(input: MemberInput): Promise<void> {
  await db.$transaction(async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { userId_teamId: { userId: input.targetUserId, teamId: input.teamId } }
    })
    if (!membership) throw new Error('Member not found')
    if (membership.status === 'SUSPENDED') return

    if (membership.role === 'ADMIN') {
      const adminCount = await countActiveAdmins(input.teamId, tx)
      if (adminCount <= 1) throw new LastAdminError()
    }

    await tx.membership.update({
      where: { userId_teamId: { userId: input.targetUserId, teamId: input.teamId } },
      data: { status: 'SUSPENDED' }
    })
    await deleteAllUserSessions(input.targetUserId, tx)
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: 'member_suspended',
        entityType: 'Membership',
        entityId: membership.id,
        metadata: { targetUserId: input.targetUserId }
      }
    })
  })
}

export async function removeMember(input: MemberInput): Promise<void> {
  await db.$transaction(async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { userId_teamId: { userId: input.targetUserId, teamId: input.teamId } }
    })
    if (!membership) throw new Error('Member not found')

    if (membership.role === 'ADMIN' && membership.status === 'ACTIVE') {
      const adminCount = await countActiveAdmins(input.teamId, tx)
      if (adminCount <= 1) throw new LastAdminError()
    }

    await tx.membership.delete({
      where: { userId_teamId: { userId: input.targetUserId, teamId: input.teamId } }
    })
    await deleteAllUserSessions(input.targetUserId, tx)
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: 'member_removed',
        entityType: 'Membership',
        entityId: membership.id,
        metadata: { targetUserId: input.targetUserId }
      }
    })
  })
}

type ChangeRoleInput = { actorId: string; targetUserId: string; teamId: string; newRole: 'ADMIN' | 'MEMBER' }

export async function changeMemberRole(input: ChangeRoleInput): Promise<void> {
  await db.$transaction(async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { userId_teamId: { userId: input.targetUserId, teamId: input.teamId } }
    })
    if (!membership) throw new Error('Member not found')
    if (membership.role === input.newRole) return

    if (membership.role === 'ADMIN' && input.newRole === 'MEMBER' && membership.status === 'ACTIVE') {
      const adminCount = await countActiveAdmins(input.teamId, tx)
      if (adminCount <= 1) throw new LastAdminError()
    }

    await tx.membership.update({
      where: { userId_teamId: { userId: input.targetUserId, teamId: input.teamId } },
      data: { role: input.newRole }
    })
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: 'role_changed',
        entityType: 'Membership',
        entityId: membership.id,
        metadata: { targetUserId: input.targetUserId, oldRole: membership.role, newRole: input.newRole }
      }
    })
  })
}
