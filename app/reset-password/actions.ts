'use server'
import { redirect } from 'next/navigation'
import { parsePassword } from '@/lib/auth/password'
import { resetPasswordWithToken } from '@/lib/auth/password-reset'

export type ResetPasswordState = { error: string | null }

const INVALID_TOKEN_MESSAGE = 'This password reset link is invalid, expired, or already used.'

export async function resetPasswordAction(
  _previous: ResetPasswordState,
  formData: FormData
): Promise<ResetPasswordState> {
  const passwordResult = parsePassword(formData.get('newPassword'))
  if (!passwordResult.ok) {
    return { error: 'Password must be 8–128 characters' }
  }

  const confirmation = formData.get('confirmPassword')
  if (typeof confirmation !== 'string' || confirmation !== passwordResult.password) {
    return { error: 'Passwords do not match' }
  }

  try {
    const result = await resetPasswordWithToken(formData.get('token'), passwordResult.password)
    if (result === 'invalid') return { error: INVALID_TOKEN_MESSAGE }
  } catch {
    return { error: 'Something went wrong. Please try again.' }
  }

  redirect('/login?passwordReset=1')
}
