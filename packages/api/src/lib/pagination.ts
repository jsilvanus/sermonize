/**
 * Keyset pagination. The cursor is the base64url encoding of the last key
 * returned (a UUIDv7 id by default; ids are time-ordered). Usage:
 *
 *   const p = new SqlParams();
 *   const where = [...filters];
 *   const page = keyset(p, request.query, 'w.id');   // adds `w.id > $n` when a cursor is given
 *   where.push(...page.where);
 *   const { rows } = await db.query(`SELECT ... WHERE ${where.join(' AND ') || 'true'}
 *                                    ORDER BY w.id ${page.limitSql}`, p.values);
 *   return toPage(rows, page.limit);
 */
import { Type, type TSchema } from '@fastify/type-provider-typebox';
import { badRequest } from './errors.js';
import type { SqlParams } from './sql.js';

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 500;

/** Querystring properties shared by every list endpoint. */
export const PaginationQuery = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT })),
  cursor: Type.Optional(Type.String({ maxLength: 200 })),
};

/** Response envelope `{ items, next_cursor }`. */
export function Page<T extends TSchema>(item: T) {
  return Type.Object({ items: Type.Array(item), next_cursor: Type.Union([Type.String(), Type.Null()]) });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(key: string | number): string {
  return Buffer.from(String(key), 'utf8').toString('base64url');
}

/** Decodes a cursor and checks it with `valid` (default: a UUID). Invalid cursors are a 400. */
export function decodeCursor(cursor: string, valid: (key: string) => boolean = (k) => UUID.test(k)): string {
  const key = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!valid(key)) throw badRequest('invalid cursor');
  return key;
}

export interface KeysetPage {
  /** Zero or one condition to AND into the WHERE clause. */
  where: string[];
  /** `LIMIT $n` (fetches one extra row to detect the next page). */
  limitSql: string;
  limit: number;
}

/**
 * Builds the keyset condition (`key > cursor`) and LIMIT for ascending order
 * on `keyColumn`. The caller must `ORDER BY keyColumn`.
 */
export function keyset(
  p: SqlParams,
  query: { limit?: number; cursor?: string },
  keyColumn: string,
  opts: { valid?: (key: string) => boolean; cast?: string } = {},
): KeysetPage {
  const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
  const where: string[] = [];
  if (query.cursor !== undefined) {
    const key = decodeCursor(query.cursor, opts.valid);
    where.push(`${keyColumn} > ${p.add(key)}${opts.cast ? `::${opts.cast}` : ''}`);
  }
  return { where, limitSql: `LIMIT ${p.add(limit + 1)}`, limit };
}

/** Trims the extra row and computes `next_cursor` from the last item's key. */
export function toPage<T>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => string | number = (row) => (row as { id: string }).id,
): { items: T[]; next_cursor: string | null } {
  if (rows.length <= limit) return { items: rows, next_cursor: null };
  const items = rows.slice(0, limit);
  return { items, next_cursor: encodeCursor(keyOf(items[items.length - 1]!)) };
}
