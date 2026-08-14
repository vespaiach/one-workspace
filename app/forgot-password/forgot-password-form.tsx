'use client'
import { useActionState } from 'react'
import { Button } from 'react-aria-components'
import { forgotPasswordAction, type ForgotPasswordState } from './actions'

const initialState: ForgotPasswordState = { message: null }

export function ForgotPasswordForm() {
  const [state, action, isPending] = useActionState(forgotPasswordAction, initialState)

  return (
    <form
      action={action}
      className='flex flex-col gap-4'>
      {state.message && (
        <p
          role='status'
          className='rounded bg-green-50 px-3 py-2 text-sm text-green-700'>
          {state.message}
        </p>
      )}

      <div className='flex flex-col gap-1'>
        <label
          htmlFor='email'
          className='text-sm font-medium'>
          Email
        </label>
        <input
          id='email'
          name='email'
          type='email'
          autoComplete='email'
          required
          maxLength={254}
          className='rounded border px-3 py-2 text-sm'
        />
      </div>

      <Button
        type='submit'
        isDisabled={isPending}
        className='rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50'>
        {isPending ? 'Sending…' : 'Send reset link'}
      </Button>
    </form>
  )
}
