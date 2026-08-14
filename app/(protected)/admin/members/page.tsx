import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/auth/authorization'
import { UnauthorizedError, ForbiddenError } from '@/lib/auth/errors'
import { db } from '@/lib/db'
import { InviteForm } from './invite-form'
import { MemberActions } from './member-actions'

export default async function AdminMembersPage() {
  let principal: Awaited<ReturnType<typeof requireAdmin>>
  try {
    principal = await requireAdmin()
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect('/login')
    if (err instanceof ForbiddenError) redirect('/')
    throw err
  }

  const memberships = await db.membership.findMany({
    where: { teamId: principal.teamId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }]
  })

  return (
    <div className='mx-auto max-w-3xl px-4 py-8'>
      <h1 className='mb-6 text-xl font-semibold'>Team members</h1>

      <section className='mb-8'>
        <h2 className='mb-3 text-sm font-medium text-zinc-500 uppercase tracking-wide'>Invite new member</h2>
        <InviteForm />
      </section>

      <section>
        <h2 className='mb-3 text-sm font-medium text-zinc-500 uppercase tracking-wide'>
          Members ({memberships.length})
        </h2>
        <div className='divide-y rounded-lg border'>
          {memberships.map((m) => (
            <div
              key={m.id}
              className='flex items-center justify-between px-4 py-3'>
              <div>
                <p className='text-sm font-medium'>{m.user.name ?? m.user.email}</p>
                <p className='text-xs text-zinc-500'>{m.user.email}</p>
                <div className='mt-1 flex gap-2'>
                  <span className='rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600'>{m.role}</span>
                  {m.status === 'SUSPENDED' && (
                    <span className='rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700'>
                      SUSPENDED
                    </span>
                  )}
                </div>
              </div>
              <MemberActions
                userId={m.user.id}
                role={m.role}
                status={m.status}
                isSelf={m.user.id === principal.userId}
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
