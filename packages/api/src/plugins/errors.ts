import type { FastifyError, FastifyInstance } from 'fastify';
import pg from 'pg';
import { ApiError, type ErrorCode } from '../lib/errors.js';

interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

/** PostgreSQL SQLSTATE -> API error. SZxxx are raised by our triggers (see migrations/0001_init.sql). */
const PG_ERRORS: Record<string, [number, ErrorCode]> = {
  SZ002: [409, 'immutable'],
  SZ003: [409, 'conflict'],
  SZ004: [422, 'validation_failed'],
  '23505': [409, 'conflict'], // unique_violation
  '23503': [422, 'validation_failed'], // foreign_key_violation
  '23514': [422, 'validation_failed'], // check_violation
  '23502': [422, 'validation_failed'], // not_null_violation
  '22P02': [400, 'validation_failed'], // invalid_text_representation
  '22023': [400, 'validation_failed'], // invalid_parameter_value
  '42501': [403, 'forbidden'], // insufficient_privilege
};

export function toErrorResponse(err: unknown): { statusCode: number; body: ErrorBody } {
  if (err instanceof ApiError) {
    const error: ErrorBody['error'] = { code: err.code, message: err.message };
    if (err.details !== undefined) error.details = err.details;
    return { statusCode: err.statusCode, body: { error } };
  }
  if (err instanceof pg.DatabaseError && err.code && PG_ERRORS[err.code]) {
    const [statusCode, code] = PG_ERRORS[err.code]!;
    const details = err.constraint ? { constraint: err.constraint } : undefined;
    return { statusCode, body: { error: { code, message: err.message, ...(details && { details }) } } };
  }
  const fe = err as FastifyError;
  if (fe.validation) {
    return {
      statusCode: 400,
      body: { error: { code: 'validation_failed', message: fe.message, details: fe.validation } },
    };
  }
  if (typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
    const code: ErrorCode =
      fe.statusCode === 401
        ? 'unauthorized'
        : fe.statusCode === 404
          ? 'not_found'
          : fe.statusCode === 429
            ? 'rate_limited'
            : 'validation_failed';
    return { statusCode: fe.statusCode, body: { error: { code, message: fe.message } } };
  }
  return { statusCode: 500, body: { error: { code: 'internal_error', message: 'internal server error' } } };
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    const { statusCode, body } = toErrorResponse(err);
    if (statusCode >= 500) request.log.error({ err }, 'unhandled error');
    return reply.status(statusCode).send(body);
  });
  app.setNotFoundHandler((request, reply) => {
    return reply
      .status(404)
      .send({ error: { code: 'not_found', message: `route ${request.method} ${request.url} not found` } });
  });
}
