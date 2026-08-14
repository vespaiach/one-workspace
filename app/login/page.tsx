import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSessionPrincipal } from '@/lib/auth/authorization'
import { LoginForm } from './login-form'

type Props = {
  searchParams: Promise<{ returnTo?: string; passwordChanged?: string; passwordReset?: string }>
}

export default async function LoginPage({ searchParams }: Props) {
  const principal = await getSessionPrincipal()
  if (principal) {
    redirect(principal.mustChangePassword ? '/change-password' : '/')
  }

  const { returnTo, passwordChanged, passwordReset } = await searchParams

  return (
    <div className='flex min-h-full flex-col items-center justify-center bg-zinc-50 px-4'>
      <div className='w-full max-w-sm rounded-lg border bg-white p-8 shadow-sm'>
        <h1 className='mb-6 text-xl font-semibold'>Sign in</h1>
        {passwordChanged === '1' && (
          <p
            role='status'
            className='mb-4 rounded bg-green-50 px-3 py-2 text-sm text-green-700'>
            Password updated. Please sign in with your new password.
          </p>
        )}
        {passwordReset === '1' && (
          <p
            role='status'
            className='mb-4 rounded bg-green-50 px-3 py-2 text-sm text-green-700'>
            Password reset. Please sign in with your new password.
          </p>
        )}
        <LoginForm returnTo={returnTo} />
        <Link
          href='/forgot-password'
          className='mt-4 block text-center text-sm text-zinc-600 underline'>
          Forgot your password?
        </Link>
      </div>
    </div>
  )
}
