/** Typed application errors that map onto HTTP status codes. */

export class AppError extends Error {
  constructor(
    override readonly message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 422, 'VALIDATION_FAILED', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', code = 'UNAUTHENTICATED') {
    super(message, 401, code);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that', details?: unknown) {
    super(message, 403, 'FORBIDDEN', details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'CONFLICT', details);
  }
}

export class LockedError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 423, 'LOCKED', details);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 429, 'TOO_MANY_REQUESTS', details);
  }
}
