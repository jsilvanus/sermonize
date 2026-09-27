import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { personRoutes } from './persons.js';
import { sourceRoutes } from './sources.js';
import { textRoutes } from './texts.js';
import { workRoutes } from './works.js';

/** Scholarly layer: persons, works (+ persons, occasion), sources, texts (+ persons, body). */
export const scholarlyRoutes: FastifyPluginAsyncTypebox = async (app) => {
  await app.register(personRoutes);
  await app.register(workRoutes);
  await app.register(sourceRoutes);
  await app.register(textRoutes);
};
