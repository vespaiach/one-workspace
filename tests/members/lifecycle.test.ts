import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../../lib/auth/password'
import { hashSessionToken } from '../../lib/auth/session'
import { suspendMember, removeMember, changeMemberRole } from '../../lib/members/lifecycle'
import { LastAdminError } from '../../lib/auth/errors'

const db = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } }
})

const WORKSPACE_ID = 'lifecycle-test-workspace'
const TEAM_ID = 'lifecycle-test-team'

async function setupWorkspace() {
  await db.workspace.upsert({
    where: { id: WORKSPACE_ID },
    update: {},
    create: { id: WORKSPACE_ID, name: 'Lifecycle Test Workspace' }
  })
  await db.team.upsert({
    where: { id: TEAM_ID },
    update: { workspaceId: WORKSPACE_ID },
    create: { id: TEAM_ID, name: 'Lifecycle Test Team', workspaceId: WORKSPACE_ID }
  })
}

async function createUser(
  email: string,
  opts: { role?: 'ADMIN' | 'MEMBER'; status?: 'ACTIVE' | 'SUSPENDED' } = {}
) {
  const passwordHash = await hashPassword('TestPassword1!')
  const user = await db.user.create({ data: { email, passwordHash } })
  await db.membership.create({
    data: {
      userId: user.id,
      teamId: TEAM_ID,
      role: opts.role ?? 'MEMBER',
      status: opts.status ?? 'ACTIVE'
    }
  })
  return user
}

async function createSession(userId: string) {
  const rawToken = `session-token-${Math.random()}`
  const tokenHash = hashSessionToken(rawToken)
  await db.session.create({
    data: { tokenHash, userId, expiresAt: new Date(Date.now() + 86400000) }
  })
  return tokenHash
}

before(async () => {
  await setupWorkspace()
})

beforeEach(async () => {
  await db.auditLog.deleteMany({})
  await db.session.deleteMany({})
  await db.membership.deleteMany({})
  await db.user.deleteMany({})
  await setupWorkspace()
})

after(async () => {
  await db.auditLog.deleteMany({})
  await db.session.deleteMany({})
  await db.membership.deleteMany({})
  await db.user.deleteMany({})
  await db.team.deleteMany({})
  await db.workspace.deleteMany({})
  await db.$disconnect()
})

describe('suspendMember', () => {
  it('sets membership status to SUSPENDED', async () => {
    const admin = await createUser('admin@example.com', { role: 'ADMIN' })
    const member = await createUser('member@example.com')

    await suspendMember({ actorId: admin.id, targetUserId: member.id, teamId: TEAM_ID })

    const m = await db.membership.findFirst({ where: { userId: member.id } })
    assert.equal(m?.status, 'SUSPENDED')
  })

  it('deletes all sessions of suspended member', async () => {
    const admin = await createUser('admin2@example.com', { role: 'ADMIN' })
    const member = await createUser('member2@example.com')
    await createSession(member.id)
    await createSession(member.id)

    await suspendMember({ actorId: admin.id, targetUserId: member.id, teamId: TEAM_ID })

    const sessions = await db.session.findMany({ where: { userId: member.id } })
    assert.equal(sessions.length, 0)
  })

  it('writes member_suspended audit log', async () => {
    const admin = await createUser('admin3@example.com', { role: 'ADMIN' })
    const member = await createUser('member3@example.com')

    await suspendMember({ actorId: admin.id, targetUserId: member.id, teamId: TEAM_ID })

    const log = await db.auditLog.findFirst({ where: { actorId: admin.id, action: 'member_suspended' } })
    assert.ok(log)
  })

  it('throws LastAdminError when suspending the last active admin', async () => {
    const admin = await createUser('lastadmin@example.com', { role: 'ADMIN' })

    await assert.rejects(
      () => suspendMember({ actorId: admin.id, targetUserId: admin.id, teamId: TEAM_ID }),
      LastAdminError
    )
  })

  it('allows suspending an admin when another admin exists', async () => {
    const admin1 = await createUser('admin-a@example.com', { role: 'ADMIN' })
    const admin2 = await createUser('admin-b@example.com', { role: 'ADMIN' })

    await suspendMember({ actorId: admin1.id, targetUserId: admin2.id, teamId: TEAM_ID })

    const m = await db.membership.findFirst({ where: { userId: admin2.id } })
    assert.equal(m?.status, 'SUSPENDED')
  })

  it('is idempotent when member already suspended', async () => {
    const admin = await createUser('admin4@example.com', { role: 'ADMIN' })
    const member = await createUser('already-suspended@example.com', { status: 'SUSPENDED' })

    await assert.doesNotReject(() =>
      suspendMember({ actorId: admin.id, targetUserId: member.id, teamId: TEAM_ID })
    )
  })
})

