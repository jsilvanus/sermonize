import { Type, type TSchema } from '@fastify/type-provider-typebox';

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

export function Nullable<T extends TSchema>(schema: T) {
  return Type.Union([schema, Type.Null()]);
}

export const DateTime = Type.String({ format: 'date-time' });
/** A JSON object (`metadata`, `external_ids`, …); any keys. */
export const JsonObject = Type.Object({}, { additionalProperties: true });
/** BCP 47 language tag (syntactic check; same pattern as the `language_tag` domain). */
export const LanguageTag = Type.String({ pattern: '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$', maxLength: 64 });
/** Year as an integer; negative = BCE. */
export const Year = Type.Integer({ minimum: -10000, maximum: 10000 });

/** created_* / updated_* columns, set by database triggers (never from request data). */
export const AuditFields = {
  created_by: Uuid,
  created_at: DateTime,
  updated_by: Uuid,
  updated_at: DateTime,
};

export const WithdrawnFields = {
  withdrawn_at: Nullable(DateTime),
  withdrawn_by: Nullable(Uuid),
  withdrawn_reason: Nullable(Type.String()),
};
