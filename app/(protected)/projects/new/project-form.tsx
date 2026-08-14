'use client'
import { useActionState } from 'react'
import Link from 'next/link'
import { Button } from 'react-aria-components'
import { createProjectAction, type ProjectFormState } from '../actions'

const initial: ProjectFormState = { error: null }

export function ProjectForm() {
  const [state, action, isPending] = useActionState(createProjectAction, initial)

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

      <div className='flex flex-col gap-1'>
        <label
          htmlFor='name'
          className='text-sm font-medium'>
          Name
        </label>
        <input
          id='name'
          name='name'
          type='text'
          required
          className='rounded border px-3 py-2 text-sm'
        />
      </div>

      <div className='flex flex-col gap-1'>
        <label
          htmlFor='key'
          className='text-sm font-medium'>
          Key
        </label>
        <input
          id='key'
          name='key'
          type='text'
          required
          maxLength={10}
          placeholder='e.g. ENG'
          className='rounded border px-3 py-2 font-mono text-sm uppercase'
        />
        <p className='text-xs text-zinc-500'>2–10 uppercase letters/digits; immutable after creation</p>
      </div>

      <div className='flex flex-col gap-1'>
        <label
          htmlFor='description'
          className='text-sm font-medium'>
          Description <span className='font-normal text-zinc-400'>(optional)</span>
        </label>
        <textarea
          id='description'
          name='description'
          rows={3}
          className='resize-none rounded border px-3 py-2 text-sm'
        />
      </div>

      <div className='flex gap-2'>
        <Button
          type='submit'
          isDisabled={isPending}
          className='rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50'>
          {isPending ? 'Creating…' : 'Create project'}
        </Button>
        <Link
          href='/projects'
          className='rounded px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100'>
          Cancel
        </Link>
      </div>
    </form>
  )
}
