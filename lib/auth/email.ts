import { domainToASCII } from 'url'

type EmailResult = { ok: true; email: string } | { ok: false }

export function normalizeEmail(value: unknown): EmailResult {
  if (typeof value !== 'string') return { ok: false }

  const trimmed = value.trim().toLowerCase()
  if (trimmed.length > 254) return { ok: false }

  const atIndex = trimmed.indexOf('@')
  if (atIndex <= 0 || atIndex !== trimmed.lastIndexOf('@')) return { ok: false }

  const local = trimmed.slice(0, atIndex)
  const rawDomain = trimmed.slice(atIndex + 1)

  if (!local || !rawDomain) return { ok: false }

  const domain = domainToASCII(rawDomain)
  if (!domain) return { ok: false }

  return { ok: true, email: `${local}@${domain}` }
}

export function isAllowedEmailDomain(email: string): boolean {
  const allowed = process.env.ALLOWED_EMAIL_DOMAIN?.trim().toLowerCase()
  if (!allowed) return true

  const atIndex = email.lastIndexOf('@')
  if (atIndex === -1) return false

  return email.slice(atIndex + 1) === allowed
}
