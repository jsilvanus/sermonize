/**
 * Verification of OIDC ID tokens for POST /auth/oidc.
 *
 * The API is not a Relying Party itself: the clients that sign users in at the IdP (the MCP server)
 * run the authorization-code flow and hand the ID token they received to the API. The API trusts
 * nothing the client says about the user; it verifies the ID token on its own:
 *   - signature against the issuer's JWKS (jwks_uri from OIDC discovery; asymmetric algorithms only),
 *   - `iss` equal to OIDC_ISSUER (and the discovery document's `issuer` too),
 *   - `aud` containing one of OIDC_CLIENT_IDS (and `azp`, if present, one of them),
 *   - `exp` in the future, `iat` at most 10 minutes old.
 * When the ID token carries no email, and the client sent the IdP access token, the email is read
 * from the IdP's userinfo endpoint, whose `sub` must equal the ID token's (OIDC Core 5.3.2).
 *
 * Discovery happens lazily on first use; the promise is cached, and dropped on failure so that a
 * later request retries (the API starts even when the IdP is down).
 */
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import type { OidcConfig } from '../config.js';
import { ApiError } from './errors.js';

/** Maximum age of an ID token presented to POST /auth/oidc (its `iat`). */
export const ID_TOKEN_MAX_AGE_SECONDS = 600;
const HTTP_TIMEOUT_MS = 10_000;
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

/** What the API uses from a verified identity. */
export interface OidcIdentity {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export interface OidcVerifier {
  readonly config: OidcConfig;
  /** Verifies the ID token (and reads userinfo if needed); throws ApiError 401/503. */
  verify(idToken: string, accessToken?: string): Promise<OidcIdentity>;
}

interface Discovered {
  jwks: ReturnType<typeof createRemoteJWKSet>;
  userinfoEndpoint: string | null;
}

export const invalidIdToken = () => new ApiError(401, 'invalid_id_token', 'the ID token is not valid for this API');
const unavailable = () => new ApiError(503, 'oidc_unavailable', 'the identity provider cannot be reached right now');

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** `<issuer without trailing slash>/.well-known/openid-configuration` (OIDC Discovery 1.0 §4). */
export function discoveryUrl(issuer: string): string {
  return issuer.replace(/\/+$/, '') + '/.well-known/openid-configuration';
}

export function createOidcVerifier(config: OidcConfig, fetchImpl: typeof fetch = fetch): OidcVerifier {
  let discovered: Promise<Discovered> | undefined;

  async function discover(): Promise<Discovered> {
    const res = await fetchImpl(discoveryUrl(config.issuer), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`OIDC discovery answered HTTP ${res.status}`);
    const doc = (await res.json()) as Record<string, unknown>;
    if (doc.issuer !== config.issuer) throw new Error('OIDC discovery document is for another issuer');
    if (typeof doc.jwks_uri !== 'string') throw new Error('OIDC discovery document has no jwks_uri');
    return {
      jwks: createRemoteJWKSet(new URL(doc.jwks_uri), { timeoutDuration: HTTP_TIMEOUT_MS }),
      userinfoEndpoint: typeof doc.userinfo_endpoint === 'string' ? doc.userinfo_endpoint : null,
    };
  }

  function metadata(): Promise<Discovered> {
    discovered ??= discover().catch((error: unknown) => {
      discovered = undefined; // retry on the next request
      throw error;
    });
    return discovered;
  }

  async function userinfo(endpoint: string, accessToken: string, subject: string): Promise<Record<string, unknown>> {
    const res = await fetchImpl(endpoint, {
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      redirect: 'error',
    });
    if (res.status === 401 || res.status === 403) throw invalidIdToken();
    if (!res.ok) throw unavailable();
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || body.sub !== subject) throw invalidIdToken();
    return body;
  }

  return {
    config,
    async verify(idToken, accessToken) {
      let meta: Discovered;
      try {
        meta = await metadata();
      } catch {
        throw unavailable();
      }
      let claims: JWTPayload;
      try {
        ({ payload: claims } = await jwtVerify(idToken, meta.jwks, {
          issuer: config.issuer,
          audience: config.clientIds,
          maxTokenAge: ID_TOKEN_MAX_AGE_SECONDS,
          requiredClaims: ['sub', 'iat', 'exp'],
          algorithms: ALGORITHMS,
        }));
      } catch (error) {
        // The JWKS could not be fetched: the IdP's fault, not the token's.
        if (error instanceof joseErrors.JWKSTimeout || (error instanceof Error && !(error instanceof joseErrors.JOSEError))) {
          throw unavailable();
        }
        throw invalidIdToken();
      }
      const subject = str(claims.sub);
      if (!subject) throw invalidIdToken();
      if (claims.azp !== undefined && !config.clientIds.includes(String(claims.azp))) throw invalidIdToken();

      let source: Record<string, unknown> = claims;
      if (!str(claims.email) && accessToken && meta.userinfoEndpoint) {
        try {
          source = { ...(await userinfo(meta.userinfoEndpoint, accessToken, subject)), sub: subject };
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw unavailable();
        }
      }
      return {
        issuer: config.issuer,
        subject,
        email: str(source.email),
        emailVerified: source.email_verified === true,
        name: str(source.name) ?? str(source.preferred_username),
      };
    },
  };
}
