/**
 * sql/roles.sql: the application role cannot read the private schema directly,
 * but can use the SECURITY DEFINER functions. Uses SET ROLE on one connection.
 */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { hashToken } from '../src/lib/tokens.js';
import { createTestPool, createUser, expectPgError, type TestUser } from './helpers.js';

describe('sql/roles.sql (sermonize_app)', () => {
  let pool: Pool;
  let client: PoolClient;
  let user: TestUser;

  beforeAll(async () => {
    pool = createTestPool();
    await pool.query(await readFile(new URL('../sql/roles.sql', import.meta.url), 'utf8'));
    user = await createUser(pool, { role: 'contributor' });
    client = await pool.connect();
    await client.query('SET ROLE sermonize_app');
  });
  afterAll(async () => {
    await client.query('RESET ROLE');
    client.release();
    await pool.end();
  });

  it('is idempotent', async () => {
    await pool.query(await readFile(new URL('../sql/roles.sql', import.meta.url), 'utf8'));
  });

  it('cannot read private tables', async () => {
    await expectPgError(client.query('SELECT * FROM private.user_pii'), '42501');
    await expectPgError(client.query('SELECT * FROM private.api_token'), '42501');
    await expectPgError(client.query('SELECT * FROM private.auth_identity'), '42501');
    await expectPgError(client.query('SELECT * FROM private.password_credential'), '42501');
  });

  it('can self-register readers/contributors without an admin principal, but nothing more', async () => {
    const hash = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';
    await client.query('BEGIN');
    try {
      const { rows } = await client.query(`SELECT private.register_user('reader', 'roles-test@example.org', null, $1) AS id`, [hash]);
      expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
      await client.query('SAVEPOINT s');
      await expectPgError(client.query(`SELECT private.register_user('admin', 'roles-test-2@example.org', null, $1)`, [hash]), '42501');
      await client.query('ROLLBACK TO SAVEPOINT s');
      const cred = await client.query('SELECT user_id, role, status FROM private.get_password_credential($1)', ['ROLES-TEST@example.org']);
      expect(cred.rows).toEqual([{ user_id: rows[0].id, role: 'reader', status: 'active' }]);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('can resolve tokens through the SECURITY DEFINER function', async () => {
    const { rows } = await client.query('SELECT * FROM private.resolve_token($1)', [hashToken(user.token)]);
    expect(rows).toEqual([{ user_id: user.id, role: 'contributor', kind: 'human' }]);
  });

  it('can insert but not update audit_event', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.id]);
      await client.query(`INSERT INTO audit_event (action, entity_type) VALUES ('note', 'test')`);
      await expectPgError(client.query(`UPDATE audit_event SET action = 'x'`), '42501');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('PII functions still require an admin principal', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.id]);
      await expectPgError(client.query(`SELECT private.set_user_pii($1, 'a@b.c', null)`, [user.id]), '42501');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('cannot delete curated records', async () => {
    await expectPgError(client.query('DELETE FROM person'), '42501');
  });
});
