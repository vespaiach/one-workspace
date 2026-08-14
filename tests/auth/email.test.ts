import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEmail, isAllowedEmailDomain } from '../../lib/auth/email'

describe('normalizeEmail', () => {
  it('returns ok for a valid email', () => {
    const r = normalizeEmail('User@Example.COM')
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.email, 'user@example.com')
  })

  it('trims surrounding whitespace', () => {
    const r = normalizeEmail('  test@example.com  ')
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.email, 'test@example.com')
  })

  it('rejects non-string values', () => {
    assert.equal(normalizeEmail(42).ok, false)
    assert.equal(normalizeEmail(null).ok, false)
    assert.equal(normalizeEmail(undefined).ok, false)
    assert.equal(normalizeEmail({}).ok, false)
  })

  it('rejects email longer than 254 characters', () => {
    const local = 'a'.repeat(243)
    assert.equal(normalizeEmail(`${local}@example.com`).ok, false)
  })

  it('rejects email with no local part', () => {
    assert.equal(normalizeEmail('@example.com').ok, false)
  })

  it('rejects email with no domain', () => {
    assert.equal(normalizeEmail('user@').ok, false)
  })

  it('rejects email with multiple @ signs', () => {
    assert.equal(normalizeEmail('a@b@c.com').ok, false)
  })

  it('rejects a bare string with no @', () => {
    assert.equal(normalizeEmail('notanemail').ok, false)
  })

  it('normalizes ASCII domain', () => {
    const r = normalizeEmail('user@EXAMPLE.COM')
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.email, 'user@example.com')
  })
})

describe('isAllowedEmailDomain', () => {
  let original: string | undefined

  beforeEach(() => {
    original = process.env.ALLOWED_EMAIL_DOMAIN
  })

  afterEach(() => {
    if (original === undefined) {
      delete process.env.ALLOWED_EMAIL_DOMAIN
    } else {
      process.env.ALLOWED_EMAIL_DOMAIN = original
    }
  })

  it('allows any domain when ALLOWED_EMAIL_DOMAIN is unset', () => {
    delete process.env.ALLOWED_EMAIL_DOMAIN
    assert.equal(isAllowedEmailDomain('user@anything.com'), true)
  })

  it('allows matching domain', () => {
    process.env.ALLOWED_EMAIL_DOMAIN = 'example.com'
    assert.equal(isAllowedEmailDomain('user@example.com'), true)
  })

  it('rejects non-matching domain', () => {
    process.env.ALLOWED_EMAIL_DOMAIN = 'example.com'
    assert.equal(isAllowedEmailDomain('user@other.com'), false)
  })

  it('does not allow suffix-only matches', () => {
    process.env.ALLOWED_EMAIL_DOMAIN = 'example.com'
    assert.equal(isAllowedEmailDomain('user@evil-example.com'), false)
    assert.equal(isAllowedEmailDomain('user@sub.example.com'), false)
  })

  it('is case-insensitive via normalized email input', () => {
    process.env.ALLOWED_EMAIL_DOMAIN = 'example.com'
    assert.equal(isAllowedEmailDomain('user@example.com'), true)
  })
})
