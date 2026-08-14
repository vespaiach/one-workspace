'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { requireActiveMember, requireAdmin } from '@/lib/auth/authorization'

const DEFAULT_COLUMNS = ['Backlog', 'In Progress', 'Done']

function parseProjectKey(raw: unknown): { ok: true; key: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'Key is required' }
  const key = raw.trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) {
    return { ok: false, error: 'Key must be 2–10 uppercase letters/digits starting with a letter' }
  }
  return { ok: true, key }
}

export type ProjectFormState = { error: string | null }
export type SpecFormState = { error: string | null; saved: boolean }

export async function createProjectAction(
  _prev: ProjectFormState,
  formData: FormData
): Promise<ProjectFormState> {
  const principal = await requireActiveMember().catch(() => redirect('/login'))

  const name = (formData.get('name') as string | null)?.trim()
  if (!name) return { error: 'Name is required' }

  const keyResult = parseProjectKey(formData.get('key'))
  if (!keyResult.ok) return { error: keyResult.error }

  const description = (formData.get('description') as string | null)?.trim() || null

  const existing = await db.project.findUnique({ where: { key: keyResult.key } })
  if (existing) return { error: `Key "${keyResult.key}" is already taken` }

  await db.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: { teamId: principal.teamId, name, key: keyResult.key, description }
    })
    await tx.spec.create({ data: { projectId: project.id, body: '' } })
    const board = await tx.board.create({ data: { projectId: project.id } })
    for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
      await tx.column.create({
        data: {
          boardId: board.id,
          name: DEFAULT_COLUMNS[i],
          rank: String(i + 1).padStart(4, '0')
        }
      })
    }
  })

  redirect(`/projects/${keyResult.key}`)
}

export async function editProjectAction(
  key: string,
  _prev: ProjectFormState,
  formData: FormData
): Promise<ProjectFormState> {
  await requireActiveMember().catch(() => redirect('/login'))

  const name = (formData.get('name') as string | null)?.trim()
  if (!name) return { error: 'Name is required' }

  const description = (formData.get('description') as string | null)?.trim() || null

  const updated = await db.project.updateMany({
    where: { key, deletedAt: null },
    data: { name, description }
  })
  if (updated.count === 0) return { error: 'Project not found' }

  revalidatePath(`/projects/${key}`)
  redirect(`/projects/${key}`)
}

export async function archiveProjectAction(key: string): Promise<void> {
  await requireAdmin().catch(() => redirect('/login'))

  const project = await db.project.findUnique({ where: { key, deletedAt: null } })
  if (!project) redirect('/projects')

  await db.project.update({
    where: { id: project!.id },
    data: { archivedAt: project!.archivedAt ? null : new Date() }
  })

  revalidatePath('/projects')
  revalidatePath(`/projects/${key}`)
  redirect(`/projects/${key}`)
}

export async function deleteProjectAction(key: string): Promise<void> {
  await requireAdmin().catch(() => redirect('/login'))

  await db.project.updateMany({
    where: { key, deletedAt: null },
    data: { deletedAt: new Date() }
  })

  redirect('/projects')
}

export async function updateSpecAction(
  projectId: string,
  _prev: SpecFormState,
  formData: FormData
): Promise<SpecFormState> {
  await requireActiveMember().catch(() => redirect('/login'))

  const body = (formData.get('body') as string | null) ?? ''

  await db.spec.upsert({
    where: { projectId },
    update: { body },
    create: { projectId, body }
  })

  return { error: null, saved: true }
}
