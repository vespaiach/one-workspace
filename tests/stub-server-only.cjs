/* eslint-disable @typescript-eslint/no-require-imports */
// Preload stub: neutralise server-only and mock next/headers for tests.
const Module = require('module')

// Stub server-only
const serverOnlyResolved = require.resolve('server-only')
Module._cache[serverOnlyResolved] = {
  id: serverOnlyResolved,
  filename: serverOnlyResolved,
  loaded: true,
  exports: {},
  children: [],
  parent: null,
  paths: []
}

// Controllable in-memory cookie store for tests.
const testCookies = new Map()

const cookieStore = {
  get(name) {
    const val = testCookies.get(name)
    return val !== undefined ? { value: val } : undefined
  },
  set(name, value) {
    testCookies.set(name, value)
  },
  delete(name) {
    testCookies.delete(name)
  }
}

function resetCookies() {
  testCookies.clear()
}

function setCookie(name, value) {
  testCookies.set(name, value)
}

// Mock next/headers
const nextHeadersResolved = require.resolve('next/headers')
Module._cache[nextHeadersResolved] = {
  id: nextHeadersResolved,
  filename: nextHeadersResolved,
  loaded: true,
  exports: {
    cookies: () => Promise.resolve(cookieStore),
    headers: () => Promise.resolve(new Headers())
  },
  children: [],
  parent: null,
  paths: []
}

// Mock next/navigation — redirect throws a special sentinel that tests can catch
let lastRedirect = null
const nextNavigationResolved = require.resolve('next/navigation')
Module._cache[nextNavigationResolved] = {
  id: nextNavigationResolved,
  filename: nextNavigationResolved,
  loaded: true,
  exports: {
    redirect(url) {
      lastRedirect = url
      const err = new Error(`NEXT_REDIRECT:${url}`)
      err.digest = `NEXT_REDIRECT;${url}`
      throw err
    },
    notFound() {
      throw new Error('NEXT_NOT_FOUND')
    }
  },
  children: [],
  parent: null,
  paths: []
}

// Expose test helpers globally so test files can import them without a path
global.__testCookies = { reset: resetCookies, set: setCookie, store: cookieStore }
global.__testNav = {
  getLastRedirect() {
    return lastRedirect
  },
  resetRedirect() {
    lastRedirect = null
  }
}
