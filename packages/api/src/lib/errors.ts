export type ErrorCode =
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'immutable'
  | 'registration_closed'
  | 'invalid_credentials'
  | 'invalid_id_token'
  | 'no_account'
  | 'oidc_unavailable'
  | 'rate_limited'
  | 'internal_error';

/** An error that maps directly to the API error format `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, 'validation_failed', message, details);
export const unprocessable = (message: string, details?: unknown) =>
  new ApiError(422, 'validation_failed', message, details);
export const unauthorized = (message = 'authentication required') => new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'insufficient role') => new ApiError(403, 'forbidden', message);
export const notFound = (message = 'not found') => new ApiError(404, 'not_found', message);
export const conflict = (message: string, details?: unknown) => new ApiError(409, 'conflict', message, details);
export const immutable = (message: string) => new ApiError(409, 'immutable', message);
