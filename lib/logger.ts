type LogLevel = 'info' | 'warn' | 'error' | 'debug'
type Meta = Record<string, unknown>

const SECRET_KEY = /password|secret|token|authorization|cookie|credential.*key/i

function sanitize(meta: Meta = {}): Meta {
  return Object.fromEntries(
    Object.entries(meta).map(([key, value]) => [
      key,
      SECRET_KEY.test(key) ? '[REDACTED]' : value,
    ]),
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
