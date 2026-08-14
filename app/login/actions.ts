'use server'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { authenticateAndCreateSession } from '@/lib/auth/login'
import { InvalidCredentialsError, RateLimitError } from '@/lib/auth/errors'

export type LoginState = { error: string | null }

function sanitizeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string') return '/'
  const trimmed = raw.trim()
  // Must be a relative path starting with exactly one /
  if (!/^\/[^/]/.test(trimmed) && trimmed !== '/') return '/'
  // Reject login and change-password destinations
  if (trimmed === '/login' || trimmed.startsWith('/login?')) return '/'
  if (trimmed === '/change-password' || trimmed.startsWith('/change-password?')) return '/'
  return trimmed
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = formData.get('email')
  const password = formData.get('password')
  const returnTo = sanitizeReturnTo(formData.get('returnTo'))

  const requestHeaders = await headers()

  let mustChangePassword: boolean
  try {
    const result = await authenticateAndCreateSession({
      email,
      password,
      headers: requestHeaders
    })
    mustChangePassword = result.mustChangePassword
  } catch (err) {
    if (err instanceof InvalidCredentialsError || err instanceof RateLimitError) {
      return { error: 'Invalid credentials' }
    }
    return { error: 'Sign-in temporarily unavailable' }
  }

  redirect(mustChangePassword ? '/change-password' : returnTo)
}
