import { Type } from '@fastify/type-provider-typebox';

export const Uuid = Type.String({ format: 'uuid' });
export const IdParams = Type.Object({ id: Uuid });

export const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    details: Type.Optional(Type.Unknown()),
  }),
});

// Keep in sync with ROLES / USER_KINDS in src/lib/principal.ts (and the CHECKs in the migration).
export const RoleSchema = Type.Union([
  Type.Literal('reader'),
  Type.Literal('contributor'),
  Type.Literal('curator'),
  Type.Literal('admin'),
]);
export const UserKindSchema = Type.Union([Type.Literal('human'), Type.Literal('service')]);

/** Standard error responses to spread into a route's `response` schema. */
export const errorResponses = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
  422: ErrorResponse,
};
