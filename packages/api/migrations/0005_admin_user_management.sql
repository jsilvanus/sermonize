-- Admin user management (GET/PATCH /admin/users, passwords, token listing; used by
-- @sermonize/cli `sermonize-admin`) and the `cli` login client.
--
-- New SECURITY DEFINER functions, all of which require an active admin principal
-- (private.require_admin()):
--   admin_list_users       users with their PII (email, display name) and whether they
--                          have a password; filters, keyset pagination. Writes one
--                          `pii_read` audit event per call that returned rows (filter
--                          names only, never the search text or PII values).
--   admin_list_tokens      token metadata of a user (never hashes)
--   admin_update_user_pii  partial PII update (set_user_pii overwrites both fields)
--   admin_set_password     store an argon2id hash (hashed in Node) for a human user with
--                          an email; optionally revoke the user's tokens
--
-- create_login_token (same signature as 0004) also accepts the client 'cli'.
--
-- EXECUTE is granted to sermonize_app below when that role exists, so a running
-- deployment works before sql/roles.sql is re-run (roles.sql lists them too).

CREATE FUNCTION private.admin_list_users(
  p_id uuid, p_role text, p_status text, p_kind text, p_q text,
  p_after_created_at timestamptz, p_after_id uuid, p_limit integer)
RETURNS TABLE (id uuid, kind text, role text, status text, created_at timestamptz, updated_at timestamptz,
               email text, display_name text, has_password boolean, sort_created_at text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  PERFORM private.require_admin();
  RETURN QUERY
    SELECT u.id, u.kind, u.role, u.status, u.created_at, u.updated_at,
           p.email, p.display_name, (c.user_id IS NOT NULL),
           to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      FROM public.app_user u
      LEFT JOIN private.user_pii p ON p.user_id = u.id
      LEFT JOIN private.password_credential c ON c.user_id = u.id
     WHERE (p_id IS NULL OR u.id = p_id)
       AND (p_role IS NULL OR u.role = p_role)
       AND (p_status IS NULL OR u.status = p_status)
       AND (p_kind IS NULL OR u.kind = p_kind)
       -- p_q is an ILIKE pattern built (and escaped) by the caller
       AND (p_q IS NULL OR p.email ILIKE p_q OR p.display_name ILIKE p_q)
       AND (p_after_id IS NULL OR (u.created_at, u.id) > (p_after_created_at, p_after_id))
     ORDER BY u.created_at, u.id
     LIMIT p_limit;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    INSERT INTO public.audit_event (action, entity_type, entity_id, batch_count, changes)
    VALUES ('pii_read', 'user_pii', p_id, n,
            jsonb_strip_nulls(jsonb_build_object('role', p_role, 'status', p_status, 'kind', p_kind,
                                                 'q', CASE WHEN p_q IS NOT NULL THEN true END)));
  END IF;
END $$;

CREATE FUNCTION private.admin_list_tokens(p_user_id uuid)
RETURNS TABLE (id uuid, name text, created_by uuid, created_at timestamptz, expires_at timestamptz,
               revoked_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM private.require_admin();
  RETURN QUERY
    SELECT t.id, t.name, t.created_by, t.created_at, t.expires_at, t.revoked_at
      FROM private.api_token t
     WHERE t.user_id = p_user_id
     ORDER BY t.created_at, t.id;
END $$;

-- Updates only the fields whose p_set_* flag is true (NULL clears a field).
-- The audit event lists the changed field names, never their values.
CREATE FUNCTION private.admin_update_user_pii(p_user_id uuid, p_set_email boolean, p_email text,
                                              p_set_display_name boolean, p_display_name text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM private.require_admin();
  IF NOT (p_set_email OR p_set_display_name) THEN
    RETURN;
  END IF;
  INSERT INTO private.user_pii (user_id, email, display_name)
  VALUES (p_user_id, CASE WHEN p_set_email THEN p_email END,
          CASE WHEN p_set_display_name THEN p_display_name END)
  ON CONFLICT (user_id) DO UPDATE
    SET email = CASE WHEN p_set_email THEN EXCLUDED.email ELSE private.user_pii.email END,
        display_name = CASE WHEN p_set_display_name THEN EXCLUDED.display_name
                            ELSE private.user_pii.display_name END,
        updated_at = now();
  INSERT INTO public.audit_event (action, entity_type, entity_id, changes)
  VALUES ('pii_update', 'user_pii', p_user_id,
          jsonb_build_object('fields',
            to_jsonb(array_remove(ARRAY[CASE WHEN p_set_email THEN 'email' END,
                                        CASE WHEN p_set_display_name THEN 'display_name' END],
                                  NULL)),
            'via', 'admin'));
END $$;

-- Sets (or replaces) a user's password hash. Only human users with an email can
-- have a password (they sign in with it). Optionally revokes every unrevoked token
-- of the user. Returns the number of tokens revoked.
CREATE FUNCTION private.admin_set_password(p_user_id uuid, p_password_hash text, p_revoke_tokens boolean)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  user_kind text;
  revoked_id uuid;
  n integer := 0;
BEGIN
  PERFORM private.require_admin();
  SELECT kind INTO user_kind FROM public.app_user WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = 'SZ004';
  END IF;
  IF user_kind <> 'human' THEN
    RAISE EXCEPTION 'service accounts cannot have a password (use API tokens)' USING ERRCODE = 'SZ004';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM private.user_pii WHERE user_id = p_user_id AND email IS NOT NULL) THEN
    RAISE EXCEPTION 'the user has no email address to sign in with; set one first' USING ERRCODE = 'SZ004';
  END IF;
  IF p_password_hash IS NULL OR p_password_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'password_hash must be an argon2id PHC string' USING ERRCODE = '22023';
  END IF;

  INSERT INTO private.password_credential (user_id, password_hash) VALUES (p_user_id, p_password_hash)
  ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now();
  INSERT INTO public.audit_event (action, entity_type, entity_id, changes)
  VALUES ('password_set', 'password_credential', p_user_id,
          jsonb_build_object('via', 'admin', 'revoke_tokens', coalesce(p_revoke_tokens, false)));

  IF p_revoke_tokens THEN
    FOR revoked_id IN
      UPDATE private.api_token SET revoked_at = now()
       WHERE user_id = p_user_id AND revoked_at IS NULL
      RETURNING id
    LOOP
      INSERT INTO public.audit_event (action, entity_type, entity_id, changes)
      VALUES ('token_revoke', 'api_token', revoked_id,
              jsonb_build_object('user_id', p_user_id, 'via', 'password_set'));
      n := n + 1;
    END LOOP;
  END IF;
  RETURN n;
END $$;

-- Same as 0004, plus the client 'cli' (@sermonize/cli, CLI_LOGIN_TOKEN_TTL_HOURS).
-- Same signature: CREATE OR REPLACE keeps the existing grants.
CREATE OR REPLACE FUNCTION private.create_login_token(p_user_id uuid, p_token_sha256 text, p_expires_at timestamptz, p_client text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  prev_actor text := current_setting('app.user_id', true);
  new_id uuid;
BEGIN
  IF p_client IS NULL OR p_client NOT IN ('web', 'mcp', 'cli') THEN
    RAISE EXCEPTION 'login token client must be web, mcp or cli' USING ERRCODE = '22023';
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

REVOKE ALL ON FUNCTION
  private.admin_list_users(uuid, text, text, text, text, timestamptz, uuid, integer),
  private.admin_list_tokens(uuid),
  private.admin_update_user_pii(uuid, boolean, text, boolean, text),
  private.admin_set_password(uuid, text, boolean)
FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sermonize_app') THEN
    GRANT EXECUTE ON FUNCTION
      private.admin_list_users(uuid, text, text, text, text, timestamptz, uuid, integer),
      private.admin_list_tokens(uuid),
      private.admin_update_user_pii(uuid, boolean, text, boolean, text),
      private.admin_set_password(uuid, text, boolean)
    TO sermonize_app;
  END IF;
END $$;
