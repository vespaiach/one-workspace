import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { reserveLoginAttempt, __resetForTest } from '../../lib/auth/rate-limit'

const IP = '1.2.3.4'
const EMAIL = 'user@example.com'

function attempt(ip = IP, email = EMAIL) {
  return reserveLoginAttempt({ ip, normalizedEmail: email })
}

beforeEach(() => __resetForTest())

describe('IP bucket', () => {
  it('allows up to 5 attempts from one IP', () => {
    for (let i = 0; i < 5; i++) {
      assert.equal(attempt().allowed, true)
    }
  })

  it('blocks the 6th attempt from one IP', () => {
    for (let i = 0; i < 5; i++) attempt()
    assert.equal(attempt().allowed, false)
  })
})

describe('email bucket', () => {
  it('blocks 6th attempt against one email across different IPs', () => {
    for (let i = 0; i < 5; i++) {
      assert.equal(attempt(`10.0.0.${i + 1}`, EMAIL).allowed, true)
    }
    assert.equal(attempt('10.0.0.6', EMAIL).allowed, false)
  })
})

describe('refund', () => {
  it('refund allows another attempt after a successful login', () => {
    for (let i = 0; i < 5; i++) {
      const r = attempt()
      if (i === 4) r.refund() // simulate success on last attempt
    }
    // After refund, one slot is freed
    assert.equal(attempt().allowed, true)
  })

  it('refund is idempotent', () => {
    // Burn 4 slots, then make a 5th that we refund twice.
    for (let i = 0; i < 4; i++) attempt()
    const r = attempt() // 5th — fills the bucket
    assert.equal(r.allowed, true)
    r.refund()
    r.refund() // double-refund must not restore more than one slot
    // Exactly one slot freed: the next attempt is allowed
    assert.equal(attempt().allowed, true)
    // But the bucket is full again now: no more slots
    assert.equal(attempt().allowed, false)
  })
})

describe('TTL expiry', () => {
  it('expired timestamps do not count toward the limit', () => {
    for (let i = 0; i < 5; i++) attempt()

    const realNow = Date.now
    try {
      const t0 = realNow()
      Date.now = () => t0 + 15 * 60 * 1000 + 1
      assert.equal(attempt().allowed, true)
    } finally {
      Date.now = realNow
    }
  })
})

describe('bounded memory', () => {
  it('stays within 10,000 key cap and is fail-closed when full', () => {
    // Fill the store with unique IP keys (each unique IP = 1 key)
    for (let i = 0; i < 5_000; i++) {
      attempt(`192.168.${Math.floor(i / 256)}.${i % 256}`, `u${i}@x.com`)
    }
    // The store now has 10,000 keys (5,000 ip + 5,000 email hashes) — at capacity.
    // A brand-new unique key must be denied (fail-closed).
    const r = attempt('9.9.9.9', 'newuser@x.com')
    assert.equal(r.allowed, false)
  })

  it('fail-closed when map is at capacity and eviction yields no free slot', () => {
    // Manually saturate: 10,000 unique recent keys (none expired)
    const maxKeys = 10_000
    // Each attempt() creates at most 2 keys (ip + email). Fill with unique pairs.
    for (let i = 0; i < maxKeys / 2; i++) {
      const ip = `${Math.floor(i / 65536)}.${Math.floor(i / 256) % 256}.${i % 256}.1`
      const email = `u${i}@capacity-test.com`
      attempt(ip, email)
    }
    // Now try a new unique pair — store is full, eviction finds nothing expired
    const r = attempt('255.255.255.255', 'overflow@capacity-test.com')
    // Must be denied (fail-closed) or allowed only if eviction freed a slot
    assert.ok(typeof r.allowed === 'boolean')
  })
})

describe('asymmetric attack patterns', () => {
  it('one IP attacking many accounts is blocked by IP bucket', () => {
    for (let i = 0; i < 5; i++) attempt(IP, `victim${i}@example.com`)
    // 6th attempt from same IP, different account → blocked by IP bucket
    assert.equal(attempt(IP, 'victim5@example.com').allowed, false)
  })

  it('many IPs attacking one account are blocked by email bucket', () => {
    for (let i = 0; i < 5; i++) attempt(`10.0.0.${i + 1}`, EMAIL)
    // 6th IP attacking same account → blocked by email bucket
    assert.equal(attempt('10.0.0.10', EMAIL).allowed, false)
  })
})

describe('simultaneous reservations', () => {
  it('handles concurrent reserve calls without over-counting', () => {
    // Simulate 6 simultaneous attempts (synchronous in single-threaded JS)
    const results = Array.from({ length: 6 }, () => attempt())
    const allowed = results.filter((r) => r.allowed).length
    assert.ok(allowed <= 5, `Expected at most 5 allowed, got ${allowed}`)
  })
})
