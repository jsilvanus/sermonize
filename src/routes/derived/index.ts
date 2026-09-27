import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DerivedOptions } from './common.js';
import { embeddingRoutes } from './embeddings.js';
import { searchRoutes } from './search.js';
import { segmentationRoutes } from './segmentations.js';

/** Derived layer: segmentations, chunks, embedding spaces, embeddings, search. */
export const derivedRoutes: FastifyPluginAsyncTypebox<DerivedOptions> = async (app, opts) => {
  await app.register(segmentationRoutes, opts);
  await app.register(embeddingRoutes, opts);
  await app.register(searchRoutes);
};
