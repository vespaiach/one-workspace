'use server'
import { redirect } from 'next/navigation'
import { activateInvite } from '@/lib/members/invite'
import { parsePassword } from '@/lib/auth/password'
import { InvalidInviteTokenError, InviteValidationError } from '@/lib/auth/errors'

export type SignupState = { error: string | null }

export async function signupAction(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const rawToken = formData.get('token')
  const name = formData.get('name')
  const passwordResult = parsePassword(formData.get('password'))
  const confirm = formData.get('confirmPassword')

  if (!passwordResult.ok) {
    return { error: 'Password must be 8–128 characters' }
  }
  if (typeof confirm !== 'string' || confirm !== passwordResult.password) {
    return { error: 'Passwords do not match' }
  }

  try {
    await activateInvite({ rawToken, name, password: passwordResult.password })
  } catch (err) {
    if (err instanceof InvalidInviteTokenError) {
      return { error: 'This invitation link is invalid, expired, or has already been used.' }
    }
    if (err instanceof InviteValidationError) {
      return { error: err.message }
    }
    return { error: 'Something went wrong. Please try again.' }
  }

  redirect('/login?passwordChanged=0&invited=1')
}
