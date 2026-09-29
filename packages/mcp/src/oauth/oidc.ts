/**
 * OIDC Relying Party for the sign-in page (single sign-on, e.g. authentik).
 *
 * This server is an OIDC *client* of the IdP (OIDC_ISSUER) and never an OpenID Provider: it sends the
 * browser to the IdP, receives the code at `<MCP_PUBLIC_URL>/oidc/callback` and runs the code grant with
 * PKCE, state and nonce (openid-client). The ID token is then handed to the Sermonize API
 * (`POST /auth/oidc`, client `mcp`), which verifies it again on its own, maps the identity to a Sermonize
 * account and returns the same kind of API token as a password sign-in. From there the OAuth
 * authorization continues exactly as after a password sign-in (pending grant, consent page).
 *
 * Discovery happens lazily on first use; the promise is cached and dropped on failure, so the server
 * starts (and password sign-in keeps working) while the IdP is down.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as client from 'openid-client';
import type { OidcConfig } from '../config.js';

/** How long a started sign-in may take at the IdP (state row and cookie lifetime). */
export const OIDC_STATE_TTL_MS = 10 * 60_000;
/** httpOnly cookie that binds a sign-in's state to the browser that started it (login CSRF). */
export const OIDC_COOKIE = 'sermonize_mcp_oidc';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export interface OidcState {
  codeVerifier: string;
  nonce: string;
  /** Only 'oauth' (the MCP authorize page) exists here; the column keeps room for a web sign-in. */
  purpose: 'oauth';
  /** The encoded pending OAuth request (the sign-in page's `oauth` value). */
  oauth: string;
}

/** Sign-ins in progress, keyed by SHA-256 of their state; single use, expiring after OIDC_STATE_TTL_MS. */
export class OidcStateStore {
  constructor(private readonly db: DatabaseSync) {}

  save(state: string, value: OidcState, now = Date.now()): void {
    this.db.prepare('DELETE FROM oidc_states WHERE expires < ?').run(now); // opportunistic cleanup
    this.db
      .prepare('INSERT INTO oidc_states (state_sha256, code_verifier, nonce, purpose, oauth, expires) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(state), value.codeVerifier, value.nonce, value.purpose, value.oauth, now + OIDC_STATE_TTL_MS);
  }

  /** Deletes and returns the unexpired row of this state (so each state works once). */
  consume(state: string, now = Date.now()): OidcState | undefined {
    const row = this.db
      .prepare('DELETE FROM oidc_states WHERE state_sha256 = ? RETURNING code_verifier, nonce, purpose, oauth, expires')
      .get(sha256(state)) as { code_verifier: string; nonce: string; purpose: string; oauth: string | null; expires: number } | undefined;
    if (!row || row.expires < now || row.purpose !== 'oauth' || !row.oauth) return undefined;
    return { codeVerifier: row.code_verifier, nonce: row.nonce, purpose: 'oauth', oauth: row.oauth };
  }
}

/** The result of a successful code grant: what the API needs, plus a label for the consent page. */
export interface OidcSignIn {
  idToken: string;
  /** The IdP access token, only when the ID token has no email (the API then reads userinfo). */
  accessToken?: string;
  /** Email, username or name from the ID token, for the consent page. */
  label: string;
}

export class OidcRelyingParty {
  private discovered: Promise<client.Configuration> | undefined;
  readonly redirectUri: string;

  constructor(
    readonly config: OidcConfig,
    publicUrl: string,
  ) {
    this.redirectUri = publicUrl + '/oidc/callback';
  }

  private async discover(): Promise<client.Configuration> {
    const issuer = new URL(this.config.issuer);
    const insecure = issuer.protocol === 'http:' && !this.config.production;
    const auth = this.config.clientSecret ? client.ClientSecretBasic(this.config.clientSecret) : client.None();
    const configuration = await client.discovery(
      issuer,
      this.config.clientId,
      undefined,
      auth,
      insecure ? { execute: [client.allowInsecureRequests] } : undefined,
    );
    return configuration;
  }

  /** The discovered configuration; retried on the next call after a failure. */
  configuration(): Promise<client.Configuration> {
    this.discovered ??= this.discover().catch((error: unknown) => {
      this.discovered = undefined;
      throw error;
    });
    return this.discovered;
  }

  /** New state, nonce and PKCE verifier, and the IdP authorization URL that carries them. */
  async start(): Promise<{ url: URL; state: string; nonce: string; codeVerifier: string }> {
    const configuration = await this.configuration();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const codeVerifier = client.randomPKCECodeVerifier();
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.redirectUri,
      scope: this.config.scopes,
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
    return { url, state, nonce, codeVerifier };
  }

  /**
   * Exchanges the code in `callbackQuery` (the raw query string of the callback) with PKCE, state and
   * nonce checks, and returns the ID token. Throws on any failure.
   */
  async finish(callbackQuery: string, expected: { state: string; nonce: string; codeVerifier: string }): Promise<OidcSignIn> {
    const configuration = await this.configuration();
    const currentUrl = new URL(this.redirectUri);
    currentUrl.search = callbackQuery;
    const tokens = await client.authorizationCodeGrant(configuration, currentUrl, {
      pkceCodeVerifier: expected.codeVerifier,
      expectedState: expected.state,
      expectedNonce: expected.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!tokens.id_token || !claims) throw new Error('the IdP returned no ID token');
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const email = text(claims.email);
    return {
      idToken: tokens.id_token,
      ...(email ? {} : { accessToken: tokens.access_token }),
      label: email ?? text(claims.preferred_username) ?? text(claims.name) ?? 'your single sign-on account',
    };
  }
}

/** The value of one cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/** Set-Cookie value for the state cookie (Path=/oidc; `maxAge` 0 clears it). */
export function stateCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${OIDC_COOKIE}=${value}; Path=/oidc; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
