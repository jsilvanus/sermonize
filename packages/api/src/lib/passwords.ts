import { hash, verify } from '@node-rs/argon2';

/** Password length limits in Unicode code points (checked by POST /auth/register). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

// @node-rs/argon2 exports Algorithm as a const enum, which verbatimModuleSyntax cannot import.
const ARGON2ID = 2;

/** argon2id PHC string (library defaults: m=19456 KiB, t=2, p=1). */
export function hashPassword(password: string): Promise<string> {
  return hash(password, { algorithm: ARGON2ID });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false; // malformed hash
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies `password` against a fixed hash and discards the result, so that a
 * login for an unknown email takes about as long as one with a wrong password.
 */
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword('sermonize-dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
}

/** Length in code points (what users think of as characters, modulo combining marks). */
export function passwordLength(password: string): number {
  let n = 0;
  for (const _ of password) n++;
  return n;
}
