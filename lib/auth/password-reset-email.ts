import 'server-only'
import nodemailer from 'nodemailer'

export type PasswordResetMessage = {
  to: string
  resetUrl: string
}

function requiredEnv(name: 'APP_URL' | 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_FROM'): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function smtpPort(): number {
  const port = Number(requiredEnv('SMTP_PORT'))
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SMTP_PORT must be a valid port')
  }
  return port
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }
    return entities[character]!
  })
}

export function buildPasswordResetUrl(rawToken: string): string {
  const appUrl = new URL(requiredEnv('APP_URL'))
  if (appUrl.protocol !== 'http:' && appUrl.protocol !== 'https:') {
    throw new Error('APP_URL must use HTTP or HTTPS')
  }

  const resetUrl = new URL('/reset-password', appUrl)
  resetUrl.searchParams.set('token', rawToken)
  return resetUrl.toString()
}

export async function sendPasswordResetEmail(message: PasswordResetMessage): Promise<void> {
  const port = smtpPort()
  const user = process.env.SMTP_USER?.trim()
  const transport = nodemailer.createTransport({
    host: requiredEnv('SMTP_HOST'),
    port,
    secure: port === 465,
    auth: user ? { user, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000
  })
  const safeUrl = escapeHtml(message.resetUrl)

  await transport.sendMail({
    from: requiredEnv('SMTP_FROM'),
    to: message.to,
    subject: 'Reset your One Workspace password',
    text: `Use this link within one hour to reset your password:\n\n${message.resetUrl}\n\nIf you did not request this, you can ignore this email.`,
    html: `<p>Use this link within one hour to reset your password:</p><p><a href="${safeUrl}">Reset your password</a></p><p>If you did not request this, you can ignore this email.</p>`
  })
}
