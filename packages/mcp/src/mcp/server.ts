import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest, CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { describeApiError, SermonizeApiError, SIGN_IN_AGAIN, type ConnectorContext, type SermonizeClient } from '../connector.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
const oauthSecuritySchemes = [{ type: 'oauth2' as const, scopes: ['mcp'] }];

function withOAuthSecurity<T extends object>(config: T): T & { securitySchemes: typeof oauthSecuritySchemes } {
  return { ...config, securitySchemes: oauthSecuritySchemes };
}

function result(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function authError(publicUrl: string): CallToolResult {
  return {
    content: [{ type: 'text', text: 'Authentication required.' }],
    isError: true,
    _meta: {
      // ChatGPT needs both error and error_description here to show its sign-in UI.
      'mcp/www_authenticate': [
        'Bearer resource_metadata="' + publicUrl + '/.well-known/oauth-protected-resource/mcp", scope="mcp", ' +
          'error="insufficient_scope", error_description="Sign in to use this tool."',
      ],
    },
  };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Tool error when the grant's upstream API token is gone or was rejected by the API. Carries the
 * `mcp/www_authenticate` hint (with error and error_description, which ChatGPT needs) so clients
 * that support it offer to sign in again.
 */
function signInAgain(publicUrl: string): CallToolResult {
  return {
    content: [{ type: 'text', text: SIGN_IN_AGAIN }],
    isError: true,
    _meta: {
      'mcp/www_authenticate': [
        'Bearer resource_metadata="' + publicUrl + '/.well-known/oauth-protected-resource/mcp", scope="mcp", ' +
          'error="invalid_token", error_description="Your Sermonize sign-in has expired or was revoked. Please sign in again."',
      ],
    },
  };
}

/** The upstream Sermonize API token of an OAuth grant (see src/grants.ts). */
export interface UpstreamTokens {
  apiToken(grantId: string, userId: string): string | undefined;
  isActive(grantId: string, userId: string): boolean;
  /** Called when the API answered 401 for the grant's token: the grant ends, the client must re-authorize. */
  invalidate(grantId: string): void;
}

export interface McpServerOptions {
  client: SermonizeClient;
  /** Resolves the caller's grant (access token `sid`) to its Sermonize API token (never taken from tool arguments). */
  upstream: UpstreamTokens;
  publicUrl: string;
}

// --- shared input schemas -------------------------------------------------------------------
const id = (what: string) => z.uuid().describe(`${what} id (UUID).`);
const page = {
  cursor: z.string().min(1).max(200).optional().describe('next_cursor from the previous page.'),
  limit: z.number().int().min(1).max(500).optional().describe('Page size, 1-500 (API default 50).'),
};
const includeWithdrawn = z.boolean().optional().describe('Include withdrawn records (default false).');
const year = z.number().int().min(-10000).max(10000);
const languageTag = z.string().regex(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/).max(64);
const jsonObject = z.record(z.string(), z.unknown());
const genre = z.enum(['treatise', 'sermon', 'letter', 'confession', 'commentary', 'homily', 'hymn', 'other']);
const relation = z.enum(['original', 'translation', 'adaptation']);
const producer = z
  .object({
    tool: z.string().min(1),
    version: z.string().min(1),
  })
  .catchall(z.unknown())
  .describe('What produced this: { tool, version, commit?, parameters?, ... }.');

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** Every tool name with the minimum Sermonize role the API requires (documented in README). */
export const TOOL_ROLES: Record<string, 'reader' | 'contributor' | 'curator'> = {};

/** Drops undefined values, so optional arguments are simply not sent. */
function defined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as never;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer({ name: 'sermonize-mcp', version: '0.1.0' });
  const api = options.client;

  /**
   * Registers a tool that relays to the API as the calling MCP user. The handler only maps
   * arguments; authentication, token lookup and error mapping happen here.
   */
  function tool<Shape extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; role: 'reader' | 'contributor' | 'curator'; write?: boolean; input: Shape },
    run: (args: z.infer<z.ZodObject<Shape>>, context: ConnectorContext) => Promise<unknown>,
  ): void {
    TOOL_ROLES[name] = config.role;
    const handler = async (args: z.infer<z.ZodObject<Shape>>, extra: Extra): Promise<CallToolResult> => {
      const userId = extra.authInfo?.extra?.userId;
      const grantId = extra.authInfo?.extra?.grantId;
      if (!extra.authInfo?.token || typeof userId !== 'string') return authError(options.publicUrl);
      const apiToken = typeof grantId === 'string' ? options.upstream.apiToken(grantId, userId) : undefined;
      if (!apiToken) return signInAgain(options.publicUrl);
      try {
        return result(await run(args, { apiToken }));
      } catch (error) {
        if (error instanceof SermonizeApiError && error.status === 401) {
          // Expired, revoked, or the account was disabled: end the grant so the client re-authorizes.
          options.upstream.invalidate(grantId as string);
          return signInAgain(options.publicUrl);
        }
        return errorResult(describeApiError(error));
      }
    };
    server.registerTool(
      name,
      withOAuthSecurity({
        title: config.title,
        description: `${config.description} Requires Sermonize role ${config.role} or higher.`,
        inputSchema: config.input,
        annotations: { title: config.title, ...(config.write ? WRITE : READ) },
      }),
      handler as never,
    );
  }

  // --- identity -----------------------------------------------------------------------------
  tool('whoami', {
    title: 'Who am I',
    description: 'Your Sermonize user id, role (reader < contributor < curator < admin) and kind, as seen by the API.',
    role: 'reader',
    input: {},
  }, (_args, c) => api.me(c));

  // --- scholarly: persons -------------------------------------------------------------------
  tool('search_persons', {
    title: 'Search persons',
    description: 'List persons (authors, preachers, translators...), optionally filtered by a case-insensitive substring of the name or name variants. Paginated.',
    role: 'reader',
    input: { q: z.string().min(1).max(200).optional().describe('Name contains (case-insensitive).'), include_withdrawn: includeWithdrawn, ...page },
  }, (a, c) => api.listPersons(c, a));

  tool('get_person', {
    title: 'Get person',
    description: 'One person by id.',
    role: 'reader',
    input: { person_id: id('Person') },
  }, (a, c) => api.getPerson(c, a.person_id));

  tool('create_person', {
    title: 'Create person',
    description: 'Create a person record. Only a display name is required; years are integers (negative = BCE).',
    role: 'contributor',
    write: true,
    input: {
      display_name: z.string().min(1).max(1000),
      name_variants: z.array(z.string().min(1).max(1000)).optional(),
      is_living: z.boolean().nullable().optional(),
      year_from: year.nullable().optional(),
      year_to: year.nullable().optional(),
      date_note: z.string().max(1000).nullable().optional(),
      external_ids: jsonObject.optional().describe('e.g. { "viaf": "...", "gnd": "..." }'),
      metadata: jsonObject.optional(),
    },
  }, (a, c) => api.createPerson(c, defined(a)));

  // --- scholarly: works ---------------------------------------------------------------------
  tool('list_works', {
    title: 'List works',
    description: 'List works (sermons, treatises, confessions...), filtered by genre, person, part-of work or a year range that overlaps the work date (undated works excluded). Paginated.',
    role: 'reader',
    input: {
      genre: genre.optional(),
      person_id: z.uuid().optional().describe('Works linked to this person (any role).'),
      year_from: year.optional(),
      year_to: year.optional(),
      part_of_work_id: z.uuid().optional(),
      include_withdrawn: includeWithdrawn,
      ...page,
    },
  }, (a, c) => api.listWorks(c, a));

  tool('get_work', {
    title: 'Get work',
    description: 'One work by id, with its persons and sermon occasion.',
    role: 'reader',
    input: { work_id: id('Work') },
  }, (a, c) => api.getWork(c, a.work_id));

  tool('create_work', {
    title: 'Create work',
    description: 'Create a work, optionally with its persons and (for sermons) its occasion.',
    role: 'contributor',
    write: true,
    input: {
      title: z.string().min(1).max(2000),
      genre,
      title_variants: z.array(z.string().min(1).max(2000)).optional(),
      original_languages: z.array(languageTag).nullable().optional().describe('BCP 47 tags; null = unknown.'),
      part_of_work_id: z.uuid().nullable().optional(),
      year_from: year.nullable().optional(),
      year_to: year.nullable().optional(),
      date_note: z.string().max(1000).nullable().optional(),
      external_ids: jsonObject.optional(),
      metadata: jsonObject.optional(),
      persons: z.array(z.object({
        person_id: z.uuid(),
        role: z.enum(['author', 'attributed_author', 'pseudonymous_author', 'compiler']),
        certainty: z.enum(['certain', 'probable', 'disputed', 'spurious']).optional(),
        note: z.string().max(4000).nullable().optional(),
      })).max(1000).optional(),
      occasion: z.object({
        preached_on: z.iso.date().nullable().optional().describe('YYYY-MM-DD'),
        church_year_day: z.string().max(1000).nullable().optional(),
        lectionary: z.string().max(1000).nullable().optional(),
        lectionary_year: z.string().max(1000).nullable().optional(),
        pericopes: z.array(z.string().min(1).max(200)).optional(),
        place: z.string().max(1000).nullable().optional(),
        metadata: jsonObject.optional(),
      }).optional().describe('Sermon occasion.'),
    },
  }, (a, c) => api.createWork(c, defined(a)));

  // --- scholarly: sources -------------------------------------------------------------------
  tool('list_sources', {
    title: 'List sources',
    description: 'List sources (editions, manuscripts, transcripts, author submissions). Paginated.',
    role: 'reader',
    input: { include_withdrawn: includeWithdrawn, ...page },
  }, (a, c) => api.listSources(c, a));

  tool('get_source', {
    title: 'Get source',
    description: 'One source by id (citation, license, access level).',
    role: 'reader',
    input: { source_id: id('Source') },
  }, (a, c) => api.getSource(c, a.source_id));

  tool('create_source', {
    title: 'Create source',
    description: 'Create a source (where a text comes from). access_level "restricted" hides bodies of its texts from readers.',
    role: 'contributor',
    write: true,
    input: {
      kind: z.enum(['print_edition', 'digital_edition', 'manuscript', 'recording_transcript', 'author_submission', 'other']),
      citation: z.string().min(1).max(4000),
      editor: z.string().max(4000).nullable().optional(),
      title: z.string().max(4000).nullable().optional(),
      series: z.string().max(4000).nullable().optional(),
      volume: z.string().max(4000).nullable().optional(),
      publisher: z.string().max(4000).nullable().optional(),
      place: z.string().max(4000).nullable().optional(),
      year: year.nullable().optional(),
      url: z.string().max(4000).nullable().optional(),
      retrieved_at: z.iso.datetime({ offset: true }).nullable().optional(),
      license: z.string().max(4000).nullable().optional(),
      rights_holder: z.string().max(4000).nullable().optional(),
      access_level: z.enum(['public', 'restricted']).optional(),
      metadata: jsonObject.optional(),
    },
  }, (a, c) => api.createSource(c, defined(a)));

  // --- scholarly: texts ---------------------------------------------------------------------
  tool('list_texts', {
    title: 'List texts',
    description: 'List texts (metadata only, no bodies), filtered by work, language, relation or source. Paginated.',
    role: 'reader',
    input: {
      work_id: z.uuid().optional(),
      language: languageTag.optional(),
      relation: relation.optional(),
      source_id: z.uuid().optional(),
      include_withdrawn: includeWithdrawn,
      ...page,
    },
  }, (a, c) => api.listTexts(c, a));

  tool('get_text', {
    title: 'Get text',
    description: 'Text metadata by id: language, relation, char_length (code points), content_sha256, persons, effective_access_level. No body.',
    role: 'reader',
    input: { text_id: id('Text') },
  }, (a, c) => api.getText(c, a.text_id));

  tool('get_text_body', {
    title: 'Get text body',
    description: 'The body of a text, or the slice [start, end) in Unicode code points (0 <= start <= end <= char_length). Restricted texts need contributor.',
    role: 'reader',
    input: {
      text_id: id('Text'),
      start: z.number().int().min(0).optional().describe('Inclusive code-point offset (default 0).'),
      end: z.number().int().min(0).optional().describe('Exclusive code-point offset (default char_length).'),
    },
  }, (a, c) => api.getTextBody(c, a.text_id, { start: a.start, end: a.end }));

  tool('create_text', {
    title: 'Create text',
    description: 'Create a text of a work with its full body. The body must be NFC-normalised with \\n line endings and is immutable once stored (corrections are new texts with supersedes_text_id). Nothing is normalised for you.',
    role: 'contributor',
    write: true,
    input: {
      work_id: z.uuid(),
      language: languageTag,
      relation,
      body: z.string().min(1),
      source_id: z.uuid().nullable().optional(),
      translated_from_language: languageTag.nullable().optional(),
      base_text_id: z.uuid().nullable().optional(),
      base_note: z.string().max(4000).nullable().optional(),
      coverage: z.enum(['complete', 'partial', 'excerpt']).optional(),
      coverage_note: z.string().max(4000).nullable().optional(),
      year_from: year.nullable().optional(),
      year_to: year.nullable().optional(),
      date_note: z.string().max(1000).nullable().optional(),
      title: z.string().max(2000).nullable().optional(),
      supersedes_text_id: z.uuid().nullable().optional(),
      access_level: z.enum(['public', 'restricted']).optional(),
      metadata: jsonObject.optional(),
      persons: z.array(z.object({
        person_id: z.uuid(),
        role: z.enum(['translator', 'editor', 'transcriber', 'reviser']),
        note: z.string().max(4000).nullable().optional(),
      })).max(1000).optional(),
    },
  }, (a, c) => api.createText(c, defined(a)));

  // --- derived: chunks ----------------------------------------------------------------------
  tool('get_chunk', {
    title: 'Get chunk',
    description: 'One chunk: offsets, locus, text, effective access level. include_embeddings lists its embeddings (space summaries, no vectors). Restricted chunks need contributor.',
    role: 'reader',
    input: { chunk_id: id('Chunk'), include_embeddings: z.boolean().optional() },
  }, (a, c) => api.getChunk(c, a.chunk_id, { include_embeddings: a.include_embeddings }));

  tool('get_chunk_provenance', {
    title: 'Get chunk provenance',
    description: 'Full provenance of a chunk: segmentation and producer, text, source, work (authors, occasion), persons, embeddings and cluster memberships.',
    role: 'reader',
    input: { chunk_id: id('Chunk') },
  }, (a, c) => api.getChunkProvenance(c, a.chunk_id));

  // --- derived: embedding spaces and search -------------------------------------------------
  tool('list_embedding_spaces', {
    title: 'List embedding spaces',
    description: 'List embedding spaces (model, revision, dimensions, metric, query_prefix). Paginated.',
    role: 'reader',
    input: { include_withdrawn: includeWithdrawn, ...page },
  }, (a, c) => api.listEmbeddingSpaces(c, a));

  tool('get_embedding_space', {
    title: 'Get embedding space',
    description: 'One embedding space by id, including dimensions, metric, prefixes and HNSW index status.',
    role: 'reader',
    input: { embedding_space_id: id('Embedding space') },
  }, (a, c) => api.getEmbeddingSpace(c, a.embedding_space_id));

  tool('semantic_search', {
    title: 'Semantic search',
    description:
      'Nearest chunks to a query vector in one embedding space. You must supply a vector that was produced by that ' +
      "space's model (same revision, with its query_prefix and normalisation, exactly `dimensions` long): this server " +
      'and the API never compute embeddings, and vectors from other models or spaces give meaningless results. ' +
      'Restricted chunks are excluded unless filters.include_restricted (contributor).',
    role: 'reader',
    input: {
      embedding_space_id: id('Embedding space'),
      vector: z.array(z.number()).min(1).max(16000).describe('Query embedding produced in this space.'),
      limit: z.number().int().min(1).max(200).optional().describe('1-200, default 10.'),
      filters: z.object({
        language: languageTag.optional(),
        work_id: z.uuid().optional(),
        person_id: z.uuid().optional(),
        year_from: year.optional(),
        year_to: year.optional(),
        date_basis: z.enum(['text', 'work']).optional().describe('Which date the year range applies to (default text).'),
        relation: relation.optional(),
        genre: genre.optional(),
        include_restricted: z.boolean().optional(),
      }).optional(),
    },
  }, (a, c) => api.search(c, defined(a)));

  // --- derived: clustering ------------------------------------------------------------------
  tool('list_clustering_runs', {
    title: 'List clustering runs',
    description: 'List clustering runs, by embedding space and status (default complete; open/withdrawn/all need contributor). Paginated.',
    role: 'reader',
    input: {
      embedding_space_id: z.uuid().optional(),
      status: z.enum(['open', 'complete', 'withdrawn', 'all']).optional(),
      ...page,
    },
  }, (a, c) => api.listClusteringRuns(c, a));

  tool('get_clustering_run', {
    title: 'Get clustering run',
    description: 'One clustering run: algorithm, parameters, producer, status, cluster_count, input_size, noise_count.',
    role: 'reader',
    input: { run_id: id('Clustering run') },
  }, (a, c) => api.getClusteringRun(c, a.run_id));

  tool('list_run_clusters', {
    title: 'List run clusters',
    description: 'The clusters of a clustering run, ordered by cluster_number. Paginated.',
    role: 'reader',
    input: { run_id: id('Clustering run'), ...page },
  }, (a, c) => api.listRunClusters(c, a.run_id, { cursor: a.cursor, limit: a.limit }));

  tool('get_cluster', {
    title: 'Get cluster',
    description: 'One cluster: run, number, parent, size, member_count, label_count.',
    role: 'reader',
    input: { cluster_id: id('Cluster') },
  }, (a, c) => api.getCluster(c, a.cluster_id));

  tool('list_cluster_members', {
    title: 'List cluster members',
    description: 'Direct members of a cluster with chunk summary, text and work. Restricted chunks show text: null for readers. Paginated.',
    role: 'reader',
    input: { cluster_id: id('Cluster'), ...page },
  }, (a, c) => api.listClusterMembers(c, a.cluster_id, { cursor: a.cursor, limit: a.limit }));

  tool('list_cluster_labels', {
    title: 'List cluster labels',
    description: 'Labels of a cluster with derived status (proposed/accepted/rejected/needs_revision) and supersession. Paginated.',
    role: 'reader',
    input: { cluster_id: id('Cluster'), language: languageTag.optional(), ...page },
  }, (a, c) => api.listClusterLabels(c, a.cluster_id, { language: a.language, cursor: a.cursor, limit: a.limit }));

  tool('get_cluster_provenance', {
    title: 'Get cluster provenance',
    description: 'Provenance of a cluster: run (algorithm, parameters, producer), embedding space, input sizes, and every label with its reviews.',
    role: 'reader',
    input: { cluster_id: id('Cluster') },
  }, (a, c) => api.getClusterProvenance(c, a.cluster_id));

  // --- derived: labels ----------------------------------------------------------------------
  tool('propose_label', {
    title: 'Propose label',
    description:
      'Propose a label for a cluster of a complete run (research metadata about the cluster under this method). ' +
      'If an AI model (including you) wrote the label, use producer_kind "model" with model and producer; use "human" only ' +
      'for text a person wrote. Labels are immutable: a revision is a new label with supersedes_label_id.',
    role: 'contributor',
    write: true,
    input: {
      cluster_id: id('Cluster'),
      language: languageTag,
      label: z.string().min(1).max(1000),
      description: z.string().max(20000).nullable().optional(),
      producer_kind: z.enum(['human', 'model']),
      model: z.string().min(1).max(500).nullable().optional().describe('Required for producer_kind "model".'),
      model_version: z.string().min(1).max(500).nullable().optional(),
      producer: producer.nullable().optional().describe('Required for producer_kind "model": { tool, version, parameters? }.'),
      supersedes_label_id: z.uuid().nullable().optional(),
      metadata: jsonObject.optional(),
    },
  }, ({ cluster_id, ...body }, c) => api.proposeLabel(c, cluster_id, defined(body)));

  tool('review_label', {
    title: 'Review label',
    description: 'Record your review of a label: accepted, rejected or needs_revision (with an optional note). The reviewer is always you.',
    role: 'curator',
    write: true,
    input: {
      label_id: id('Label'),
      decision: z.enum(['accepted', 'rejected', 'needs_revision']),
      note: z.string().max(20000).nullable().optional(),
    },
  }, ({ label_id, ...body }, c) => api.reviewLabel(c, label_id, defined(body)));

  return server;
}
