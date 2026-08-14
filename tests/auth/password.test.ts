import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePassword,
  hashPassword,
  verifyPassword,
  performDummyVerify,
  needsPasswordRehash
} from '../../lib/auth/password'

describe('parsePassword', () => {
  it('accepts valid 8-character password', () => {
    const r = parsePassword('12345678')
    assert.equal(r.ok, true)
  })

  it('accepts valid 128-character password', () => {
    const r = parsePassword('a'.repeat(128))
    assert.equal(r.ok, true)
  })

  it('rejects 7-character password', () => {
    assert.equal(parsePassword('1234567').ok, false)
  })

  it('rejects 129-character password', () => {
    assert.equal(parsePassword('a'.repeat(129)).ok, false)
  })

  it('rejects empty string', () => {
    assert.equal(parsePassword('').ok, false)
  })

  it('rejects non-string values', () => {
    assert.equal(parsePassword(null).ok, false)
    assert.equal(parsePassword(undefined).ok, false)
    assert.equal(parsePassword(12345678).ok, false)
  })
})

describe('hashPassword and verifyPassword', () => {
  it('verifies a hashed password correctly', async () => {
    const hash = await hashPassword('correct-password')
    assert.equal(await verifyPassword(hash, 'correct-password'), true)
    assert.equal(await verifyPassword(hash, 'wrong-password'), false)
  })

  it('produces different hashes for the same password', async () => {
    const h1 = await hashPassword('same-password')
    const h2 = await hashPassword('same-password')
    assert.notEqual(h1, h2)
  })
})

describe('performDummyVerify', () => {
  it('does not throw for any string candidate', async () => {
    await assert.doesNotReject(() => performDummyVerify('anything'))
    await assert.doesNotReject(() => performDummyVerify(''))
  })
})

describe('needsPasswordRehash', () => {
  it('returns false for a hash created with current options', async () => {
    const hash = await hashPassword('test-password')
    assert.equal(needsPasswordRehash(hash), false)
  })
})
