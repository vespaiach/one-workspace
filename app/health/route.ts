import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`
    return NextResponse.json(
      { ok: true },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error: unknown) {
    logger.error('Health check failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    })
    return NextResponse.json(
      { ok: false },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
