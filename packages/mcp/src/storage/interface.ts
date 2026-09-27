export interface AuthorizationCodeRecord {
  code: string;
  /** The OAuth grant this code belongs to (see GrantStore). */
  grantId: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  subject: string;
  scope: string;
  expires: number;
}

export interface RefreshTokenRecord {
  token: string;
  /** The OAuth grant this refresh token belongs to (see GrantStore). */
  grantId: string;
  clientId: string;
  subject: string;
  scope: string;
  expires: number;
}

export interface AuthStore {
  saveAuthorizationCode(record: AuthorizationCodeRecord): void;
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | undefined;
  saveRefreshToken(record: RefreshTokenRecord): void;
  getRefreshToken(token: string): RefreshTokenRecord | undefined;
}

/**
 * One OAuth grant: a user's sign-in for one client, from the sign-in page through the authorization
 * code to its refresh token (the "refresh-token family"). It holds the Sermonize API token that the
 * sign-in obtained from `POST /auth/login`, encrypted, and ends when the refresh token expires or
 * the API rejects the upstream token.
 *
 * A grant is *pending* between a successful sign-in and the consent decision; only active grants
 * resolve to an API token.
 */
export interface GrantRecord {
  id: string;
  /** The Sermonize API user id (the OAuth `sub`). */
  subject: string;
  clientId: string;
  /** When the upstream API token expires (epoch ms); nothing derived from the grant may outlive it. */
  apiTokenExpires: number;
  /** When the grant ends (epoch ms): pending timeout, then the refresh token's expiry. */
  expires: number;
}

export interface NewGrant extends GrantRecord {
  apiToken: string;
  /** Secret handed to the consent form; the grant stays pending until it is presented. */
  ticket: string;
  /** Binds the ticket to the OAuth request it was issued for. */
  requestFingerprint: string;
}

export interface GrantStore {
  createPendingGrant(grant: NewGrant): void;
  /**
   * Consumes the ticket of a pending, unexpired grant issued for the same OAuth request and makes it
   * active with the new expiry. Undefined if there is no such grant.
   */
  activateGrant(ticket: string, requestFingerprint: string, expires: number): GrantRecord | undefined;
  /** An active, unexpired grant. */
  getGrant(id: string): GrantRecord | undefined;
  setGrantExpiry(id: string, expires: number): void;
  /** The decrypted API token of an active, unexpired grant of this subject (throws if it fails to decrypt). */
  getApiToken(id: string, subject: string): string | undefined;
  /** Deletes a grant with its codes and refresh tokens; returns its API token if it can be decrypted. */
  deleteGrant(id: string): { apiToken?: string } | undefined;
  /** Deletes every grant that has ended (and its codes/refresh tokens); returns their API tokens. */
  deleteEndedGrants(now: number): string[];
}
