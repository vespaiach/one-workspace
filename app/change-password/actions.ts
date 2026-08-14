'use server'
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { requireActiveMember } from '@/lib/auth/authorization'
import { parsePassword, hashPassword } from '@/lib/auth/password'
import { deleteCurrentSession } from '@/lib/auth/session'
import { StalePasswordChangeError } from '@/lib/auth/errors'

export type ChangePasswordState = { error: string | null }

export async function changePasswordAction(
  _prev: ChangePasswordState,
  formData: FormData
): Promise<ChangePasswordState> {
  const principal = await requireActiveMember({ allowPasswordChange: true }).catch(() => redirect('/login'))

  const newPasswordResult = parsePassword(formData.get('newPassword'))
  if (!newPasswordResult.ok) {
    return { error: 'Password must be 8–128 characters' }
  }

  const confirm = formData.get('confirmPassword')
  if (typeof confirm !== 'string' || confirm !== newPasswordResult.password) {
    return { error: 'Passwords do not match' }
  }

  const newHash = await hashPassword(newPasswordResult.password)

  try {
    await db.$transaction(async (tx) => {
      const result = await tx.user.updateMany({
        where: { id: principal.userId, mustChangePassword: true },
        data: { passwordHash: newHash, mustChangePassword: false }
      })
      if (result.count !== 1) throw new StalePasswordChangeError()
      await tx.session.deleteMany({ where: { userId: principal.userId } })
    })
  } catch (err) {
    if (err instanceof StalePasswordChangeError) {
      return { error: 'Password was already changed. Please sign in again.' }
    }
    return { error: 'Something went wrong. Please try again.' }
  }

  await deleteCurrentSession()
  redirect('/login?passwordChanged=1')
}

export async function logoutAction(): Promise<void> {
  await deleteCurrentSession()
  redirect('/login')
}
