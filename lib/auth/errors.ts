export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid credentials')
    this.name = 'InvalidCredentialsError'
  }
}

export class RateLimitError extends Error {
  constructor() {
    super('Invalid credentials')
    this.name = 'RateLimitError'
  }
}

export class StalePasswordChangeError extends Error {
  constructor() {
    super('Stale password change')
    this.name = 'StalePasswordChangeError'
  }
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized')
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends Error {
  constructor() {
    super('Forbidden')
    this.name = 'ForbiddenError'
  }
}
