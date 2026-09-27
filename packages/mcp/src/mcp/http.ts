import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createMcpServer } from './server.js';
import type { SermonizeClient } from '../connector.js';
import type { ApiTokenResolver } from '../storage/api-tokens.js';
import { verifyBearerToken } from '../auth.js';

export interface McpHttpOptions {
  client: SermonizeClient;
  apiTokens: ApiTokenResolver;
  publicUrl: string;
  jwtSecret: Uint8Array; resource: string;
  /**
   * true (default): every /mcp request needs a valid access token; others get 401 + WWW-Authenticate,
   * as the MCP authorization spec and ChatGPT expect. false: mixed mode — anonymous requests reach the
   * tools, and tools that need OAuth return the `mcp/www_authenticate` hint (see src/mcp/server.ts).
   */
  requireAuth?: boolean;
}

export function wwwAuthenticate(publicUrl: string, error?: string): string {
  return 'Bearer resource_metadata="' + publicUrl + '/.well-known/oauth-protected-resource/mcp", scope="mcp"' +
    (error ? ', error="' + error + '", error_description="The access token is missing, expired or invalid."' : '');
}

function methodNotAllowed() {
  return {
    jsonrpc: '2.0' as const,
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  };
}

export async function mountMcpHttp(app: FastifyInstance, options: McpHttpOptions): Promise<void> {
  app.post('/mcp', async (request, reply) => {
    let authInfo: AuthInfo | undefined;
    const header = request.headers.authorization;

    const requireAuth = options.requireAuth ?? true;
    const challenge = (error?: string) =>
      reply.code(401).header('WWW-Authenticate', wwwAuthenticate(options.publicUrl, error)).send({ error: error ?? 'unauthorized' });
    if (requireAuth && !header?.startsWith('Bearer ')) return challenge();

    if (header?.startsWith('Bearer ')) {
      try {
        const token = header.slice('Bearer '.length);
        const payload = await verifyBearerToken(token, options.jwtSecret, options.publicUrl, options.resource);
        authInfo = {
          token,
          clientId: typeof payload.client_id === 'string' ? payload.client_id : 'oauth-client',
          scopes: typeof payload.scope === 'string' ? payload.scope.split(' ') : [],
          extra: {
            ...(typeof payload.sub === 'string' ? { userId: payload.sub } : {}),
          },
        };
      } catch {
        // An invalid token is never treated as anonymous: the client must refresh or re-authorize.
        return challenge('invalid_token');
      }
    }

    const server = createMcpServer({ client: options.client, apiTokens: options.apiTokens, publicUrl: options.publicUrl });
    const transport = new StreamableHTTPServerTransport({});
    await server.connect(transport as unknown as Transport);

    reply.hijack();
    reply.raw.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });

    const rawRequest = request.raw as IncomingMessage & { auth?: AuthInfo };
    if (authInfo) rawRequest.auth = authInfo;
    await transport.handleRequest(rawRequest, reply.raw, request.body);
  });

  app.head('/mcp', async (_request, reply) => reply.code(200).send());
  app.get('/mcp', async (_request, reply) => reply.code(405).send(methodNotAllowed()));
  app.delete('/mcp', async (_request, reply) => reply.code(405).send(methodNotAllowed()));
}
