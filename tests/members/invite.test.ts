import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../../lib/auth/password'
import { createInvite, activateInvite, hashInviteToken } from '../../lib/members/invite'
import { InvalidInviteTokenError, InviteValidationError } from '../../lib/auth/errors'

const db = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } }
})

const WORKSPACE_ID = 'invite-test-workspace'
const TEAM_ID = 'invite-test-team'

async function setupWorkspace() {
  await db.workspace.upsert({
    where: { id: WORKSPACE_ID },
    update: {},
    create: { id: WORKSPACE_ID, name: 'Invite Test Workspace' }
  })
  await db.team.upsert({
    where: { id: TEAM_ID },
    update: { workspaceId: WORKSPACE_ID },
    create: { id: TEAM_ID, name: 'Invite Test Team', workspaceId: WORKSPACE_ID }
  })
}

async function createAdmin(email: string) {
  const passwordHash = await hashPassword('TestPassword1!')
  const user = await db.user.create({ data: { email, passwordHash } })
  await db.membership.create({
    data: { userId: user.id, teamId: TEAM_ID, role: 'ADMIN', status: 'ACTIVE' }
  })
  return user
}

before(async () => {
  await setupWorkspace()
})

beforeEach(async () => {
  await db.auditLog.deleteMany({})
  await db.invite.deleteMany({})
  await db.session.deleteMany({})
  await db.membership.deleteMany({})
  await db.user.deleteMany({})
  await setupWorkspace()
})

after(async () => {
  await db.auditLog.deleteMany({})
  await db.invite.deleteMany({})
  await db.session.deleteMany({})
  await db.membership.deleteMany({})
  await db.user.deleteMany({})
  await db.team.deleteMany({})
  await db.workspace.deleteMany({})
  await db.$disconnect()
})

describe('createInvite', () => {
  it('creates invite row with hashed token, never stores raw token', async () => {
    const admin = await createAdmin('admin@example.com')

    await createInvite({ actorId: admin.id, email: 'invitee@example.com', role: 'MEMBER' })

    const invite = await db.invite.findFirst({ where: { email: 'invitee@example.com' } })
    assert.ok(invite)
    assert.equal(invite.email, 'invitee@example.com')
    assert.equal(invite.role, 'MEMBER')
    assert.equal(invite.consumedAt, null)
    assert.ok(invite.expiresAt > new Date())

    // Raw token must not appear as tokenHash
    assert.ok(invite.tokenHash.length === 64) // SHA-256 hex
  })

  it('stores SHA-256 hash of token, not the raw token', async () => {
    const admin = await createAdmin('admin2@example.com')
    await createInvite({ actorId: admin.id, email: 'hash-check@example.com', role: 'ADMIN' })

    const invite = await db.invite.findFirst({ where: { email: 'hash-check@example.com' } })
    assert.ok(invite)
    // tokenHash should be a 64-char hex string (SHA-256)
    assert.match(invite.tokenHash, /^[0-9a-f]{64}$/)
  })

  it('writes an invite_sent audit log entry', async () => {
    const admin = await createAdmin('admin3@example.com')
    await createInvite({ actorId: admin.id, email: 'audit@example.com', role: 'MEMBER' })

    const log = await db.auditLog.findFirst({ where: { actorId: admin.id, action: 'invite_sent' } })
    assert.ok(log)
    assert.equal(log.entityType, 'Invite')
  })

  it('sets expiresAt ~48 hours from now', async () => {
    const admin = await createAdmin('admin4@example.com')
    const before = Date.now()
    await createInvite({ actorId: admin.id, email: 'expiry@example.com', role: 'MEMBER' })
    const after = Date.now()

    const invite = await db.invite.findFirst({ where: { email: 'expiry@example.com' } })
    assert.ok(invite)

    const ms48h = 48 * 60 * 60 * 1000
    const expiresMs = invite.expiresAt.getTime()
    assert.ok(expiresMs >= before + ms48h - 1000)
    assert.ok(expiresMs <= after + ms48h + 1000)
  })

  it('throws InviteValidationError for invalid email', async () => {
    const admin = await createAdmin('admin5@example.com')
    await assert.rejects(
      () => createInvite({ actorId: admin.id, email: 'not-an-email', role: 'MEMBER' }),
      InviteValidationError
    )
  })

  it('throws InviteValidationError for invalid role', async () => {
    const admin = await createAdmin('admin6@example.com')
    await assert.rejects(
      () => createInvite({ actorId: admin.id, email: 'valid@example.com', role: 'SUPERUSER' }),
      InviteValidationError
    )
  })

  it('respects ALLOWED_EMAIL_DOMAIN', async () => {
    const prev = process.env.ALLOWED_EMAIL_DOMAIN
    process.env.ALLOWED_EMAIL_DOMAIN = 'allowed.com'
    try {
      const admin = await createAdmin('admin7@allowed.com')
      await assert.rejects(
        () => createInvite({ actorId: admin.id, email: 'user@other.com', role: 'MEMBER' }),
        InviteValidationError
      )
    } finally {
      if (prev === undefined) delete process.env.ALLOWED_EMAIL_DOMAIN
      else process.env.ALLOWED_EMAIL_DOMAIN = prev
    }
  })
})

