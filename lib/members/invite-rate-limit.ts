import 'server-only'

const WINDOW_MS = 15 * 60 * 1000
const MAX_PER_WINDOW = 10
const MAX_KEYS = 10_000

const store = new Map<string, number[]>()

setInterval(() => evictExpired(), WINDOW_MS).unref()

export function __resetForTest(): void {
  store.clear()
}

function evictExpired(): void {
  const cutoff = Date.now() - WINDOW_MS
  for (const [key, timestamps] of store) {
    const fresh = timestamps.filter((t) => t > cutoff)
    if (fresh.length === 0) store.delete(key)
    else store.set(key, fresh)
  }
}

export function checkInviteRateLimit(ip: string): boolean {
  const now = Date.now()
  const cutoff = now - WINDOW_MS

  let timestamps = store.get(ip)
  if (timestamps) {
    const fresh = timestamps.filter((t) => t > cutoff)
    store.set(ip, fresh)
    timestamps = fresh
  } else {
    if (store.size >= MAX_KEYS) {
      evictExpired()
      if (store.size >= MAX_KEYS) return false
    }
    store.set(ip, [])
    timestamps = store.get(ip)!
  }

  if (timestamps.length >= MAX_PER_WINDOW) return false
  timestamps.push(now)
  return true
}
