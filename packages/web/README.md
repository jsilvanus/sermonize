# @sermonize/web

A minimal, server-rendered web UI for Sermonize: a landing page with corpus counts, registration,
sign-in, an account page and sign-out.

- It talks **only** to the Sermonize REST API over HTTP (`SERMONIZE_API_URL`), never to PostgreSQL.
- Plain Fastify + HTML strings: no SPA framework and **no client-side JavaScript**. One stylesheet
  (`/style.css`), responsive down to phone width.
- All HTML is built with the `html` tagged template in [`src/html.ts`](src/html.ts), which escapes
  every interpolated value (including `"`, `'` and `` ` ``) unless it is itself an `Html` fragment.

## Pages

| route | does | API calls |
|---|---|---|
| `GET /` | corpus counts (works, sermons, texts, texts by language, persons, passages, embedding spaces, complete clustering runs); sign-in/register links or signed-in state | `GET /stats` (+ `GET /me` with a session) |
| `GET/POST /register` | registration form, only if the API reports `registration_open` | `GET /auth/config`, `POST /auth/register` |
| `GET/POST /login` | sign-in form; success stores the API token in the session cookie | `POST /auth/login` |
| `POST /logout` | revokes the API token and clears the cookie | `POST /auth/logout` |
| `GET /account` | user id, role and kind of the signed-in user | `GET /me` |
| `GET /style.css` | the stylesheet | |

Self-registered users get the API's `REGISTRATION_DEFAULT_ROLE` (`reader` or `contributor`). Higher
roles are granted by an admin through the API.

## Run

Requirements: Node.js >= 22.12 and a running Sermonize API. Registration needs
`REGISTRATION_OPEN=true` **on the API**.

```sh
# from the repository root
npm install
cp packages/web/.env.example packages/web/.env      # edit, then export (the server reads process.env only)
set -a; . packages/web/.env; set +a
export WEB_COOKIE_SECRET=$(openssl rand -base64 32)

npm run dev:web             # http://127.0.0.1:3100 (or: npm run build && npm start -w @sermonize/web)
```

## Environment

| variable | default | |
|---|---|---|
| `PORT` / `HOST` | `3100` / `127.0.0.1` | |
| `SERMONIZE_API_URL` | required | base URL of the REST API |
| `WEB_COOKIE_SECRET` | required | signs the session and CSRF cookies; at least 32 characters |
| `WEB_COOKIE_SECURE` | `true` if `NODE_ENV=production`, else `false` | `Secure` flag on cookies; must be `true` behind HTTPS |
| `SERMONIZE_REQUEST_TIMEOUT_MS` | `10000` | timeout of one API request |
| `LOG_LEVEL` | `info` | |

## Security notes

- **Session:** the cookie `sz_session` holds the user's API token (issued by `POST /auth/login`, named
  `login`, expiring after the API's `LOGIN_TOKEN_TTL_HOURS`). It is signed (`WEB_COOKIE_SECRET`),
  `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `WEB_COOKIE_SECURE=true`, and expires with the token.
  Every page resolves it with `GET /me`; a revoked or expired token clears the cookie. Rotating
  `WEB_COOKIE_SECRET` signs everyone out (the API tokens stay valid until they expire).
- **CSRF:** double-submit token. A random token lives in the signed, `HttpOnly` cookie `sz_csrf` and
  is repeated in a hidden `_csrf` field of every form; every POST (register, login, logout) must
  match it (403 otherwise). It is rotated at sign-in and sign-out. `SameSite=Lax` is a second layer.
- **Headers:** `Content-Security-Policy: default-src 'self'; script-src 'none'; object-src 'none';
  base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` on pages.
- **Passwords** are only passed through to the API (argon2id hashing happens there) and are never
  echoed back into a form. Error messages are generic ("Invalid email or password.").
- **Rate limiting** of register/login is done by the API per client IP. The web app forwards the
  browser's IP as `X-Forwarded-For`; the API only trusts it when its `TRUST_PROXY` lists the web
  server's address (e.g. `TRUST_PROXY=127.0.0.1`). Without that, all web users share one bucket.
  The web app itself does not set `trustProxy`: behind another reverse proxy, `request.ip` is that
  proxy's address.
- If the API is unreachable (or answers 5xx), pages show a friendly 503 page; details go to the log only.

## Tests

`npm test -w @sermonize/web` starts the real API (`buildApp` from `@sermonize/api`, resolved to its
TypeScript sources via the `@sermonize/source` export condition) on an ephemeral port against
`TEST_DATABASE_URL`, and drives the web app with `inject`. Like the MCP suite it only applies pending
migrations to the shared test database and never resets it; tests use unique emails and compare
against the API's own `/stats`.
