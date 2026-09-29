-- OIDC sign-in (POST /auth/oidc, see src/routes/auth.ts and src/lib/oidc.ts).
--
-- The API verifies the IdP's ID token itself (signature via the issuer's JWKS, iss, aud, exp, iat)
-- and then maps (issuer, subject) to a local account through private.auth_identity, the table the
-- data model reserved for this. Both functions below are callable WITHOUT an admin principal, like
-- the password self-service functions in 0001_init.sql, and each does one narrow thing:
--   oidc_resolve_user         find the account linked to (issuer, subject); otherwise link an
--                             existing human account by a trusted email, or create one; never
--                             returns a user that is not linked afterwards
--   create_oidc_login_token   store a login token hash for the account linked to (issuer, subject)
--
-- Audit actor: the user themself (app.user_id is set to the user for the duration of the call and
-- restored afterwards), as for registration and password login. Audit events never contain PII
-- values: the subject and the email are never written to audit_event, only the issuer and how the
-- link was made.

ALTER TABLE private.auth_identity ADD COLUMN last_login_at timestamptz;

-- Finds or creates the account for an OIDC identity. Returns one row, or none when there is no
-- account and p_create is false.
--   p_email          the email claim ONLY if the caller trusts it (email_verified = true, or
--                    OIDC_TRUST_EMAIL); NULL otherwise. Used to link an existing human account
--                    (case-insensitive, like password login) and as the new account's email.
--   p_display_name   display name for a created account (NULL allowed).
--   p_create         OIDC_CREATE_USERS: create an active human account when nothing matches.
--   p_role           role of a created account: reader or contributor (REGISTRATION_DEFAULT_ROLE).
-- linked_via: 'identity' (already linked), 'email' (linked now by email) or 'created'.
-- A disabled account is returned with its status (and linked like any other); the caller refuses
-- it and rolls back, so a refused sign-in leaves no link behind.
--
-- search_path includes `public` because the app_user triggers reference public objects unqualified
-- (see private.register_user in 0001_init.sql).
CREATE FUNCTION private.oidc_resolve_user(p_issuer text, p_subject text, p_email text, p_display_name text,
                                          p_create boolean, p_role text)
