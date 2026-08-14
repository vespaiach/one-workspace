import Link from 'next/link'
import { isPasswordResetTokenValid } from '@/lib/auth/password-reset'
import { ResetPasswordForm } from './reset-password-form'

type Props = {
  searchParams: Promise<{ token?: string | string[] }>
}

export default async function ResetPasswordPage({ searchParams }: Props) {
  const tokenParam = (await searchParams).token
  const token = typeof tokenParam === 'string' ? tokenParam : ''
  const valid = await isPasswordResetTokenValid(token)

  return (
    <div className='flex min-h-full flex-col items-center justify-center bg-zinc-50 px-4'>
      <div className='w-full max-w-sm rounded-lg border bg-white p-8 shadow-sm'>
        <h1 className='mb-2 text-xl font-semibold'>Reset your password</h1>
        {valid ? (
          <>
            <p className='mb-6 text-sm text-zinc-600'>Choose a new password for your account.</p>
            <ResetPasswordForm token={token} />
          </>
        ) : (
          <>
            <p
              role='alert'
              className='mb-4 text-sm text-red-600'>
              This password reset link is invalid, expired, or already used.
            </p>
            <Link
              href='/forgot-password'
              className='text-sm text-zinc-600 underline'>
              Request a new reset link
            </Link>
          </>
        )}
      </div>
    </div>
  )
}
