import 'server-only'
import { createTransport } from 'nodemailer'
import { logger } from '../logger'

type MailOptions = {
  to: string
  subject: string
  text: string
  html: string
}

export async function sendMail(opts: MailOptions): Promise<void> {
  const host = process.env.SMTP_HOST
  if (!host) {
    logger.warn('SMTP_HOST not configured; email not sent', { to: opts.to })
    return
  }

  const port = Number(process.env.SMTP_PORT ?? 587)
  const from = process.env.SMTP_FROM ?? 'noreply@localhost'

  const transport = createTransport({
    host,
    port,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined
  })

  await transport.sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html
  })
}
