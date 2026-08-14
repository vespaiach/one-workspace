import argon2 from 'argon2'

export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
export const SESSION_COOKIE_SECURE = '__Host-one-workspace-session'
export const SESSION_COOKIE_LOCAL = 'one-workspace-session'
export const LOGIN_WINDOW_MS = 15 * 60 * 1000
export const LOGIN_MAX_FAILURES = 5
export const LOGIN_LIMITER_MAX_KEYS = 10_000
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1
} as const
