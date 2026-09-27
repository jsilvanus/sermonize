import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { ApiError } from '../src/lib/errors.js';
import { toErrorResponse } from '../src/plugins/errors.js';

function dbError(code: string, constraint?: string): pg.DatabaseError {
  const err = new pg.DatabaseError('boom', 0, 'error');
  err.code = code;
  if (constraint) err.constraint = constraint;
  return err;
}

describe('error mapping', () => {
  it.each([
    ['SZ002', 409, 'immutable'],
    ['SZ003', 409, 'conflict'],
    ['SZ004', 422, 'validation_failed'],
    ['23505', 409, 'conflict'],
    ['23514', 422, 'validation_failed'],
    ['23503', 422, 'validation_failed'],
  ])('maps SQLSTATE %s to %i %s', (sqlstate, status, code) => {
    const res = toErrorResponse(dbError(sqlstate, 'c'));
    expect(res.statusCode).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.details).toEqual({ constraint: 'c' });
  });

  it('hides unexpected errors', () => {
    expect(toErrorResponse(new Error('secret detail'))).toEqual({
      statusCode: 500,
      body: { error: { code: 'internal_error', message: 'internal server error' } },
    });
    expect(toErrorResponse(dbError('SZ001')).statusCode).toBe(500);
  });

  it('passes ApiError through', () => {
    const res = toErrorResponse(new ApiError(422, 'validation_failed', 'bad', { seq: [1] }));
    expect(res).toEqual({ statusCode: 422, body: { error: { code: 'validation_failed', message: 'bad', details: { seq: [1] } } } });
  });
});
