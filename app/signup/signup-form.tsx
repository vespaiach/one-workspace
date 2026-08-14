'use client'
import { useActionState } from 'react'
import { Button } from 'react-aria-components'
import { signupAction, type SignupState } from './actions'

const initialState: SignupState = { error: null }

export function SignupForm({ token }: { token: string }) {
  const [state, action, isPending] = useActionState(signupAction, initialState)

  return (
    <form
      action={action}
      className='flex flex-col gap-4'>
      {state.error && (
        <p
          role='alert'
          className='text-sm text-red-600'>
          {state.error}
        </p>
      )}

      <input
        type='hidden'
        name='token'
        value={token}
      />

      <div className='flex flex-col gap-1'>
        <label
          htmlFor='name'
          className='text-sm font-medium'>
          Full name
        </label>
        <input
          id='name'
          name='name'
          type='text'
          autoComplete='name'
          required
          maxLength={100}
          className='rounded border px-3 py-2 text-sm'
        />
      </div>

      <div className='flex flex-col gap-1'>
        <label
          htmlFor='password'
          className='text-sm font-medium'>
          Password
        </label>
        <input
          id='password'
          name='password'
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
        {isPending ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  )
}