RETURNS TABLE (user_id uuid, role text, kind text, status text, linked_via text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  prev_actor text := current_setting('app.user_id', true);
  found_id uuid;
  via text;
  new_email text := nullif(btrim(coalesce(p_email, '')), '');
BEGIN
  IF p_issuer IS NULL OR length(p_issuer) = 0 OR p_subject IS NULL OR length(p_subject) = 0 THEN
    RAISE EXCEPTION 'issuer and subject are required' USING ERRCODE = '22023';
  END IF;
  -- Serialises the first sign-ins of one identity (two tabs, a retried request).
  PERFORM pg_advisory_xact_lock(hashtextextended('oidc:' || p_issuer || chr(10) || p_subject, 0));

  SELECT i.user_id INTO found_id FROM private.auth_identity i
   WHERE i.issuer = p_issuer AND i.subject = p_subject;
  IF FOUND THEN
    via := 'identity';
  ELSE
    IF new_email IS NOT NULL THEN
      -- Only human accounts: service accounts sign in with API tokens, never as a person.
      SELECT u.id INTO found_id
        FROM private.user_pii p JOIN public.app_user u ON u.id = p.user_id
       WHERE p.email IS NOT NULL AND lower(p.email) = lower(new_email) AND u.kind = 'human';
      IF FOUND THEN
        via := 'email';
      END IF;
    END IF;

    IF found_id IS NULL THEN
      IF NOT coalesce(p_create, false) THEN
        RETURN;
      END IF;
      IF p_role IS NULL OR p_role NOT IN ('reader', 'contributor') THEN
        RAISE EXCEPTION 'OIDC sign-in may only create readers or contributors' USING ERRCODE = '42501';
      END IF;
      found_id := gen_random_uuid();
      via := 'created';
      -- The email is unique; one held by an account we may not link (a service account) is left out.
      IF new_email IS NOT NULL AND EXISTS (SELECT 1 FROM private.user_pii
                                            WHERE email IS NOT NULL AND lower(email) = lower(new_email)) THEN
        new_email := NULL;
      END IF;
      PERFORM set_config('app.user_id', found_id::text, true);
      INSERT INTO public.app_user (id, kind, role, status) VALUES (found_id, 'human', p_role, 'active');
      IF new_email IS NOT NULL OR p_display_name IS NOT NULL THEN
        INSERT INTO private.user_pii (user_id, email, display_name) VALUES (found_id, new_email, p_display_name);
        INSERT INTO public.audit_event (action, entity_type, entity_id, changes)
        VALUES ('pii_update', 'user_pii', found_id,
                jsonb_build_object('fields',
                  to_jsonb(array_remove(ARRAY[CASE WHEN new_email IS NOT NULL THEN 'email' END,
                                              CASE WHEN p_display_name IS NOT NULL THEN 'display_name' END],
                                        NULL)),
                  'via', 'oidc'));
      END IF;
    END IF;

    PERFORM set_config('app.user_id', found_id::text, true);
    INSERT INTO private.auth_identity (issuer, subject, user_id) VALUES (p_issuer, p_subject, found_id);
    INSERT INTO public.audit_event (action, entity_type, entity_id, changes)
    VALUES ('identity_link', 'auth_identity', found_id, jsonb_build_object('issuer', p_issuer, 'via', via));
    PERFORM set_config('app.user_id', coalesce(prev_actor, ''), true);
  END IF;

  RETURN QUERY SELECT u.id, u.role, u.kind, u.status, via FROM public.app_user u WHERE u.id = found_id;
END $$;

-- Stores the hash of a login token for the ACTIVE account linked to (issuer, subject) and records
-- the sign-in time. Named after the client like password login tokens ('web', 'mcp' or 'cli'); the
-- expiry must be in the future. The ID token itself is verified by the API before calling this.
-- Returns the token id and the user id. Actor: the user themself.
CREATE FUNCTION private.create_oidc_login_token(p_issuer text, p_subject text, p_token_sha256 text,
                                                p_expires_at timestamptz, p_client text)
RETURNS TABLE (token_id uuid, user_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  prev_actor text := current_setting('app.user_id', true);
  uid uuid;
  new_id uuid;
BEGIN
  IF p_client IS NULL OR p_client NOT IN ('web', 'mcp', 'cli') THEN
    RAISE EXCEPTION 'login token client must be web, mcp or cli' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'login tokens need a future expiry' USING ERRCODE = '22023';
  END IF;
  SELECT u.id INTO uid FROM private.auth_identity i JOIN public.app_user u ON u.id = i.user_id
   WHERE i.issuer = p_issuer AND i.subject = p_subject AND u.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no active user linked to this identity' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.user_id', uid::text, true);
  UPDATE private.auth_identity SET last_login_at = now() WHERE issuer = p_issuer AND subject = p_subject;
  INSERT INTO private.api_token (user_id, token_sha256, name, created_by, expires_at)
  VALUES (uid, p_token_sha256, p_client, uid, p_expires_at)
  RETURNING id INTO new_id;
  INSERT INTO public.audit_event (action, entity_type, entity_id, changes)
  VALUES ('token_create', 'api_token', new_id,
          jsonb_build_object('user_id', uid, 'expires_at', p_expires_at, 'via', 'oidc', 'client', p_client));
  PERFORM set_config('app.user_id', coalesce(prev_actor, ''), true);
  RETURN QUERY SELECT new_id, uid;
END $$;

REVOKE ALL ON FUNCTION private.oidc_resolve_user(text, text, text, text, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.create_oidc_login_token(text, text, text, timestamptz, text) FROM PUBLIC;
