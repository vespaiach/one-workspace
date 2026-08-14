import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireActiveMember } from '@/lib/auth/authorization'
import { UnauthorizedError } from '@/lib/auth/errors'
import { db } from '@/lib/db'

type Props = { searchParams: Promise<{ archived?: string }> }

export default async function ProjectsPage({ searchParams }: Props) {
  try {
    await requireActiveMember()
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect('/login')
    throw err
  }

  const { archived } = await searchParams
  const showArchived = archived === '1'

  const projects = await db.project.findMany({
    where: {
      deletedAt: null,
      archivedAt: showArchived ? { not: null } : null
    },
    orderBy: { createdAt: 'desc' }
  })

  return (
    <div className='mx-auto max-w-4xl px-4 py-10'>
      <div className='mb-6 flex items-center justify-between'>
        <h1 className='text-2xl font-semibold'>Projects</h1>
        <div className='flex items-center gap-3'>
          <Link
            href={showArchived ? '/projects' : '/projects?archived=1'}
            className='text-sm text-zinc-500 hover:text-zinc-900'>
            {showArchived ? 'Show active' : 'Show archived'}
          </Link>
          <Link
            href='/projects/new'
            className='rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700'>
            New project
          </Link>
        </div>
      </div>

      {projects.length === 0 ?
        <p className='text-sm text-zinc-500'>
          {showArchived ? 'No archived projects.' : 'No projects yet. Create one to get started.'}
        </p>
      : <ul className='divide-y rounded-lg border bg-white'>
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/projects/${p.key}`}
                className='flex items-start gap-3 px-5 py-4 hover:bg-zinc-50'>
                <span className='mt-0.5 rounded bg-zinc-100 px-2 py-0.5 font-mono text-xs font-medium text-zinc-600'>
                  {p.key}
                </span>
                <div className='flex flex-col'>
                  <span className='font-medium'>{p.name}</span>
                  {p.description && <span className='text-sm text-zinc-500'>{p.description}</span>}
                </div>
                {p.archivedAt && <span className='ml-auto text-xs text-amber-600'>Archived</span>}
              </Link>
            </li>
          ))}
        </ul>
      }
    </div>
  )
}
