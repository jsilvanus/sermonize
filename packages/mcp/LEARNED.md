# LEARNED — MCP API connector wrappers

Last reviewed: 2026-09-23.

## Core rule

**Connector code, MCP protocol code, and OAuth authorization code are separate layers.** A new wrapper should normally only need to change `src/connector.ts` and API configuration.

## Modern MCP baseline

Target the MCP 2026-07-28 direction: Streamable HTTP, stateless request handling, resource-bound bearer tokens, issuer validation, and CIMD-first OAuth client identification. Re-check the current MCP specification and SDK before refreshing the scaffold.

## OAuth roles

The scaffold contains both roles:

1. **MCP Resource Server** — protects `/mcp`, validates bearer tokens, issuer, and MCP resource audience.
2. **Embedded OAuth Authorization Server** — exposes authorization/token endpoints so a tiny wrapper can run without first deploying another identity server.

Keep the two roles separate internally even though they are deployed by the same process.

## CIMD

CIMD means Client ID Metadata Document. The client identifier is an HTTPS URL identifying the metadata document. The authorization server dereferences it, verifies that the returned `client_id` matches, validates redirect URIs, and uses the metadata for the OAuth client.

The implementation includes SSRF-oriented protections: HTTPS-only client IDs, no userinfo/query/fragment, public DNS address checks, redirect limits, timeout, and document-size limits.

Do not blindly copy the older ptv-mcp OAuth service. Its useful lessons are extracted here; database, DCR, and application-specific concerns are intentionally left behind.

## PKCE and tokens

Authorization-code flow requires S256 PKCE. Authorization codes are short-lived and single-use. Access tokens are JWTs with issuer and MCP resource audience validation. Refresh tokens are opaque.

## 401 challenge on /mcp (farcmd-mcp, ChatGPT)

Answer every `/mcp` request that lacks a valid access token with **HTTP 401** and
`WWW-Authenticate: Bearer resource_metadata="<public URL>/.well-known/oauth-protected-resource/mcp", scope="mcp"`
(plus `error="invalid_token"` when a token was sent but failed verification). This is what the MCP authorization spec requires, and what ChatGPT relies on to discover and confirm the protected resource.

farcmd-mcp (and earlier this scaffold) let unauthenticated requests through and failed only inside the tools ("authentication at the tool boundary"). In ChatGPT, sign-in, consent and the token exchange all succeeded (`/oauth/token` 200). ChatGPT then re-read the metadata, never sent an authenticated `/mcp` request, and showed "error connecting". `mountMcpHttp` now defaults to `requireAuth: true`.

Mixed mode (`requireAuth: false`) is only for servers with genuinely anonymous tools. There, tools that need OAuth declare `securitySchemes` and return `_meta["mcp/www_authenticate"]`. ChatGPT shows its sign-in UI only when that value has both `error` and `error_description`. An invalid token is still answered with 401, never treated as anonymous.

Serve the protected resource metadata at the RFC 9728 path-inserted URL (`/.well-known/oauth-protected-resource/mcp` for resource `<public URL>/mcp`) and keep the root URL for older clients. The `resource` value must be identical everywhere: the metadata, the `resource` parameter clients send, and the access token's `aud`.

## Access token verification

Verify every bearer token's signature **and** its `iss` (the public URL) and `aud` (the MCP resource, `<public URL>/mcp`). An earlier version of `src/auth.ts` checked only the signature. MCP clients such as ChatGPT send `resource=<public URL>/mcp` to both the authorization and token endpoints and expect the token to be bound to it.

## Token endpoint client authentication (ChatGPT)

ChatGPT's CIMD document (`https://chatgpt.com/oauth/client.json`) sets `token_endpoint_auth_method: private_key_jwt` and also supports `none`. ChatGPT uses the intersection with the server's `token_endpoint_auth_methods_supported`. Advertise only methods the token endpoint actually verifies: `["none"]` (PKCE public client) is what this scaffold implements. Add `private_key_jwt` only together with verifying `client_assertion` against the client's `jwks_uri`. Other servers that advertised it without verifying it broke with ChatGPT.

Token responses carry `Cache-Control: no-store` (RFC 6749 §5.1).

## Browser security headers vs. the OAuth redirect (farcmd-mcp)

The consent form POSTs to `/oauth/authorize`, which answers with a 302 to the client's `redirect_uri`. Browsers enforce CSP `form-action` on **redirects that follow a form submission**, too. farcmd-mcp added a global `Content-Security-Policy: … form-action 'self'` in production. After that, approving in ChatGPT did nothing: no redirect, only a CSP error in the browser console. It did not reproduce in development, where the header was off.

Rule: any page whose form submission ends in a redirect to the OAuth client (the consent page) must add the client's redirect origin to `form-action`. For custom-scheme redirect URIs (`cursor://…`), add the scheme (`cursor:`), because their origin is opaque. The redirect URI is already validated against the CIMD document before it reaches the header. `src/csp.ts` and `sendHtml()` in `src/oauth/authorization-server.ts` do this. Keep it if you add global security headers (e.g. a Fastify `onSend` hook or helmet), and don't let a global hook overwrite a route's CSP.

## Deployment behind a reverse proxy

Terminate TLS at the proxy and set `MCP_PUBLIC_URL` to the public `https://` origin. With Docker and nginx on the host, publish the app on loopback only (`127.0.0.1:5999:5999`). Requests then arrive from the Docker network gateway, not 127.0.0.1, so a Fastify `trustProxy` setting must name that gateway. farcmd-mcp's `docker-compose.yml` / `docker-compose.traefik.yml` are working examples.

## Stateless MCP

Create the MCP server/transport per HTTP request. Authentication context is derived from the bearer token and attached to the request. Do not trust user or tenant identity supplied as ordinary tool arguments.

## Discovery

Expose:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- `/.well-known/openid-configuration` as interoperability metadata only

Do not add arbitrary well-known endpoints merely because a host probes them.

## Production hardening

The embedded AS is intentionally minimal. Before production, replace the demo identity/consent step, use durable token storage, add refresh-token rotation/revocation, consider CIMD metadata caching, and audit URL/IP validation against the exact current CIMD specification.

The purpose of this scaffold is the reusable architecture and a runnable development primitive — not a claim that the demo identity layer is production-ready.
