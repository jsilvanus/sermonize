-- Login tokens per client: POST /auth/login takes `client: 'web' | 'mcp'`.
--
-- 0003's create_login_token hard-coded the token name 'login'. The name is now
-- the client that asked for the token ('web' for @sermonize/web sessions, 'mcp'
-- for @sermonize/mcp OAuth grants), so an admin listing a user's tokens can tell
-- them apart and they can get different lifetimes (LOGIN_TOKEN_TTL_HOURS,
-- MCP_LOGIN_TOKEN_TTL_HOURS). Tokens issued before this migration keep the name
-- 'login'.
--
-- The function gains a parameter, so it is dropped and recreated. Dropping it
-- also drops the EXECUTE grant roles.sql gave sermonize_app; it is restored
-- below when that role exists, so an already-deployed API keeps working even
-- before roles.sql is re-run (roles.sql lists the new signature as well).

DROP FUNCTION private.create_login_token(uuid, text, timestamptz);

-- Stores the hash of a login token (name 'web' or 'mcp', mandatory future
-- expiry) for an active user that has a password. The password itself is
-- verified by the API before calling this. Actor: the user themself.
CREATE FUNCTION private.create_login_token(p_user_id uuid, p_token_sha256 text, p_expires_at timestamptz, p_client text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  prev_actor text := current_setting('app.user_id', true);
  new_id uuid;
BEGIN
  IF p_client IS NULL OR p_client NOT IN ('web', 'mcp') THEN
    RAISE EXCEPTION 'login token client must be web or mcp' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'login tokens need a future expiry' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_user u JOIN private.password_credential c ON c.user_id = u.id
                  WHERE u.id = p_user_id AND u.status = 'active') THEN
    RAISE EXCEPTION 'no active user with a password' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.user_id', p_user_id::text, true);
  INSERT INTO private.api_token (user_id, token_sha256, name, created_by, expires_at)
  VALUES (p_user_id, p_token_sha256, p_client, p_user_id, p_expires_at)
  RETURNING id INTO new_id;
  INSERT INTO public.audit_event (action, entity_type, entity_id, changes)
  VALUES ('token_create', 'api_token', new_id,
          jsonb_build_object('user_id', p_user_id, 'expires_at', p_expires_at, 'via', 'login', 'client', p_client));
  PERFORM set_config('app.user_id', coalesce(prev_actor, ''), true);
  RETURN new_id;
END $$;

REVOKE ALL ON FUNCTION private.create_login_token(uuid, text, timestamptz, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sermonize_app') THEN
    GRANT EXECUTE ON FUNCTION private.create_login_token(uuid, text, timestamptz, text) TO sermonize_app;
  END IF;
END $$;
