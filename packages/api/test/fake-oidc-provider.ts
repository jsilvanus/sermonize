/**
 * A small fake OpenID Connect provider for tests (node:http + jose, RS256), shaped like authentik:
 * the issuer has a path and a trailing slash (`http://127.0.0.1:<port>/application/o/sermonize/`).
 *
 * Serves `<issuer>.well-known/openid-configuration`, `/jwks`, `/authorize` (302 straight back to the
 * redirect_uri with code + state, signing in `provider.user` without any UI), `/token` (checks the code,
 * redirect_uri, client and the PKCE verifier; returns an ID token with the authorize request's nonce)
 * and `/userinfo`. `mintIdToken()` signs arbitrary ID tokens for API-level tests.
 *
 * Also used by the MCP server's tests (imported by relative path), so it depends only on node and jose.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from 'jose';

export interface FakeUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
}

export interface FakeOidcProviderOptions {
  clientId?: string;
  /** Set = confidential client (client_secret_basic or client_secret_post); unset = public client. */
  clientSecret?: string;
  /** Leave email/email_verified/name out of the ID token (they stay available at /userinfo). */
  idTokenWithoutProfile?: boolean;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  nonce: string | undefined;
  challenge: string | undefined;
  user: FakeUser;
}

export interface FakeOidcProvider {
  /** Issuer URL, with a trailing slash (like authentik). */
  issuer: string;
  /** Origin of the server. */
  origin: string;
  clientId: string;
  clientSecret: string | undefined;
  /** The user `/authorize` signs in (change it between tests). */
  user: FakeUser;
  /** Every `/authorize` request's query, newest last. */
  authorizeRequests: URLSearchParams[];
  /** Number of `/.well-known/openid-configuration` requests served. */
  discoveryRequests: number;
  /** Answer discovery with 503 while true. */
  down: boolean;
  /** Next `/authorize` answers with `?error=<value>` instead of a code (reset after use). */
  nextError: string | undefined;
  idTokenWithoutProfile: boolean;
  /** Signs an ID token with the provider's key. Claims default to a valid token for `clientId`. */
  mintIdToken(claims?: JWTPayload, options?: { kid?: string; alg?: string; key?: Parameters<SignJWT['sign']>[0] }): Promise<string>;
  /** An access token accepted by `/userinfo` for this user. */
  accessTokenFor(user: FakeUser): string;
  close(): Promise<void>;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeOidcProvider(options: FakeOidcProviderOptions = {}): Promise<FakeOidcProvider> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const kid = 'test-key-1';
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<string, PendingCode>();
  const accessTokens = new Map<string, FakeUser>();
  const path = '/application/o/sermonize/';

  let server: Server;
  const provider: FakeOidcProvider = {
    issuer: '',
    origin: '',
    clientId: options.clientId ?? 'sermonize-test-client',
    clientSecret: options.clientSecret,
    user: { sub: 'user-1', email: 'user1@example.org', email_verified: true, name: 'User One' },
    authorizeRequests: [],
    discoveryRequests: 0,
    down: false,
    nextError: undefined,
    idTokenWithoutProfile: options.idTokenWithoutProfile ?? false,
    async mintIdToken(claims = {}, signOptions = {}) {
      const now = Math.floor(Date.now() / 1000);
      const payload: JWTPayload = { iss: provider.issuer, aud: provider.clientId, sub: provider.user.sub, iat: now, exp: now + 300, ...claims };
      return new SignJWT(payload)
        .setProtectedHeader({ alg: signOptions.alg ?? 'RS256', kid: signOptions.kid ?? kid, typ: 'JWT' })
        .sign(signOptions.key ?? privateKey);
    },
    accessTokenFor(user) {
      const token = randomBytes(24).toString('base64url');
      accessTokens.set(token, user);
      return token;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', provider.origin);
    if (req.method === 'GET' && url.pathname === `${path}.well-known/openid-configuration`) {
      provider.discoveryRequests++;
      if (provider.down) return json(res, 503, { error: 'down' });
      return json(res, 200, {
        issuer: provider.issuer,
        authorization_endpoint: `${provider.origin}${path}authorize`,
        token_endpoint: `${provider.origin}${path}token`,
        userinfo_endpoint: `${provider.origin}${path}userinfo`,
        jwks_uri: `${provider.origin}${path}jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
        scopes_supported: ['openid', 'email', 'profile'],
      });
    }
    if (req.method === 'GET' && url.pathname === `${path}jwks`) return json(res, 200, { keys: [jwk] });

    if (req.method === 'GET' && url.pathname === `${path}authorize`) {
      const q = url.searchParams;
      provider.authorizeRequests.push(q);
      const redirectUri = q.get('redirect_uri');
      if (q.get('client_id') !== provider.clientId || !redirectUri || q.get('response_type') !== 'code') {
        return json(res, 400, { error: 'invalid_request' });
      }
      const target = new URL(redirectUri);
      if (provider.nextError) {
        target.searchParams.set('error', provider.nextError);
        provider.nextError = undefined;
      } else {
        const code = randomBytes(16).toString('base64url');
        codes.set(code, {
          clientId: provider.clientId,
          redirectUri,
          nonce: q.get('nonce') ?? undefined,
          challenge: q.get('code_challenge') ?? undefined,
          user: { ...provider.user },
        });
        target.searchParams.set('code', code);
      }
      const state = q.get('state');
      if (state) target.searchParams.set('state', state);
      target.searchParams.set('iss', provider.issuer);
      res.writeHead(302, { location: target.toString() });
      return void res.end();
    }

    if (req.method === 'POST' && url.pathname === `${path}token`) {
      const form = new URLSearchParams(await readBody(req));
      let clientId = form.get('client_id');
      let secret = form.get('client_secret');
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (basic) {
        const [id, pw] = Buffer.from(basic, 'base64').toString('utf8').split(':').map((s) => decodeURIComponent(s.replace(/\+/g, ' ')));
        clientId = id ?? null;
        secret = pw ?? null;
      }
      if (clientId !== provider.clientId) return json(res, 401, { error: 'invalid_client' });
      if (provider.clientSecret !== undefined && secret !== provider.clientSecret) return json(res, 401, { error: 'invalid_client' });
      const code = form.get('code') ?? '';
      const pending = codes.get(code);
      codes.delete(code);
      if (form.get('grant_type') !== 'authorization_code' || !pending || pending.redirectUri !== form.get('redirect_uri')) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      if (pending.challenge) {
        const verifier = form.get('code_verifier') ?? '';
        if (createHash('sha256').update(verifier).digest('base64url') !== pending.challenge) {
          return json(res, 400, { error: 'invalid_grant' });
        }
      }
      const { sub, ...profile } = pending.user;
      const idToken = await provider.mintIdToken({
        sub,
        ...(pending.nonce ? { nonce: pending.nonce } : {}),
        ...(provider.idTokenWithoutProfile ? {} : profile),
      });
      return json(res, 200, {
        access_token: provider.accessTokenFor(pending.user),
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
        scope: 'openid email profile',
      });
    }

    if (req.method === 'GET' && url.pathname === `${path}userinfo`) {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const user = token ? accessTokens.get(token) : undefined;
      if (!user) return json(res, 401, { error: 'invalid_token' });
      return json(res, 200, user);
    }
    json(res, 404, { error: 'not_found' });
  }

  server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'server_error' });
      else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  provider.origin = `http://127.0.0.1:${port}`;
  provider.issuer = `${provider.origin}${path}`;
  return provider;
}