describe('activateInvite', () => {
  it('creates user and active membership, marks invite consumed', async () => {
    const admin = await createAdmin('admin-act@example.com')
    await createInvite({ actorId: admin.id, email: 'newuser@example.com', role: 'MEMBER' })

    const invite = await db.invite.findFirst({ where: { email: 'newuser@example.com' } })
    assert.ok(invite)

    // Recover raw token via a known hash — we need to find it differently.
    // Instead, insert an invite with a known raw token.
    const { randomBytes, createHash } = await import('node:crypto')
    const rawToken = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(rawToken, 'utf8').digest('hex')
    await db.invite.create({
      data: {
        email: 'activate@example.com',
        role: 'MEMBER',
        tokenHash,
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
        createdById: admin.id
      }
    })

    await activateInvite({ rawToken, name: 'New User', password: 'SecurePass1!' })

    const user = await db.user.findUnique({ where: { email: 'activate@example.com' } })
    assert.ok(user)
    assert.equal(user.name, 'New User')

    const membership = await db.membership.findFirst({ where: { userId: user.id } })
    assert.ok(membership)
    assert.equal(membership.role, 'MEMBER')
    assert.equal(membership.status, 'ACTIVE')

    const consumed = await db.invite.findFirst({ where: { email: 'activate@example.com' } })
    assert.ok(consumed?.consumedAt)
  })

  it('writes account_activated audit log', async () => {
    const admin = await createAdmin('admin-audit@example.com')
    const { randomBytes, createHash } = await import('node:crypto')
    const rawToken = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(rawToken, 'utf8').digest('hex')
    await db.invite.create({
      data: {
        email: 'auditlog@example.com',
        role: 'MEMBER',
        tokenHash,
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
        createdById: admin.id
      }
    })

    await activateInvite({ rawToken, name: 'Audit User', password: 'SecurePass1!' })

    const user = await db.user.findUnique({ where: { email: 'auditlog@example.com' } })
    assert.ok(user)
    const log = await db.auditLog.findFirst({ where: { actorId: user.id, action: 'account_activated' } })
    assert.ok(log)
    assert.equal(log.entityType, 'Membership')
  })

  it('throws InvalidInviteTokenError for unknown token', async () => {
    await assert.rejects(
      () => activateInvite({ rawToken: 'totally-unknown-token', name: 'X', password: 'SecurePass1!' }),
      InvalidInviteTokenError
    )
  })

  it('throws InvalidInviteTokenError for expired token', async () => {
    const admin = await createAdmin('admin-exp@example.com')
    const { randomBytes, createHash } = await import('node:crypto')
    const rawToken = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(rawToken, 'utf8').digest('hex')
    await db.invite.create({
      data: {
        email: 'expired@example.com',
        role: 'MEMBER',
        tokenHash,
        expiresAt: new Date(Date.now() - 1000),
        createdById: admin.id
      }
    })

    await assert.rejects(
      () => activateInvite({ rawToken, name: 'X', password: 'SecurePass1!' }),
      InvalidInviteTokenError
    )
  })

  it('throws InvalidInviteTokenError for already-consumed token', async () => {
    const admin = await createAdmin('admin-cons@example.com')
    const { randomBytes, createHash } = await import('node:crypto')
    const rawToken = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(rawToken, 'utf8').digest('hex')
    await db.invite.create({
      data: {
        email: 'consumed@example.com',
        role: 'MEMBER',
        tokenHash,
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
        consumedAt: new Date(),
        createdById: admin.id
      }
    })

    await assert.rejects(
      () => activateInvite({ rawToken, name: 'X', password: 'SecurePass1!' }),
      InvalidInviteTokenError
    )
  })

  it('throws InvalidInviteTokenError for non-string token', async () => {
    await assert.rejects(
      () => activateInvite({ rawToken: null, name: 'X', password: 'SecurePass1!' }),
      InvalidInviteTokenError
    )
  })

  it('throws InviteValidationError when name is empty', async () => {
    const admin = await createAdmin('admin-noname@example.com')
    const { randomBytes, createHash } = await import('node:crypto')
    const rawToken = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(rawToken, 'utf8').digest('hex')
    await db.invite.create({
      data: {
        email: 'noname@example.com',
        role: 'MEMBER',
        tokenHash,
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
        createdById: admin.id
      }
    })

    await assert.rejects(
      () => activateInvite({ rawToken, name: '   ', password: 'SecurePass1!' }),
      InviteValidationError
    )
  })

  it('does not create user or membership for invalid token', async () => {
    const countBefore = await db.user.count()
    await activateInvite({ rawToken: 'bad-token', name: 'X', password: 'SecurePass1!' }).catch(() => {})
    const countAfter = await db.user.count()
    assert.equal(countAfter, countBefore)
  })
})

describe('hashInviteToken', () => {
  it('produces a 64-char hex SHA-256 hash', () => {
    const hash = hashInviteToken('some-raw-token')
    assert.match(hash, /^[0-9a-f]{64}$/)
  })

  it('is deterministic', () => {
    assert.equal(hashInviteToken('abc'), hashInviteToken('abc'))
  })

  it('different inputs produce different hashes', () => {
    assert.notEqual(hashInviteToken('a'), hashInviteToken('b'))
  })
})
