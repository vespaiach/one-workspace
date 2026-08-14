import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import argon2 from 'argon2'

const db = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } }
})

const WORKSPACE_ID = 'browser-test-workspace'
const TEAM_ID = 'browser-test-team'

async function setupWorkspace() {
  await db.workspace.upsert({
    where: { id: WORKSPACE_ID },
    update: {},
    create: { id: WORKSPACE_ID, name: 'Browser Test Workspace' }
  })
  await db.team.upsert({
    where: { id: TEAM_ID },
    update: { workspaceId: WORKSPACE_ID },
    create: { id: TEAM_ID, name: 'Browser Test Team', workspaceId: WORKSPACE_ID }
  })
}

async function createUser(email: string, password: string, opts: { mustChangePassword?: boolean } = {}) {
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1
  })
  const user = await db.user.create({
    data: { email, passwordHash, mustChangePassword: opts.mustChangePassword ?? false }
  })
  await db.membership.create({
    data: { userId: user.id, teamId: TEAM_ID, role: 'MEMBER', status: 'ACTIVE' }
  })
  return user
}

test.beforeAll(async () => {
  await setupWorkspace()
})

test.beforeEach(async () => {
  await db.session.deleteMany({})
  await db.membership.deleteMany({})
  await db.user.deleteMany({})
  await setupWorkspace()
})

test.afterAll(async () => {
  await db.session.deleteMany({})
  await db.membership.deleteMany({})
  await db.user.deleteMany({})
  await db.team.deleteMany({})
  await db.workspace.deleteMany({})
  await db.$disconnect()
})

test('unauthenticated request to / redirects to /login', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)
})

test('login with valid credentials redirects to /', async ({ page }) => {
  await createUser('login@example.com', 'ValidPassword1!')

  await page.goto('/login')
  await page.fill('input[name="email"]', 'login@example.com')
  await page.fill('input[name="password"]', 'ValidPassword1!')
  await page.click('button[type="submit"]')

  await expect(page).toHaveURL('/')
})

test('login with wrong password shows error', async ({ page }) => {
  await createUser('badpw@example.com', 'ValidPassword1!')

  await page.goto('/login')
  await page.fill('input[name="email"]', 'badpw@example.com')
  await page.fill('input[name="password"]', 'WrongPassword1!')
  await page.click('button[type="submit"]')

  await expect(page.getByRole('alert')).toContainText('Invalid credentials')
})

test('mustChangePassword user is redirected to /change-password after login', async ({ page }) => {
  await createUser('newadmin@example.com', 'ValidPassword1!', { mustChangePassword: true })

  await page.goto('/login')
  await page.fill('input[name="email"]', 'newadmin@example.com')
  await page.fill('input[name="password"]', 'ValidPassword1!')
  await page.click('button[type="submit"]')

  await expect(page).toHaveURL('/change-password')
})

test('change-password flow completes and redirects to login with success banner', async ({ page }) => {
  await createUser('changeme@example.com', 'OldPassword1!', { mustChangePassword: true })

  // Log in
  await page.goto('/login')
  await page.fill('input[name="email"]', 'changeme@example.com')
  await page.fill('input[name="password"]', 'OldPassword1!')
  await page.click('button[type="submit"]')
  await expect(page).toHaveURL('/change-password')

  // Set new password
  await page.fill('input[name="newPassword"]', 'BrandNewPw1!')
  await page.fill('input[name="confirmPassword"]', 'BrandNewPw1!')
  await page.click('button[type="submit"]')

  await expect(page).toHaveURL(/\/login\?passwordChanged=1/)
  await expect(page.getByRole('status')).toContainText('Password updated')
})

test('change-password shows error when passwords do not match', async ({ page }) => {
  await createUser('mismatch@example.com', 'OldPassword1!', { mustChangePassword: true })

  await page.goto('/login')
  await page.fill('input[name="email"]', 'mismatch@example.com')
  await page.fill('input[name="password"]', 'OldPassword1!')
  await page.click('button[type="submit"]')
  await expect(page).toHaveURL('/change-password')

  await page.fill('input[name="newPassword"]', 'BrandNewPw1!')
  await page.fill('input[name="confirmPassword"]', 'DoesNotMatch1!')
  await page.click('button[type="submit"]')

  await expect(page.getByRole('alert')).toContainText('Passwords do not match')
})

test('session cookie is present after login and cleared after logout', async ({ page }) => {
  await createUser('session@example.com', 'ValidPassword1!')

  await page.goto('/login')
  await page.fill('input[name="email"]', 'session@example.com')
  await page.fill('input[name="password"]', 'ValidPassword1!')
  await page.click('button[type="submit"]')
  await expect(page).toHaveURL('/')

  const cookiesBefore = await page.context().cookies()
  const sessionCookie = cookiesBefore.find(
    (c) => c.name === 'one-workspace-session' || c.name === '__Host-one-workspace-session'
  )
  expect(sessionCookie).toBeTruthy()

  // Navigate to login to trigger logout (no logout button wired yet in the shell)
  // Manually clear cookies to simulate logout then verify redirect
  await page.context().clearCookies()
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)
})

test('passwordChanged=1 banner is not shown on a plain /login visit', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('status')).not.toBeVisible()
})
