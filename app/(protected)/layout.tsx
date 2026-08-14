import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { requireActiveMember } from '@/lib/auth/authorization'
import { UnauthorizedError, ForbiddenError } from '@/lib/auth/errors'

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  try {
    const principal = await requireActiveMember({ allowPasswordChange: true })
    if (principal.mustChangePassword) {
      redirect('/change-password')
    }
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      redirect('/login')
    }
    if (err instanceof ForbiddenError) {
      redirect('/change-password')
    }
    throw err
  }

  return <>{children}</>
}
