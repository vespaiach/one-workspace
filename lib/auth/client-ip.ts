import 'server-only'
import type { ReadonlyHeaders } from 'next/dist/server/web/spec-extension/adapters/headers'

const UNKNOWN_BUCKET = 'unknown'
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/
const IPV6_RE = /^[0-9a-f:]+$/i

function isValidIp(s: string): boolean {
  const trimmed = s.trim()
  return IPV4_RE.test(trimmed) || IPV6_RE.test(trimmed)
}

export function getTrustedClientIp(headers: ReadonlyHeaders | Headers): string {
  const xff = headers.get('x-forwarded-for')
  if (!xff) return UNKNOWN_BUCKET

  // Rightmost entry is the direct client in a single-Traefik topology.
  const parts = xff.split(',')
  const candidate = parts[parts.length - 1]?.trim() ?? ''

  if (!isValidIp(candidate)) return UNKNOWN_BUCKET
  return candidate
}
