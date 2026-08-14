import { redirect } from 'next/navigation'
import { requireActiveMember } from '@/lib/auth/authorization'
import { UnauthorizedError } from '@/lib/auth/errors'
import { ProjectForm } from './project-form'

export default async function NewProjectPage() {
  try {
    await requireActiveMember()
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect('/login')
    throw err
  }

  return (
    <div className='mx-auto max-w-lg px-4 py-10'>
      <h1 className='mb-6 text-2xl font-semibold'>New project</h1>
      <ProjectForm />
    </div>
  )
}
