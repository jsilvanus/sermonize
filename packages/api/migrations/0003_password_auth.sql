-- Password accounts: self-registration and login (used by @sermonize/web).
--
-- * private.password_credential holds one argon2id hash per user. Hashing and
--   verification happen in Node (@node-rs/argon2); the database only stores the
--   PHC string.
-- * Emails in private.user_pii become unique case-insensitively, so that an
--   email identifies at most one account at login.
-- * Four SECURITY DEFINER functions, callable by the application role WITHOUT an
--   admin principal. Each does exactly one narrow thing:
--     register_user         create a human reader/contributor with PII and a password
--     get_password_credential   look up the login data for an email (read-only)
--     create_login_token    store a login token hash for a user with a password
--     revoke_own_token      revoke the caller's own token (logout)
--
-- Audit actor for self-service actions: the user themself. register_user and
-- create_login_token set app.user_id to the (new) user for the duration of the
-- call and restore the previous value afterwards, so app_user.created_by, the
-- token's created_by and every audit_event.actor_id are that user's pseudonymous
-- id. Audit events never contain PII values (only field names).

CREATE TABLE private.password_credential (
  user_id        uuid PRIMARY KEY REFERENCES public.app_user ON DELETE RESTRICT,
  password_hash  text NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX user_pii_email_lower_key ON private.user_pii (lower(email)) WHERE email IS NOT NULL;

-- Creates an active human user with the given role (reader or contributor only),
-- its PII and its password hash. Returns the new user id. A duplicate email raises
-- unique_violation (23505) on user_pii_email_lower_key.
--
-- search_path includes `public` (after pg_catalog) because the app_user triggers
-- (stamp_row, audit_row) reference public objects unqualified. roles.sql revokes
-- CREATE on public from PUBLIC, so no untrusted role can shadow them.
CREATE FUNCTION private.register_user(p_role text, p_email text, p_display_name text, p_password_hash text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  new_id uuid := gen_random_uuid();
  prev_actor text := current_setting('app.user_id', true);
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('reader', 'contributor') THEN
    RAISE EXCEPTION 'self-registration may only create readers or contributors' USING ERRCODE = '42501';
  END IF;
  IF p_email IS NULL OR length(btrim(p_email)) = 0 THEN
    RAISE EXCEPTION 'email is required' USING ERRCODE = '22023';
  END IF;
  IF p_password_hash IS NULL OR p_password_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'password_hash must be an argon2id PHC string' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.user_id', new_id::text, true);

  INSERT INTO public.app_user (id, kind, role, status) VALUES (new_id, 'human', p_role, 'active');
  INSERT INTO private.user_pii (user_id, email, display_name) VALUES (new_id, p_email, p_display_name);
  INSERT INTO public.audit_event (action, entity_type, entity_id, changes)
  VALUES ('pii_update', 'user_pii', new_id,
          jsonb_build_object('fields',
            to_jsonb(array_remove(ARRAY['email',
                                        CASE WHEN p_display_name IS NOT NULL THEN 'display_name' END],
                                  NULL))));
  INSERT INTO private.password_credential (user_id, password_hash) VALUES (new_id, p_password_hash);
  INSERT INTO public.audit_event (action, entity_type, entity_id, changes)
  VALUES ('password_set', 'password_credential', new_id, jsonb_build_object('via', 'register'));

  PERFORM set_config('app.user_id', coalesce(prev_actor, ''), true);
  RETURN new_id;
END $$;

-- Login data for an email (case-insensitive). No row if the email is unknown or
-- the user has no password. Status is returned so the caller can reject disabled
-- users only AFTER verifying the hash (uniform timing).
CREATE FUNCTION private.get_password_credential(p_email text)
RETURNS TABLE (user_id uuid, password_hash text, role text, kind text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id, c.password_hash, u.role, u.kind, u.status
    FROM private.user_pii p
    JOIN private.password_credential c ON c.user_id = p.user_id
    JOIN public.app_user u ON u.id = p.user_id
   WHERE p.email IS NOT NULL AND lower(p.email) = lower(p_email)
$$;

-- Stores the hash of a login token (name 'login', mandatory future expiry) for an
-- active user that has a password. The password itself is verified by the API
-- before calling this. Actor: the user themself.
CREATE FUNCTION private.create_login_token(p_user_id uuid, p_token_sha256 text, p_expires_at timestamptz)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  prev_actor text := current_setting('app.user_id', true);
  new_id uuid;
BEGIN
  IF p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'login tokens need a future expiry' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_user u JOIN private.password_credential c ON c.user_id = u.id
                  WHERE u.id = p_user_id AND u.status = 'active') THEN
    RAISE EXCEPTION 'no active user with a password' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.user_id', p_user_id::text, true);
  INSERT INTO private.api_token (user_id, token_sha256, name, created_by, expires_at)
  VALUES (p_user_id, p_token_sha256, 'login', p_user_id, p_expires_at)
  RETURNING id INTO new_id;
  INSERT INTO public.audit_event (action, entity_type, entity_id, changes)
  VALUES ('token_create', 'api_token', new_id,
          jsonb_build_object('user_id', p_user_id, 'expires_at', p_expires_at, 'via', 'login'));
  PERFORM set_config('app.user_id', coalesce(prev_actor, ''), true);
  RETURN new_id;
END $$;

-- Revokes the token with this hash if it belongs to the current principal
-- (app.user_id). Returns false if there is no such unrevoked token.
CREATE FUNCTION private.revoke_own_token(p_token_sha256 text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor_id();
  token_id uuid;
BEGIN
  UPDATE private.api_token SET revoked_at = now()
   WHERE token_sha256 = p_token_sha256 AND user_id = actor AND revoked_at IS NULL
  RETURNING id INTO token_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.audit_event (action, entity_type, entity_id, changes)
  VALUES ('token_revoke', 'api_token', token_id, jsonb_build_object('user_id', actor, 'via', 'logout'));
  RETURN true;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
