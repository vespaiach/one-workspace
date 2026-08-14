import 'server-only'
import argon2 from 'argon2'
import { ARGON2_OPTIONS, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './constants'

const DUMMY_HASH =
  '$argon2id$v=19$m=65536,p=1,t=3$gMQSPvLm4Cuu6NJpXunGHQ$cVFlIutOd+4QwoIjm5huZ6qdHbcC5qUPlisaWmrCNJo'

type PasswordResult = { ok: true; password: string } | { ok: false }

export function parsePassword(value: unknown): PasswordResult {
  if (typeof value !== 'string') return { ok: false }
  if (value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) return { ok: false }
  return { ok: true, password: value }
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS)
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password)
}

export async function performDummyVerify(passwordCandidate: string): Promise<void> {
  await argon2.verify(DUMMY_HASH, passwordCandidate).catch(() => false)
}

export function needsPasswordRehash(hash: string): boolean {
  return argon2.needsRehash(hash, ARGON2_OPTIONS)
}
