import { db } from '@/lib/db'
import { hashInviteToken } from '@/lib/members/invite'
import { SignupForm } from './signup-form'

type Props = { searchParams: Promise<{ token?: string }> }

export default async function SignupPage({ searchParams }: Props) {
  const { token } = await searchParams

  if (!token) {
    return <InvalidToken />
  }

  const tokenHash = hashInviteToken(token)
  const invite = await db.invite.findUnique({ where: { tokenHash } })
  const isValid = invite && !invite.consumedAt && invite.expiresAt > new Date()

  if (!isValid) {
    return <InvalidToken />
  }

  return (
    <div className='flex min-h-full flex-col items-center justify-center bg-zinc-50 px-4'>
      <div className='w-full max-w-sm rounded-lg border bg-white p-8 shadow-sm'>
        <h1 className='mb-2 text-xl font-semibold'>Create your account</h1>
        <p className='mb-6 text-sm text-zinc-500'>
          You&apos;ve been invited as a <strong>{invite.role.toLowerCase()}</strong>.
        </p>
        <SignupForm token={token} />
      </div>
    </div>
  )
}

function InvalidToken() {
  return (
    <div className='flex min-h-full flex-col items-center justify-center bg-zinc-50 px-4'>
      <div className='w-full max-w-sm rounded-lg border bg-white p-8 shadow-sm text-center'>
        <h1 className='mb-3 text-xl font-semibold'>Invalid invitation</h1>
        <p className='text-sm text-zinc-500'>
          This invitation link is invalid, expired, or has already been used. Please ask an admin to send a
          new invite.
        </p>
      </div>
    </div>
  )
}
