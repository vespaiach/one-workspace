import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE_LOCAL, SESSION_COOKIE_SECURE } from '@/lib/auth/constants'

const PUBLIC_PATHS = new Set(['/login', '/health'])

// Plausible base64url length for 32 random bytes
const MIN_TOKEN_LEN = 40
const MAX_TOKEN_LEN = 50
const TOKEN_RE = /^[A-Za-z0-9_-]+$/

function hasPlausibleSessionCookie(req: NextRequest): boolean {
  const check = (name: string): boolean => {
    const val = req.cookies.get(name)?.value
    if (!val) return false
    return val.length >= MIN_TOKEN_LEN && val.length <= MAX_TOKEN_LEN && TOKEN_RE.test(val)
  }
  return check(SESSION_COOKIE_SECURE) || check(SESSION_COOKIE_LOCAL)
}

export default function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next()
  }

  if (!hasPlausibleSessionCookie(req)) {
    const loginUrl = new URL('/login', req.nextUrl)
    // Only forward same-origin relative paths as returnTo
    if (pathname !== '/login') {
      loginUrl.searchParams.set('returnTo', pathname)
    }
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)']
}
