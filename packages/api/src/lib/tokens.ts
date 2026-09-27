import { createHash, randomBytes } from 'node:crypto';

const TOKEN_PREFIX = 'sz_';

/** A new random API token. Only its SHA-256 is stored; the plaintext is shown once. */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
