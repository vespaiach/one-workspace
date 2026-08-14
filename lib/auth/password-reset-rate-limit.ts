import 'server-only'
import { LOGIN_LIMITER_MAX_KEYS, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS } from './constants'

const store = new Map<string, number[]>()

setInterval(evictExpired, LOGIN_WINDOW_MS).unref()

function evictExpired(): void {
  const cutoff = Date.now() - LOGIN_WINDOW_MS
  for (const [key, timestamps] of store) {
    const active = timestamps.filter((timestamp) => timestamp > cutoff)
    if (active.length === 0) store.delete(key)
    else store.set(key, active)
  }
}

export function __resetPasswordResetRateLimitForTest(): void {
  store.clear()
}

export function reservePasswordResetAttempt(ip: string): boolean {
  const now = Date.now()
  const cutoff = now - LOGIN_WINDOW_MS
  const active = (store.get(ip) ?? []).filter((timestamp) => timestamp > cutoff)

  if (active.length >= LOGIN_MAX_FAILURES) return false

  if (!store.has(ip) && store.size >= LOGIN_LIMITER_MAX_KEYS) {
    evictExpired()
    if (store.size >= LOGIN_LIMITER_MAX_KEYS) return false
  }

  active.push(now)
  store.set(ip, active)
  return true
}
