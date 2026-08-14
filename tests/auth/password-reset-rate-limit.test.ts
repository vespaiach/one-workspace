import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetPasswordResetRateLimitForTest,
  reservePasswordResetAttempt
} from '../../lib/auth/password-reset-rate-limit'

beforeEach(() => __resetPasswordResetRateLimitForTest())

describe('password-reset IP limiter', () => {
  it('allows five requests from one IP and blocks the sixth', () => {
    for (let i = 0; i < 5; i++) {
      assert.equal(reservePasswordResetAttempt('192.0.2.1'), true)
    }

    assert.equal(reservePasswordResetAttempt('192.0.2.1'), false)
  })

  it('uses independent buckets for different IPs', () => {
    for (let i = 0; i < 5; i++) reservePasswordResetAttempt('192.0.2.1')

    assert.equal(reservePasswordResetAttempt('192.0.2.2'), true)
  })

  it('allows requests again after the window expires', () => {
    for (let i = 0; i < 5; i++) reservePasswordResetAttempt('192.0.2.1')

    const realNow = Date.now
    try {
      const start = realNow()
      Date.now = () => start + 15 * 60 * 1000 + 1
      assert.equal(reservePasswordResetAttempt('192.0.2.1'), true)
    } finally {
      Date.now = realNow
    }
  })

  it('fails closed when the bounded store is full', () => {
    for (let i = 0; i < 10_000; i++) {
      const ip = `test-ip-${i}`
      assert.equal(reservePasswordResetAttempt(ip), true)
    }

    assert.equal(reservePasswordResetAttempt('overflow-ip'), false)
  })
})
