-- Ops script (NOT a migration): least-privilege role for the API process.
--
-- Run as the schema owner / a superuser after `npm run migrate`, and again after
-- every migration that adds tables or functions:
--
--   psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/roles.sql
--   psql "$OWNER_DATABASE_URL" -c "ALTER ROLE sermonize_app PASSWORD '...'"
--
-- The API then connects as sermonize_app. That role:
--   * owns nothing, so it cannot disable triggers or alter tables;
--   * has no privileges on tables in schema `private` (auth identities, token
--     hashes, account PII); it reaches them only through SECURITY DEFINER functions;
--   * may only SELECT/INSERT audit_event (triggers also reject UPDATE/DELETE);
--   * may DELETE only from the replaceable join tables (work_person,
--     text_person, sermon_occasion); everything else is withdrawn, not deleted.
-- Immutability of text bodies and derived rows is enforced by triggers, which
-- apply to every role except the table owner disabling them.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sermonize_app') THEN
    CREATE ROLE sermonize_app LOGIN;
  END IF;
END $$;

-- public schema: use, but not create objects.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM sermonize_app;
GRANT USAGE ON SCHEMA public TO sermonize_app;

GRANT SELECT, INSERT, UPDATE ON
  app_user,
  person, work, work_person, sermon_occasion, source, text, text_person,
  segmentation, chunk, embedding_space, embedding,
  clustering_run, cluster, cluster_membership, label, label_review
TO sermonize_app;
GRANT DELETE ON work_person, text_person, sermon_occasion TO sermonize_app;
GRANT SELECT, INSERT ON audit_event TO sermonize_app;
GRANT SELECT ON schema_migrations TO sermonize_app;

-- private schema: function lookup only; no table access.
REVOKE ALL ON SCHEMA private FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA private FROM sermonize_app;
GRANT USAGE ON SCHEMA private TO sermonize_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  private.resolve_token(text),
  private.create_api_token(uuid, text, text, timestamptz),
  private.revoke_api_token(uuid),
  private.set_user_pii(uuid, text, text),
  -- 0003_password_auth: self-registration, login and logout (no admin principal needed)
  private.register_user(text, text, text, text),
  private.get_password_credential(text),
  private.create_login_token(uuid, text, timestamptz, text), -- signature since 0004_login_token_client
  private.revoke_own_token(text)
TO sermonize_app;
