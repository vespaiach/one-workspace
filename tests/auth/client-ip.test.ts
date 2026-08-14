import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getTrustedClientIp } from '../../lib/auth/client-ip'

function makeHeaders(entries: Record<string, string>): Headers {
  return new Headers(entries)
}

describe('getTrustedClientIp', () => {
  it('returns the rightmost XFF entry as the direct client', () => {
    const h = makeHeaders({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })
    assert.equal(getTrustedClientIp(h), '5.6.7.8')
  })

  it('handles a single XFF entry', () => {
    const h = makeHeaders({ 'x-forwarded-for': '10.0.0.1' })
    assert.equal(getTrustedClientIp(h), '10.0.0.1')
  })

  it('returns unknown when header is absent', () => {
    assert.equal(getTrustedClientIp(makeHeaders({})), 'unknown')
  })

  it('returns unknown for a malformed IP value', () => {
    const h = makeHeaders({ 'x-forwarded-for': 'not-an-ip' })
    assert.equal(getTrustedClientIp(h), 'unknown')
  })

  it('returns unknown when XFF contains only spaces', () => {
    const h = makeHeaders({ 'x-forwarded-for': '   ' })
    assert.equal(getTrustedClientIp(h), 'unknown')
  })

  it('accepts IPv6 addresses', () => {
    const h = makeHeaders({ 'x-forwarded-for': '::1' })
    assert.equal(getTrustedClientIp(h), '::1')
  })

  it('spoofed first entry is ignored — rightmost is used', () => {
    const h = makeHeaders({ 'x-forwarded-for': 'spoofed, 192.168.1.1' })
    assert.equal(getTrustedClientIp(h), '192.168.1.1')
  })
})
