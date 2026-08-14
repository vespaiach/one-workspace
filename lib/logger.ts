type LogLevel = 'info' | 'warn' | 'error' | 'debug'
type Meta = Record<string, unknown>

const SECRET_KEY = /password|secret|token|authorization|cookie|credential.*key/i

function sanitizeValue(key: string, value: unknown): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item))
  if (value !== null && typeof value === 'object') return sanitize(value as Meta)
  return value
}

function sanitizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item))
  if (value !== null && typeof value === 'object') return sanitize(value as Meta)
  return value
}

function sanitize(meta: Meta = {}): Meta {
  return Object.fromEntries(
    Object.entries(meta).map(([key, value]) => [key, sanitizeValue(key, value)]),
  )
}

function emit(level: LogLevel, message: string, meta?: Meta): void {
  process.stdout.write(
    `${JSON.stringify({
      ...sanitize(meta),
      level,
      message,
      timestamp: new Date().toISOString(),
    })}\n`,
  )
}

export const logger = {
  info: (message: string, meta?: Meta) => emit('info', message, meta),
  warn: (message: string, meta?: Meta) => emit('warn', message, meta),
  error: (message: string, meta?: Meta) => emit('error', message, meta),
  debug: (message: string, meta?: Meta) => emit('debug', message, meta),
}