describe('removeMember', () => {
  it('deletes the membership', async () => {
    const admin = await createUser('admin-rm@example.com', { role: 'ADMIN' })
    const member = await createUser('remove-me@example.com')

    await removeMember({ actorId: admin.id, targetUserId: member.id, teamId: TEAM_ID })

    const m = await db.membership.findFirst({ where: { userId: member.id } })
    assert.equal(m, null)
  })

  it('deletes all sessions of removed member', async () => {
    const admin = await createUser('admin-rm2@example.com', { role: 'ADMIN' })
    const member = await createUser('remove-sessions@example.com')
    await createSession(member.id)

    await removeMember({ actorId: admin.id, targetUserId: member.id, teamId: TEAM_ID })

    const sessions = await db.session.findMany({ where: { userId: member.id } })
    assert.equal(sessions.length, 0)
  })

  it('writes member_removed audit log', async () => {
    const admin = await createUser('admin-rm3@example.com', { role: 'ADMIN' })
    const member = await createUser('audit-remove@example.com')

    await removeMember({ actorId: admin.id, targetUserId: member.id, teamId: TEAM_ID })

    const log = await db.auditLog.findFirst({ where: { actorId: admin.id, action: 'member_removed' } })
    assert.ok(log)
  })

  it('throws LastAdminError when removing the last active admin', async () => {
    const admin = await createUser('last-admin-rm@example.com', { role: 'ADMIN' })

    await assert.rejects(
      () => removeMember({ actorId: admin.id, targetUserId: admin.id, teamId: TEAM_ID }),
      LastAdminError
    )
  })

  it('allows removing a suspended admin even if last (suspended does not count as active admin)', async () => {
    const admin = await createUser('active-admin@example.com', { role: 'ADMIN' })
    const suspendedAdmin = await createUser('suspended-admin@example.com', {
      role: 'ADMIN',
      status: 'SUSPENDED'
    })

    await assert.doesNotReject(() =>
      removeMember({ actorId: admin.id, targetUserId: suspendedAdmin.id, teamId: TEAM_ID })
    )
  })
})

describe('changeMemberRole', () => {
  it('updates role from MEMBER to ADMIN', async () => {
    const admin = await createUser('admin-cr@example.com', { role: 'ADMIN' })
    const member = await createUser('promote@example.com')

    await changeMemberRole({ actorId: admin.id, targetUserId: member.id, teamId: TEAM_ID, newRole: 'ADMIN' })

    const m = await db.membership.findFirst({ where: { userId: member.id } })
    assert.equal(m?.role, 'ADMIN')
  })

  it('updates role from ADMIN to MEMBER', async () => {
    const admin1 = await createUser('admin-cr2@example.com', { role: 'ADMIN' })
    const admin2 = await createUser('demote@example.com', { role: 'ADMIN' })

    await changeMemberRole({
      actorId: admin1.id,
      targetUserId: admin2.id,
      teamId: TEAM_ID,
      newRole: 'MEMBER'
    })

    const m = await db.membership.findFirst({ where: { userId: admin2.id } })
    assert.equal(m?.role, 'MEMBER')
  })

  it('writes role_changed audit log', async () => {
    const admin = await createUser('admin-cr3@example.com', { role: 'ADMIN' })
    const member = await createUser('role-audit@example.com')

    await changeMemberRole({ actorId: admin.id, targetUserId: member.id, teamId: TEAM_ID, newRole: 'ADMIN' })

    const log = await db.auditLog.findFirst({ where: { actorId: admin.id, action: 'role_changed' } })
    assert.ok(log)
    assert.deepEqual((log?.metadata as Record<string, unknown>)?.oldRole, 'MEMBER')
    assert.deepEqual((log?.metadata as Record<string, unknown>)?.newRole, 'ADMIN')
  })

  it('throws LastAdminError when demoting the last active admin', async () => {
    const admin = await createUser('last-admin-cr@example.com', { role: 'ADMIN' })

    await assert.rejects(
      () =>
        changeMemberRole({ actorId: admin.id, targetUserId: admin.id, teamId: TEAM_ID, newRole: 'MEMBER' }),
      LastAdminError
    )
  })

  it('is a no-op when role is already the target role', async () => {
    const admin = await createUser('admin-noop@example.com', { role: 'ADMIN' })
    const member = await createUser('noop@example.com')
    const logsBefore = await db.auditLog.count()

    await changeMemberRole({ actorId: admin.id, targetUserId: member.id, teamId: TEAM_ID, newRole: 'MEMBER' })

    const logsAfter = await db.auditLog.count()
    assert.equal(logsAfter, logsBefore)
  })
})
