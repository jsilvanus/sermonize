import { Type } from '@fastify/type-provider-typebox';
import { conflict, forbidden, unprocessable } from '../../lib/errors.js';
import { hasRole, type Principal } from '../../lib/principal.js';
import { JsonObject } from '../schemas.js';

export interface DerivedOptions {
  /** Maximum items per batch request (MAX_BATCH_ITEMS). */
  maxBatchItems: number;
}

/**
 * `producer`: the external process that produced a derived record. Mirrors
 * is_valid_producer() in the migration (which remains the authority).
 */
export const Producer = Type.Object(
  {
    tool: Type.String({ minLength: 1, maxLength: 500 }),
    version: Type.String({ minLength: 1, maxLength: 500 }),
    commit: Type.Optional(Type.String({ maxLength: 500 })),
    parameters: Type.Optional(JsonObject),
    run_at: Type.Optional(Type.String({ maxLength: 100 })),
    notes: Type.Optional(Type.String({ maxLength: 10000 })),
  },
  { additionalProperties: true, description: 'External process: { tool, version, commit?, parameters?, run_at?, notes? }.' },
);

export const BatchResult = Type.Object({
  inserted: Type.Integer({ description: 'Rows inserted by this request.' }),
  skipped: Type.Integer({ description: 'Items that already existed with identical content (idempotent retry).' }),
});

/** One failing item of a batch (reported in `error.details.errors`). */
export interface ItemError {
  /** Zero-based position in the request array. */
  index: number;
  /** Stable machine-readable reason, e.g. `text_mismatch`. */
  reason: string;
  message: string;
  [key: string]: unknown;
}

const MAX_REPORTED_ERRORS = 1000;

/** 422 listing the failing items (at most 1000; `failed` has the total). Nothing is inserted. */
export function batchValidationError(errors: ItemError[], total: number) {
  errors.sort((a, b) => a.index - b.index);
  return unprocessable(`${errors.length} of ${total} items failed validation; nothing was inserted`, {
    failed: errors.length,
    errors: errors.slice(0, MAX_REPORTED_ERRORS),
  });
}

/** 409: items whose natural key exists with different content. Nothing is inserted. */
export function batchConflictError(conflicts: Array<Record<string, unknown> & { index: number }>, what: string) {
  conflicts.sort((a, b) => a.index - b.index);
  return conflict(
    `${conflicts.length} items conflict with existing ${what} that have the same key but different content; nothing was inserted`,
    { conflicts: conflicts.slice(0, MAX_REPORTED_ERRORS) },
  );
}

/** Finds duplicate values of `keyOf` within a batch; each repeat (not the first occurrence) is an error. */
export function duplicateErrors<T>(
  items: readonly T[],
  keyOf: (item: T) => string | number | undefined,
  field: string,
): ItemError[] {
  const seen = new Map<string | number, number>();
  const errors: ItemError[] = [];
  items.forEach((item, index) => {
    const key = keyOf(item);
    if (key === undefined) return;
    const first = seen.get(key);
    if (first === undefined) seen.set(key, index);
    else errors.push({ index, reason: `duplicate_${field}`, message: `${field} ${key} repeats item ${first}`, [field]: key });
  });
  return errors;
}

/** Restricted chunk text/vectors need contributor+; readers get a 403. */
export function assertCanReadRestricted(principal: Principal, effectiveAccessLevel: string, what: string): void {
  if (effectiveAccessLevel === 'restricted' && !hasRole(principal, 'contributor')) {
    throw forbidden(`${what} of restricted texts require role contributor or higher`);
  }
}
