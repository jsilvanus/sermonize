import { SignJWT, jwtVerify } from 'jose';

/** Default access token lifetime, in seconds. */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;

export interface AccessTokenOptions {
  /** The OAuth grant (`sid` claim) whose upstream API token tool calls use. */
  grantId?: string;
  /** Absolute expiry (epoch seconds); defaults to now + ACCESS_TOKEN_TTL_SECONDS. */
  expiresAt?: number;
}

export async function issueAccessToken(
  secret: Uint8Array,
  issuer: string,
  resource: string,
  subject: string,
  clientId: string,
  scope: string,
  options: AccessTokenOptions = {},
) {
  return new SignJWT({ client_id: clientId, scope, ...(options.grantId ? { sid: options.grantId } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setIssuer(issuer)
    .setAudience(resource)
    .setIssuedAt()
    .setExpirationTime(options.expiresAt ?? Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS)
    .sign(secret);
}

export function verifyAccessToken(secret: Uint8Array, issuer: string, resource: string, token: string) {
  return jwtVerify(token, secret, { algorithms: ['HS256'], issuer, audience: resource });
}
