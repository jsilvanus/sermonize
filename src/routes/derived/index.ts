import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { clusteringRoutes } from './clustering.js';
import { clusterRoutes } from './clusters.js';
import type { DerivedOptions } from './common.js';
import { embeddingRoutes } from './embeddings.js';
import { provenanceRoutes } from './provenance.js';
import { searchRoutes } from './search.js';
import { segmentationRoutes } from './segmentations.js';

/**
 * Derived layer: segmentations, chunks, embedding spaces, embeddings, search,
 * clustering runs, clusters, memberships, labels, reviews and provenance.
 */
export const derivedRoutes: FastifyPluginAsyncTypebox<DerivedOptions> = async (app, opts) => {
  await app.register(segmentationRoutes, opts);
  await app.register(embeddingRoutes, opts);
  await app.register(searchRoutes);
  await app.register(clusteringRoutes, opts);
  await app.register(clusterRoutes);
  await app.register(provenanceRoutes);
};
