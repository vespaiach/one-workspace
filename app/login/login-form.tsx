'use client'
import { useActionState } from 'react'
import { Button } from 'react-aria-components'
import { loginAction, type LoginState } from './actions'

const initialState: LoginState = { error: null }

export function LoginForm({ returnTo }: { returnTo?: string }) {
  const [state, action, isPending] = useActionState(loginAction, initialState)

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

      {returnTo && (
        <input
          type='hidden'
          name='returnTo'
          value={returnTo}
        />
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
          autoComplete='current-password'
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
        {isPending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}
