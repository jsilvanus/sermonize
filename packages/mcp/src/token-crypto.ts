/**
 * Encryption at rest for the per-user Sermonize API tokens (AES-256-GCM).
 *
 * Stored format: `v1.<base64url(iv)>.<base64url(ciphertext)>.<base64url(tag)>`, 12-byte random IV,
 * 16-byte tag. The MCP user id is bound as additional authenticated data, so a ciphertext copied to
 * another user's row fails to decrypt instead of silently granting that user's API access.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Parses SERMONIZE_TOKEN_KEY: base64 (or base64url) encoding of exactly 32 random bytes. */
export function parseTokenKey(value: string | undefined): Buffer {
  if (!value) throw new Error('SERMONIZE_TOKEN_KEY is required (base64 of 32 random bytes, e.g. `openssl rand -base64 32`)');
  const key = Buffer.from(value, 'base64'); // Node's base64 decoder also accepts the base64url alphabet
  if (key.length !== 32) throw new Error(`SERMONIZE_TOKEN_KEY must decode to exactly 32 bytes, got ${key.length}`);
  return key;
}

export function encryptToken(key: Buffer, userId: string, token: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(userId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [VERSION, iv, ciphertext, cipher.getAuthTag()]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

/** Throws if the value is malformed, was encrypted with another key or for another user, or was altered. */
export function decryptToken(key: Buffer, userId: string, stored: string): string {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('unsupported encrypted token format');
  const [iv, ciphertext, tag] = parts.slice(1).map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer];
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('unsupported encrypted token format');
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(userId, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('encrypted token failed authentication (wrong key, wrong user or tampered data)');
  }
}
