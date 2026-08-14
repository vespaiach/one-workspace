'use server'
import { headers } from 'next/headers'
import {
  FORGOT_PASSWORD_MESSAGE,
  requestPasswordReset
} from '@/lib/auth/password-reset'

export type ForgotPasswordState = { message: string | null }

export async function forgotPasswordAction(
  _previous: ForgotPasswordState,
  formData: FormData
): Promise<ForgotPasswordState> {
  const requestHeaders = await headers()
  await requestPasswordReset({ email: formData.get('email'), headers: requestHeaders })

  return { message: FORGOT_PASSWORD_MESSAGE }
}
