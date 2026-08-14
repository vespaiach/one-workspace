'use server'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { requireAdmin } from '@/lib/auth/authorization'
import { getTrustedClientIp } from '@/lib/auth/client-ip'
import { RateLimitError, LastAdminError, InviteValidationError } from '@/lib/auth/errors'
import { checkInviteRateLimit } from '@/lib/members/invite-rate-limit'
import { createInvite } from '@/lib/members/invite'
import { suspendMember, removeMember, changeMemberRole } from '@/lib/members/lifecycle'

export type ActionState = { error: string | null; success?: boolean }

export async function inviteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const principal = await requireAdmin().catch(() => ({ error: 'Unauthorized' }) as ActionState)
  if ('error' in principal && typeof principal.error === 'string') return principal as ActionState

  const requestHeaders = await headers()
  const ip = getTrustedClientIp(requestHeaders as Headers)
  if (!checkInviteRateLimit(ip)) {
    return { error: 'Too many invitations sent. Please wait and try again.' }
  }

  try {
    await createInvite({
      actorId: (principal as Awaited<ReturnType<typeof requireAdmin>>).userId,
      email: formData.get('email'),
      role: formData.get('role')
    })
  } catch (err) {
    if (err instanceof InviteValidationError) return { error: err.message }
    if (err instanceof RateLimitError)
      return { error: 'Too many invitations sent. Please wait and try again.' }
    return { error: 'Failed to send invitation. Please try again.' }
  }

  revalidatePath('/admin/members')
  return { error: null, success: true }
}

export async function suspendAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const principal = await requireAdmin().catch(() => null)
  if (!principal) return { error: 'Unauthorized' }

  const targetUserId = formData.get('userId')
  if (typeof targetUserId !== 'string') return { error: 'Invalid request' }

  try {
    await suspendMember({ actorId: principal.userId, targetUserId, teamId: principal.teamId })
  } catch (err) {
    if (err instanceof LastAdminError) return { error: err.message }
    return { error: 'Failed to suspend member.' }
  }

  revalidatePath('/admin/members')
  return { error: null, success: true }
}

export async function removeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const principal = await requireAdmin().catch(() => null)
  if (!principal) return { error: 'Unauthorized' }

  const targetUserId = formData.get('userId')
  if (typeof targetUserId !== 'string') return { error: 'Invalid request' }

  try {
    await removeMember({ actorId: principal.userId, targetUserId, teamId: principal.teamId })
  } catch (err) {
    if (err instanceof LastAdminError) return { error: err.message }
    return { error: 'Failed to remove member.' }
  }

  revalidatePath('/admin/members')
  return { error: null, success: true }
}

export async function changeRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const principal = await requireAdmin().catch(() => null)
  if (!principal) return { error: 'Unauthorized' }

  const targetUserId = formData.get('userId')
  const newRole = formData.get('role')
  if (typeof targetUserId !== 'string') return { error: 'Invalid request' }
  if (newRole !== 'ADMIN' && newRole !== 'MEMBER') return { error: 'Invalid role' }

  try {
    await changeMemberRole({ actorId: principal.userId, targetUserId, teamId: principal.teamId, newRole })
  } catch (err) {
    if (err instanceof LastAdminError) return { error: err.message }
    return { error: 'Failed to change role.' }
  }

  revalidatePath('/admin/members')
  return { error: null, success: true }
}
