import Link from 'next/link'
import { ForgotPasswordForm } from './forgot-password-form'

export default function ForgotPasswordPage() {
  return (
    <div className='flex min-h-full flex-col items-center justify-center bg-zinc-50 px-4'>
      <div className='w-full max-w-sm rounded-lg border bg-white p-8 shadow-sm'>
        <h1 className='mb-2 text-xl font-semibold'>Forgot your password?</h1>
        <p className='mb-6 text-sm text-zinc-600'>Enter your email and we’ll send you a reset link.</p>
        <ForgotPasswordForm />
        <Link
          href='/login'
          className='mt-4 block text-center text-sm text-zinc-600 underline'>
          Back to sign in
        </Link>
      </div>
    </div>
  )
}
