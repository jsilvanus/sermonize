import { Type } from '@fastify/type-provider-typebox';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { PaginationQuery } from '../../lib/pagination.js';
import { ident, updateSql, type Db } from '../../lib/sql.js';

/** Querystring properties shared by scholarly list endpoints. */
export const ListQueryBase = {
  ...PaginationQuery,
  include_withdrawn: Type.Optional(Type.Boolean({ description: 'Include withdrawn records (default false).' })),
};

export const WithdrawBody = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 2000 }) });

/** `SELECT <columns> FROM table WHERE id = $1 FOR UPDATE`; 404 if absent. */
export async function lockRow<T = Record<string, unknown>>(
  db: Db,
  table: string,
  id: string,
  columns = 'id',
): Promise<T> {
  const { rows } = await db.query(`SELECT ${columns} FROM ${ident(table)} WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows[0]) throw notFound(`${table} not found`);
  return rows[0] as T;
}

/** Applies the whitelisted columns of a PATCH body; 400 if the body names none of them. */
export async function patchRow(
  db: Db,
  table: string,
  columns: readonly string[],
  id: string,
  body: object,
): Promise<void> {
  const sql = updateSql(table, columns, body, { id });
  if (!sql) throw badRequest(`no updatable fields in body; allowed: ${columns.join(', ')}`);
  const { rowCount } = await db.query(sql.text, sql.values);
  if (!rowCount) throw notFound(`${table} not found`);
}

/** Withdraws a record (withdrawn_by is set by trigger). 404 if absent, 409 if already withdrawn. */
export async function withdrawRow(db: Db, table: string, id: string, reason: string): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE ${ident(table)} SET withdrawn_at = now(), withdrawn_reason = $2
      WHERE id = $1 AND withdrawn_at IS NULL`,
    [id, reason],
  );
  if (rowCount) return;
  const { rows } = await db.query(`SELECT 1 FROM ${ident(table)} WHERE id = $1`, [id]);
  throw rows[0] ? conflict(`${table} is already withdrawn`) : notFound(`${table} not found`);
}

/** Rejects duplicate natural keys in a PUT/POST array (e.g. the same person and role twice). */
export function assertUnique<T>(items: readonly T[], keyOf: (item: T) => string, what: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) throw badRequest(`duplicate ${what}: ${key}`);
    seen.add(key);
  }
}
