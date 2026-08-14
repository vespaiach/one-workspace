import 'server-only'
import { isIP } from 'node:net'
import type { ReadonlyHeaders } from 'next/dist/server/web/spec-extension/adapters/headers'

const UNKNOWN_BUCKET = 'unknown'

function isValidIp(s: string): boolean {
  return isIP(s.trim()) !== 0
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
