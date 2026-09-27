/**
 * Small helpers for building parameterised SQL from **whitelisted** column
 * lists. Request bodies are not stripped of unknown properties, so every
 * INSERT/UPDATE must go through these helpers (or an equally explicit list):
 * only columns named by the caller are ever written, whatever the body holds.
 */
import type { PoolClient } from 'pg';

/** Anything with pg's `query` (a Pool or a PoolClient). */
export type Db = Pick<PoolClient, 'query'>;

export interface Sql {
  text: string;
  values: unknown[];
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Guards identifiers that are interpolated into SQL (they always come from code, never from requests). */
export function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsafe SQL identifier: ${name}`);
  return name;
}

/** Collects positional parameters: `p.add(value)` returns `$n`. */
export class SqlParams {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** The whitelisted entries of `data` whose value is not `undefined` (null is kept: it clears a column). */
export function pickColumns(data: object, columns: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    const value = (data as Record<string, unknown>)[column];
    if (value !== undefined) out[ident(column)] = value;
  }
  return out;
}

/** `INSERT INTO table (whitelisted columns present in data) VALUES (...) RETURNING ...`. */
export function insertSql(table: string, columns: readonly string[], data: object, returning = 'id'): Sql {
  const row = pickColumns(data, columns);
  const keys = Object.keys(row);
  if (keys.length === 0) return { text: `INSERT INTO ${ident(table)} DEFAULT VALUES RETURNING ${returning}`, values: [] };
  const p = new SqlParams();
  const placeholders = keys.map((k) => p.add(row[k]));
  return {
    text: `INSERT INTO ${ident(table)} (${keys.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING ${returning}`,
    values: p.values,
  };
}

/**
 * `UPDATE table SET (whitelisted columns present in data) WHERE key = ... RETURNING ...`,
 * or null when `data` contains no whitelisted column.
 */
export function updateSql(
  table: string,
  columns: readonly string[],
  data: object,
  where: Record<string, unknown>,
  returning = 'id',
): Sql | null {
  const row = pickColumns(data, columns);
  const keys = Object.keys(row);
  if (keys.length === 0) return null;
  const p = new SqlParams();
  const set = keys.map((k) => `${k} = ${p.add(row[k])}`);
  const conds = Object.entries(where).map(([k, v]) => `${ident(k)} = ${p.add(v)}`);
  return {
    text: `UPDATE ${ident(table)} SET ${set.join(', ')} WHERE ${conds.join(' AND ')} RETURNING ${returning}`,
    values: p.values,
  };
}

/** Escapes `%`, `_` and `\` for use inside an ILIKE pattern. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
