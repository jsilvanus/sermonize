import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SqliteApiTokenStore } from '../src/storage/api-tokens.js';
import { decryptToken, encryptToken, parseTokenKey } from '../src/token-crypto.js';

const key = randomBytes(32);
const token = 'smz_0123456789abcdef-secret';

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
    const a = encryptToken(key, 'alice', token);
    const b = encryptToken(key, 'alice', token);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(a).not.toContain(token);
    expect(decryptToken(key, 'alice', a)).toBe(token);
    expect(decryptToken(key, 'alice', b)).toBe(token);
  });

  it('detects tampering with the IV, ciphertext or tag', () => {
    const stored = encryptToken(key, 'alice', token);
    for (const part of [1, 2, 3]) {
      expect(() => decryptToken(key, 'alice', tamper(stored, part))).toThrow(/failed authentication/);
    }
  });

  it('is bound to the user id and the key', () => {
    const stored = encryptToken(key, 'alice', token);
    expect(() => decryptToken(key, 'mallory', stored)).toThrow(/failed authentication/);
    expect(() => decryptToken(randomBytes(32), 'alice', stored)).toThrow(/failed authentication/);
  });

  it('rejects malformed values', () => {
    expect(() => decryptToken(key, 'alice', 'plaintext-token')).toThrow(/format/);
    expect(() => decryptToken(key, 'alice', 'v2.a.b.c')).toThrow(/format/);
    expect(() => decryptToken(key, 'alice', 'v1.AAAA.BBBB.CCCC')).toThrow(/format/);
  });

  it('parses SERMONIZE_TOKEN_KEY', () => {
    expect(parseTokenKey(key.toString('base64'))).toEqual(key);
    expect(parseTokenKey(key.toString('base64url'))).toEqual(key);
    expect(() => parseTokenKey(undefined)).toThrow(/required/);
    expect(() => parseTokenKey(randomBytes(16).toString('base64'))).toThrow(/exactly 32 bytes/);
  });
});

describe('SqliteApiTokenStore', () => {
  it('stores tokens encrypted and returns them decrypted', () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteApiTokenStore(db, key);
    expect(store.get('alice')).toBeUndefined();
    store.set('alice', token);
    expect(store.has('alice')).toBe(true);
    expect(store.get('alice')).toBe(token);

    const raw = db.prepare('SELECT ciphertext FROM sermonize_api_tokens WHERE user_id = ?').get('alice') as { ciphertext: string };
    expect(raw.ciphertext).not.toContain(token);

    store.set('alice', 'replacement');
    expect(store.get('alice')).toBe('replacement');

    // A row copied to another user does not decrypt for them.
    db.prepare('INSERT INTO sermonize_api_tokens (user_id, ciphertext, updated_at) VALUES (?, ?, ?)').run('bob', raw.ciphertext, 0);
    expect(() => store.get('bob')).toThrow(/failed authentication/);

    expect(store.delete('alice')).toBe(true);
    expect(store.get('alice')).toBeUndefined();
    db.close();
  });
});
