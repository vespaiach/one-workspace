'use client'
import { useActionState } from 'react'
import { Button } from 'react-aria-components'
import { inviteAction, type ActionState } from './actions'

const initialState: ActionState = { error: null }

export function InviteForm() {
  const [state, action, isPending] = useActionState(inviteAction, initialState)

  return (
    <form
      action={action}
      className='flex flex-col gap-3'>
      {state.error && (
        <p
          role='alert'
          className='text-sm text-red-600'>
          {state.error}
        </p>
      )}
      {state.success && (
        <p
          role='status'
          className='text-sm text-green-700'>
          Invitation sent.
        </p>
      )}

      <div className='flex gap-2'>
        <input
          name='email'
          type='email'
          placeholder='Email address'
          required
          maxLength={254}
          className='flex-1 rounded border px-3 py-2 text-sm'
        />
        <select
          name='role'
          className='rounded border px-3 py-2 text-sm'>
          <option value='MEMBER'>Member</option>
          <option value='ADMIN'>Admin</option>
        </select>
        <Button
          type='submit'
          isDisabled={isPending}
          className='rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50'>
          {isPending ? 'Sending…' : 'Invite'}
        </Button>
      </div>
    </form>
  )
}
