import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SqliteGrantStore } from '../src/storage/grants.js';
import type { NewGrant } from '../src/storage/interface.js';
import { initSchema, openDatabase, SCHEMA_VERSION } from '../src/storage/sqlite.js';
import { decryptToken, encryptToken, parseTokenKey } from '../src/token-crypto.js';

const key = randomBytes(32);
const token = 'sz_0123456789abcdef-secret';

/** Flips one bit in the given dot-separated part of the stored value. */
function tamper(stored: string, part: number): string {
  const parts = stored.split('.');
  const bytes = Buffer.from(parts[part]!, 'base64url');
  bytes[0]! ^= 0x01;
  parts[part] = bytes.toString('base64url');
  return parts.join('.');
}

describe('token encryption (AES-256-GCM)', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptToken(key, 'grant-a', token);
    const b = encryptToken(key, 'grant-a', token);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(a).not.toContain(token);
    expect(decryptToken(key, 'grant-a', a)).toBe(token);
    expect(decryptToken(key, 'grant-a', b)).toBe(token);
  });

  it('detects tampering with the IV, ciphertext or tag', () => {
    const stored = encryptToken(key, 'grant-a', token);
    for (const part of [1, 2, 3]) {
      expect(() => decryptToken(key, 'grant-a', tamper(stored, part))).toThrow(/failed authentication/);
    }
  });

  it('is bound to the grant id and the key', () => {
    const stored = encryptToken(key, 'grant-a', token);
    expect(() => decryptToken(key, 'grant-b', stored)).toThrow(/failed authentication/);
    expect(() => decryptToken(randomBytes(32), 'grant-a', stored)).toThrow(/failed authentication/);
  });

  it('rejects malformed values', () => {
    expect(() => decryptToken(key, 'grant-a', 'plaintext-token')).toThrow(/format/);
    expect(() => decryptToken(key, 'grant-a', 'v2.a.b.c')).toThrow(/format/);
    expect(() => decryptToken(key, 'grant-a', 'v1.AAAA.BBBB.CCCC')).toThrow(/format/);
  });

  it('parses SERMONIZE_TOKEN_KEY', () => {
    expect(parseTokenKey(key.toString('base64'))).toEqual(key);
    expect(parseTokenKey(key.toString('base64url'))).toEqual(key);
    expect(() => parseTokenKey(undefined)).toThrow(/required/);
    expect(() => parseTokenKey(randomBytes(16).toString('base64'))).toThrow(/exactly 32 bytes/);
  });
});

describe('SqliteGrantStore', () => {
  const hour = 3_600_000;
  const grant = (id: string, over: Partial<NewGrant> = {}): NewGrant => ({
    id,
    subject: 'user-1',
    clientId: 'https://client.example/c.json',
    apiToken: `${token}-${id}`,
    apiTokenExpires: Date.now() + 2 * hour,
    ticket: `ticket-${id}`,
    requestFingerprint: 'oauth-request',
    expires: Date.now() + 600_000,
    ...over,
  });

  it('stores the API token encrypted, bound to the grant, and resolves only active grants', () => {
    const db = openDatabase(':memory:');
    const store = new SqliteGrantStore(db, key);
    store.createPendingGrant(grant('g1'));
    const raw = db.prepare('SELECT api_token, ticket_sha256 FROM grants WHERE id = ?').get('g1') as { api_token: string; ticket_sha256: string };
    expect(raw.api_token).not.toContain(token);
    expect(raw.ticket_sha256).not.toContain('ticket-g1');

    // Pending grants resolve to nothing.
    expect(store.getGrant('g1')).toBeUndefined();
    expect(store.getApiToken('g1', 'user-1')).toBeUndefined();
    // Activation needs the ticket and the same OAuth request; the ticket is single-use.
    expect(store.activateGrant('ticket-g1', 'another-request', Date.now() + hour)).toBeUndefined();
    expect(store.activateGrant('ticket-g1', 'oauth-request', Date.now() + hour)).toMatchObject({ id: 'g1', subject: 'user-1' });
    expect(store.activateGrant('ticket-g1', 'oauth-request', Date.now() + hour)).toBeUndefined();

    expect(store.getApiToken('g1', 'user-1')).toBe(`${token}-g1`);
    expect(store.getApiToken('g1', 'user-2')).toBeUndefined();

    // A ciphertext copied to another grant does not decrypt there.
    store.createPendingGrant(grant('g2'));
    store.activateGrant('ticket-g2', 'oauth-request', Date.now() + hour);
    db.prepare('UPDATE grants SET api_token = ? WHERE id = ?').run(raw.api_token, 'g2');
    expect(() => store.getApiToken('g2', 'user-1')).toThrow(/failed authentication/);
    db.close();
  });

  it('deleting a grant removes its codes and refresh tokens; ended grants are swept', () => {
    const db = openDatabase(':memory:');
    const store = new SqliteGrantStore(db, key);
    store.createPendingGrant(grant('g1'));
    store.activateGrant('ticket-g1', 'oauth-request', Date.now() + hour);
    db.prepare("INSERT INTO refresh_tokens VALUES ('rt', 'g1', 'c', 'user-1', 'mcp', ?)").run(Date.now() + hour);
    db.prepare("INSERT INTO authorization_codes VALUES ('code', 'g1', 'c', 'r', 'ch', 'user-1', 'mcp', ?)").run(Date.now() + 60_000);
    expect(store.deleteGrant('g1')).toEqual({ apiToken: `${token}-g1` });
    expect(db.prepare('SELECT (SELECT count(*) FROM refresh_tokens) + (SELECT count(*) FROM authorization_codes) AS n').get()).toEqual({ n: 0 });
    expect(store.deleteGrant('g1')).toBeUndefined();

    store.createPendingGrant(grant('old', { expires: Date.now() - 1 }));
    store.createPendingGrant(grant('new'));
    expect(store.deleteEndedGrants(Date.now())).toEqual([`${token}-old`]);
    expect(db.prepare('SELECT id FROM grants').all().map((r) => (r as { id: string }).id)).toEqual(['new']);
    db.close();
  });
});

describe('SQLite schema', () => {
  it('creates the schema in a new file and refuses unknown versions', () => {
    const db = new DatabaseSync(':memory:');
    initSchema(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => (r as { name: string }).name);
    expect(tables).toEqual(['authorization_codes', 'grants', 'refresh_tokens']);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    initSchema(db); // idempotent
    db.exec('PRAGMA user_version = 99');
    expect(() => initSchema(db)).toThrow(/schema version 99/);
    db.close();
  });
});
