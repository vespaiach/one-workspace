import { redirect } from 'next/navigation'
import { requireActiveMember } from '@/lib/auth/authorization'
import { UnauthorizedError } from '@/lib/auth/errors'
import { ChangePasswordForm } from './change-password-form'

export default async function ChangePasswordPage() {
  let mustChangePassword: boolean
  try {
    const principal = await requireActiveMember({ allowPasswordChange: true })
    mustChangePassword = principal.mustChangePassword
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect('/login')
    throw err
  }

  if (!mustChangePassword) redirect('/')

  return (
    <div className='flex min-h-full flex-col items-center justify-center bg-zinc-50 px-4'>
      <div className='w-full max-w-sm rounded-lg border bg-white p-8 shadow-sm'>
        <h1 className='mb-2 text-xl font-semibold'>Change your password</h1>
        <p className='mb-6 text-sm text-zinc-600'>You must set a new password before continuing.</p>
        <ChangePasswordForm />
      </div>
    </div>
  )
}
