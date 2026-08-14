import 'server-only'
import { createHash } from 'node:crypto'
import { LOGIN_LIMITER_MAX_KEYS, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS } from './constants'

const EMAIL_NAMESPACE = 'one-workspace:login:email'

type BucketEntry = { timestamps: number[] }
type Store = Map<string, BucketEntry>

const store: Store = new Map()

const cleanupTimer = setInterval(() => evictExpired(store), LOGIN_WINDOW_MS).unref()

// Test-only reset hook — not exported from the package index, only accessible
// by importing this file directly in tests.
export function __resetForTest(): void {
  store.clear()
}

function emailKey(normalizedEmail: string): string {
  return createHash('sha256').update(`${EMAIL_NAMESPACE}:${normalizedEmail}`).digest('hex')
}

function evictExpired(s: Store): void {
  const cutoff = Date.now() - LOGIN_WINDOW_MS
  for (const [key, entry] of s) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff)
    if (entry.timestamps.length === 0) s.delete(key)
  }
}

function tryReserve(s: Store, key: string): boolean {
  const now = Date.now()
  const cutoff = now - LOGIN_WINDOW_MS

  let entry = s.get(key)

  if (entry) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff)
    if (entry.timestamps.length >= LOGIN_MAX_FAILURES) return false
  } else {
    if (s.size >= LOGIN_LIMITER_MAX_KEYS) {
      evictExpired(s)
      if (s.size >= LOGIN_LIMITER_MAX_KEYS) return false // fail-closed
    }
    entry = { timestamps: [] }
    s.set(key, entry)
  }

  entry.timestamps.push(now)
  return true
}

function refundOne(s: Store, key: string): void {
  const entry = s.get(key)
  if (!entry) return
  entry.timestamps.pop()
  if (entry.timestamps.length === 0) s.delete(key)
}

export type LoginReservation = {
  allowed: boolean
  refund(): void
}

export function reserveLoginAttempt(input: { ip: string; normalizedEmail: string }): LoginReservation {
  const ipKey = `ip:${input.ip}`
  const emailHashKey = emailKey(input.normalizedEmail)

  const ipAllowed = tryReserve(store, ipKey)
  if (!ipAllowed) {
    return { allowed: false, refund: () => {} }
  }

  const emailAllowed = tryReserve(store, emailHashKey)
  if (!emailAllowed) {
    refundOne(store, ipKey)
    return { allowed: false, refund: () => {} }
  }

  let refunded = false
  return {
    allowed: true,
    refund() {
      if (refunded) return
      refunded = true
      refundOne(store, ipKey)
      refundOne(store, emailHashKey)
    }
  }
}
