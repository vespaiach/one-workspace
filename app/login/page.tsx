import { redirect } from 'next/navigation'
import { getSessionPrincipal } from '@/lib/auth/authorization'
import { LoginForm } from './login-form'

type Props = { searchParams: Promise<{ returnTo?: string }> }

export default async function LoginPage({ searchParams }: Props) {
  const principal = await getSessionPrincipal()
  if (principal) {
    redirect(principal.mustChangePassword ? '/change-password' : '/')
  }

  const { returnTo } = await searchParams

  return (
    <div className='flex min-h-full flex-col items-center justify-center bg-zinc-50 px-4'>
      <div className='w-full max-w-sm rounded-lg border bg-white p-8 shadow-sm'>
        <h1 className='mb-6 text-xl font-semibold'>Sign in</h1>
        <LoginForm returnTo={returnTo} />
      </div>
    </div>
  )
}
