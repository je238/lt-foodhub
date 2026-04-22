-- Admin session tokens: closes the kill-switch tamper risk.
--
-- Before this migration, app_settings.UPDATE had a USING (true) policy,
-- meaning any employee with the anon key could open DevTools and flip
-- icici_pay_enabled or accept_orders. That defeats the kill-switch and
-- the PAUSE-ordering admin toggle we built.
--
-- This migration:
--   1. Adds admin_sessions table (opaque uuid tokens with expiry).
--   2. Extends verify_staff_login to issue a session token on successful
--      admin login. Existing behaviour (case-sensitive id, is_active gate,
--      kitchen->vendor role aliasing, bcrypt check) is preserved verbatim.
--   3. Adds admin_set_setting RPC — SECURITY DEFINER, takes the token,
--      verifies it's active, then upserts the setting. Only path to
--      mutate app_settings from client now.
--   4. Drops app_settings_update and app_settings_upsert policies.
--      SELECT stays open so flag reads still work.

BEGIN;

-- ============================================================
-- 1. admin_sessions table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.admin_sessions (
  token      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '12 hours'
);

CREATE INDEX IF NOT EXISTS admin_sessions_admin_id_idx   ON public.admin_sessions(admin_id);
CREATE INDEX IF NOT EXISTS admin_sessions_expires_at_idx ON public.admin_sessions(expires_at);

ALTER TABLE public.admin_sessions ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated access — only SECURITY DEFINER RPCs touch this.
DROP POLICY IF EXISTS admin_sessions_deny_all ON public.admin_sessions;
CREATE POLICY admin_sessions_deny_all ON public.admin_sessions FOR ALL USING (false);

REVOKE ALL ON TABLE public.admin_sessions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.admin_sessions TO service_role;

-- ============================================================
-- 2. verify_staff_login — preserve existing behaviour, add token for admins
-- ============================================================

CREATE OR REPLACE FUNCTION public.verify_staff_login(
  p_id text,
  p_password text,
  p_role text
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_account public.staff_accounts%ROWTYPE;
  v_token   uuid;
BEGIN
  -- Match the existing function's lookup exactly: case-sensitive id,
  -- kitchen role falls back to a vendor row (same counter staff).
  SELECT * INTO v_account
  FROM public.staff_accounts
  WHERE id = p_id
    AND (role = p_role OR (p_role = 'kitchen' AND role = 'vendor'))
    AND is_active = true;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Account not found or inactive');
  END IF;

  IF v_account.password_hash != crypt(p_password, v_account.password_hash) THEN
    RETURN json_build_object('success', false, 'error', 'Invalid password');
  END IF;

  -- Admins get a session token for app_settings mutations.
  IF p_role = 'admin' THEN
    DELETE FROM public.admin_sessions
      WHERE admin_id = v_account.id OR expires_at < now();

    INSERT INTO public.admin_sessions (admin_id)
    VALUES (v_account.id)
    RETURNING token INTO v_token;

    RETURN json_build_object(
      'success',    true,
      'id',         v_account.id,
      'role',       p_role,
      'canteen_id', v_account.canteen_id,
      'name',       v_account.name,
      'token',      v_token
    );
  END IF;

  RETURN json_build_object(
    'success',    true,
    'id',         v_account.id,
    'role',       p_role,
    'canteen_id', v_account.canteen_id,
    'name',       v_account.name
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.verify_staff_login(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_staff_login(text, text, text) TO anon, authenticated;

-- ============================================================
-- 3. admin_set_setting — the only client-reachable write path for settings
-- ============================================================

DROP FUNCTION IF EXISTS public.admin_set_setting(uuid, text, text);

CREATE FUNCTION public.admin_set_setting(
  p_token uuid,
  p_key   text,
  p_value text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  sess public.admin_sessions%ROWTYPE;
BEGIN
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Missing token');
  END IF;

  SELECT * INTO sess
  FROM public.admin_sessions
  WHERE token = p_token AND expires_at > now()
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Session expired or invalid');
  END IF;

  -- Sliding session: extend expiry on every admin action.
  UPDATE public.admin_sessions
     SET expires_at = now() + interval '12 hours'
   WHERE token = p_token;

  INSERT INTO public.app_settings (key, value, updated_at)
  VALUES (p_key, p_value, now())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        updated_at = now();

  RETURN jsonb_build_object('success', true);
END
$fn$;

REVOKE ALL ON FUNCTION public.admin_set_setting(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_setting(uuid, text, text) TO anon, authenticated;

-- ============================================================
-- 4. Drop anon-reachable mutation policies on app_settings
-- ============================================================

DROP POLICY IF EXISTS app_settings_update ON public.app_settings;
DROP POLICY IF EXISTS app_settings_upsert ON public.app_settings;

-- app_settings_select (USING true) stays in place so employees read flags.

COMMIT;
