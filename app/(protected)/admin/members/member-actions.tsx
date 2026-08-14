'use client'
import { useActionState } from 'react'
import { Button } from 'react-aria-components'
import { suspendAction, removeAction, changeRoleAction, type ActionState } from './actions'

const initialState: ActionState = { error: null }

type MemberActionsProps = {
  userId: string
  role: 'ADMIN' | 'MEMBER'
  status: 'ACTIVE' | 'SUSPENDED'
  isSelf: boolean
}

export function MemberActions({ userId, role, status, isSelf }: MemberActionsProps) {
  const [suspendState, suspendFormAction, suspendPending] = useActionState(suspendAction, initialState)
  const [removeState, removeFormAction, removePending] = useActionState(removeAction, initialState)
  const [roleState, roleFormAction, rolePending] = useActionState(changeRoleAction, initialState)

  const error = suspendState.error ?? removeState.error ?? roleState.error

  return (
    <div className='flex flex-col gap-1'>
      {error && (
        <p
          role='alert'
          className='text-xs text-red-600'>
          {error}
        </p>
      )}
      <div className='flex gap-2'>
        {status === 'ACTIVE' && !isSelf && (
          <form action={suspendFormAction}>
            <input
              type='hidden'
              name='userId'
              value={userId}
            />
            <Button
              type='submit'
              isDisabled={suspendPending}
              className='rounded border px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50'>
              Suspend
            </Button>
          </form>
        )}

        {!isSelf && (
          <form action={removeFormAction}>
            <input
              type='hidden'
              name='userId'
              value={userId}
            />
            <Button
              type='submit'
              isDisabled={removePending}
              className='rounded border px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50'>
              Remove
            </Button>
          </form>
        )}

        {!isSelf && (
          <form action={roleFormAction}>
            <input
              type='hidden'
              name='userId'
              value={userId}
            />
            <input
              type='hidden'
              name='role'
              value={role === 'ADMIN' ? 'MEMBER' : 'ADMIN'}
            />
            <Button
              type='submit'
              isDisabled={rolePending}
              className='rounded border px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50'>
              Make {role === 'ADMIN' ? 'Member' : 'Admin'}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
