import type { FastifyInstance } from 'fastify';

export async function mountOAuthMetadata(app: FastifyInstance, publicUrl: string): Promise<void> {
  const metadata = {
    issuer: publicUrl,
    authorization_endpoint: publicUrl + '/oauth/authorize',
    token_endpoint: publicUrl + '/oauth/token',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };

  const protectedResource = {
    resource: publicUrl + '/mcp',
    authorization_servers: [publicUrl],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  };
  // RFC 9728: the metadata of resource <publicUrl>/mcp lives at the path-inserted URL; the root URL is kept for older clients.
  app.get('/.well-known/oauth-protected-resource/mcp', async (_request, reply) => reply.send(protectedResource));
  app.get('/.well-known/oauth-protected-resource', async (_request, reply) => reply.send(protectedResource));
  app.get('/.well-known/oauth-authorization-server', async (_request, reply) => reply.send(metadata));
  app.get('/.well-known/openid-configuration', async (_request, reply) => reply.send(metadata));
}
