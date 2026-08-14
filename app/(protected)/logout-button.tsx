'use client'
import { Button } from 'react-aria-components'
import { logoutAction } from '@/app/change-password/actions'

export function LogoutButton() {
  return (
    <form action={logoutAction}>
      <Button
        type='submit'
        className='text-sm text-zinc-500 hover:text-zinc-900'>
        Sign out
      </Button>
    </form>
  )
}
