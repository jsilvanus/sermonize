/**
 * Upstream sessions: the Sermonize API token behind each OAuth grant.
 *
 * Sign-in on the OAuth page calls the API's `POST /auth/login` (client `mcp`); the returned token is
 * stored encrypted with the grant (src/storage/grants.ts). Tool calls resolve it by the access
 * token's `sid` claim. A grant ends when its refresh token expires (swept periodically, and noticed
 * at refresh time), when it is denied at the consent step or never approved, or when the API rejects
 * its token (401). Ending a grant deletes it with its codes and refresh tokens, so the client has to
 * re-authorize; if the token may still be valid, it is also revoked upstream with `POST /auth/logout`
 * (best-effort).
 */
import { SermonizeApiError, type SermonizeClient } from './connector.js';
import type { GrantStore } from './storage/interface.js';

export type SignInResult =
  | { ok: true; userId: string; role: string; apiToken: string; expiresAt: number }
  | { ok: false; reason: 'invalid_credentials' | 'rate_limited' | 'unavailable' };

interface Logger {
  warn(obj: object, msg: string): void;
}

export class UpstreamSessions {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    readonly store: GrantStore,
    private readonly client: SermonizeClient,
    private readonly log: Logger,
  ) {}

  /** Verifies the credentials with the API. Never throws for API/transport failures. */
  async signIn(email: string, password: string, clientIp: string | undefined): Promise<SignInResult> {
    try {
      const res = await this.client.login({ email, password }, clientIp);
      const expiresAt = Date.parse(res.expires_at);
      if (typeof res.token !== 'string' || typeof res.user_id !== 'string' || !Number.isFinite(expiresAt)) {
        this.log.warn({}, 'unexpected POST /auth/login response from the Sermonize API');
        return { ok: false, reason: 'unavailable' };
      }
      return { ok: true, userId: res.user_id, role: res.role, apiToken: res.token, expiresAt };
    } catch (error) {
      if (error instanceof SermonizeApiError) {
        if (error.status === 429) return { ok: false, reason: 'rate_limited' };
        if (error.status === 400 || error.status === 401 || error.status === 403) return { ok: false, reason: 'invalid_credentials' };
        this.log.warn({ status: error.status, code: error.code }, 'Sermonize API sign-in failed');
      } else {
        this.log.warn({ err: error }, 'Sermonize API sign-in failed');
      }
      return { ok: false, reason: 'unavailable' };
    }
  }

  /** The API token of an active grant of this user, or undefined (ended, expired, or undecryptable). */
  apiToken(grantId: string, userId: string): string | undefined {
    try {
      return this.store.getApiToken(grantId, userId);
    } catch {
      // Stored with another SERMONIZE_TOKEN_KEY or tampered with: unusable, so end it.
      this.store.deleteGrant(grantId);
      return undefined;
    }
  }

  isActive(grantId: string, userId: string): boolean {
    const grant = this.store.getGrant(grantId);
    return grant !== undefined && grant.subject === userId && grant.apiTokenExpires > Date.now();
  }

  /** The API rejected the grant's token: forget the grant so the client must re-authorize. */
  invalidate(grantId: string): void {
    this.store.deleteGrant(grantId);
  }

  /** Ends a grant and revokes its API token upstream (best-effort). */
  async end(grantId: string): Promise<void> {
    const deleted = this.store.deleteGrant(grantId);
    if (deleted?.apiToken) await this.logout(deleted.apiToken);
  }

  /** Revokes an API token that is no longer needed (best-effort; a 401 means it was already invalid). */
  async logout(apiToken: string): Promise<void> {
    try {
      await this.client.logout(apiToken);
    } catch (error) {
      if (!(error instanceof SermonizeApiError && error.status === 401)) {
        this.log.warn({ code: error instanceof SermonizeApiError ? error.code : 'error' }, 'could not revoke an ended grant\'s API token');
      }
    }
  }

  /** Ends every grant whose refresh token (or pending sign-in) has expired. */
  async sweep(now = Date.now()): Promise<number> {
    const tokens = this.store.deleteEndedGrants(now);
    await Promise.all(tokens.map((t) => this.logout(t)));
    return tokens.length;
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.sweep().catch(() => undefined), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
