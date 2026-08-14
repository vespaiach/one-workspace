'use client'
import { useActionState } from 'react'
import { Button } from 'react-aria-components'
import { resetPasswordAction, type ResetPasswordState } from './actions'

const initialState: ResetPasswordState = { error: null }

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, isPending] = useActionState(resetPasswordAction, initialState)

  return (
    <form
      action={action}
      className='flex flex-col gap-4'>
      <input
        type='hidden'
        name='token'
        value={token}
      />

      {state.error && (
        <p
          role='alert'
          className='text-sm text-red-600'>
          {state.error}
        </p>
      )}

      <div className='flex flex-col gap-1'>
        <label
          htmlFor='newPassword'
          className='text-sm font-medium'>
          New password
        </label>
        <input
          id='newPassword'
          name='newPassword'
          type='password'
          autoComplete='new-password'
          required
          minLength={8}
          maxLength={128}
          className='rounded border px-3 py-2 text-sm'
        />
      </div>

      <div className='flex flex-col gap-1'>
        <label
          htmlFor='confirmPassword'
          className='text-sm font-medium'>
          Confirm password
        </label>
        <input
          id='confirmPassword'
          name='confirmPassword'
          type='password'
          autoComplete='new-password'
          required
          minLength={8}
          maxLength={128}
          className='rounded border px-3 py-2 text-sm'
        />
      </div>

      <Button
        type='submit'
        isDisabled={isPending}
        className='rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50'>
        {isPending ? 'Saving…' : 'Reset password'}
      </Button>
    </form>
  )
}
