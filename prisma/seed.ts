import { db } from '../lib/db'
import { logger } from '../lib/logger'
import { isAllowedEmailDomain, normalizeEmail } from '../lib/auth/email'
import { hashPassword } from '../lib/auth/password'

const WORKSPACE_ID = 'primary-workspace'
const TEAM_ID = 'primary-team'

async function main() {
  const activeAdmin = await db.membership.findFirst({
    where: { teamId: TEAM_ID, role: 'ADMIN', status: 'ACTIVE' },
    select: { id: true }
  })

  if (activeAdmin) {
    logger.info('Seed already applied; active admin exists')
    return
  }

  const rawEmail = process.env.BOOTSTRAP_ADMIN_EMAIL
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD

  if (!rawEmail || !password) {
    throw new Error('Bootstrap credentials are required only when no active admin exists')
  }

  const emailResult = normalizeEmail(rawEmail)
  if (!emailResult.ok) {
    throw new Error('BOOTSTRAP_ADMIN_EMAIL is not a valid email address')
  }

  if (!isAllowedEmailDomain(emailResult.email)) {
    throw new Error('BOOTSTRAP_ADMIN_EMAIL domain is not permitted by ALLOWED_EMAIL_DOMAIN')
  }

  const email = emailResult.email
  const passwordHash = await hashPassword(password)

  const result = await db.$transaction(async (tx) => {
    const workspace = await tx.workspace.upsert({
      where: { id: WORKSPACE_ID },
      update: {},
      create: { id: WORKSPACE_ID, name: 'One Workspace' }
    })

    const team = await tx.team.upsert({
      where: { id: TEAM_ID },
      update: { workspaceId: workspace.id },
      create: { id: TEAM_ID, name: 'Team', workspaceId: workspace.id }
    })

    const user = await tx.user.upsert({
      where: { email },
      update: {},
      create: { email, name: 'Admin', passwordHash, mustChangePassword: true }
    })

    const membership = await tx.membership.upsert({
      where: { userId_teamId: { userId: user.id, teamId: team.id } },
      update: { role: 'ADMIN', status: 'ACTIVE' },
      create: { userId: user.id, teamId: team.id, role: 'ADMIN', status: 'ACTIVE' }
    })

    return { workspaceId: workspace.id, teamId: team.id, userId: user.id, membershipId: membership.id }
  })

  logger.info('Bootstrap seed applied', result)
}

main()
  .catch((error: unknown) => {
    logger.error('Seed failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect()
  })
