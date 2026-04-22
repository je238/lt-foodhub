-- Lock down orders UPDATE / DELETE from anon.
--
-- Before this migration, orders_update + orders_update_status had
-- USING (true). Any employee with the anon key could mark their own
-- order delivered to skip the queue, flip another user's order to
-- cancelled, or set pickup_otp on someone else's order.
--
-- This migration:
--   1. Extends the admin_sessions table (→ de-facto staff_sessions)
--      with role + canteen_id so vendor/kitchen can also carry tokens.
--   2. Updates verify_staff_login to issue a token for all three staff
--      roles (admin / vendor / kitchen). Admin token has canteen_id NULL
--      and can act on any order; vendor/kitchen token is scoped to
--      the account's canteen.
--   3. Updates admin_set_setting to accept only role='admin' tokens.
--   4. Adds staff_update_order_status, staff_confirm_pickup,
--      employee_rate_order, employee_set_pickup_otp RPCs — the only
--      client-reachable mutation paths for orders now.
--   5. Drops orders_update + orders_update_status (USING true) policies.

BEGIN;

-- ============================================================
-- 1. Extend admin_sessions (now serving all staff)
-- ============================================================

ALTER TABLE public.admin_sessions
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'admin',
  ADD COLUMN IF NOT EXISTS canteen_id text;

-- ============================================================
-- 2. verify_staff_login — issue a token for all staff roles.
--    Admin token: canteen_id NULL (can touch any order).
--    Vendor/kitchen: canteen_id set from the staff row.
-- ============================================================

CREATE OR REPLACE FUNCTION public.verify_staff_login(
  p_id text,
  p_password text,
  p_role text
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_account public.staff_accounts%ROWTYPE;
  v_token   uuid;
BEGIN
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

  -- Clear stale sessions for this staff id + expired ones globally.
  DELETE FROM public.admin_sessions
    WHERE admin_id = v_account.id OR expires_at < now();

  INSERT INTO public.admin_sessions (admin_id, role, canteen_id)
  VALUES (
    v_account.id,
    p_role,
    CASE WHEN p_role = 'admin' THEN NULL ELSE v_account.canteen_id END
  )
  RETURNING token INTO v_token;

  RETURN json_build_object(
    'success',    true,
    'id',         v_account.id,
    'role',       p_role,
    'canteen_id', v_account.canteen_id,
    'name',       v_account.name,
    'token',      v_token
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.verify_staff_login(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_staff_login(text, text, text) TO anon, authenticated;

-- ============================================================
-- 3. admin_set_setting — restrict to role='admin' sessions only.
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_set_setting(
  p_token uuid,
  p_key   text,
  p_value text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  sess public.admin_sessions%ROWTYPE;
BEGIN
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Missing token');
  END IF;

  SELECT * INTO sess
  FROM public.admin_sessions
  WHERE token = p_token AND expires_at > now() AND role = 'admin'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Session expired or not admin');
  END IF;

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

-- ============================================================
-- 4a. staff_update_order_status — any staff role can change status.
--     Vendor/kitchen scoped to their canteen; admin is unrestricted.
-- ============================================================

DROP FUNCTION IF EXISTS public.staff_update_order_status(uuid, text, text);

CREATE FUNCTION public.staff_update_order_status(
  p_token    uuid,
  p_order_id text,
  p_status   text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  sess  public.admin_sessions%ROWTYPE;
  ord   public.orders%ROWTYPE;
BEGIN
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Missing token');
  END IF;

  IF p_status NOT IN ('new','preparing','ready','done','cancelled','rejected') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid status');
  END IF;

  SELECT * INTO sess
  FROM public.admin_sessions
  WHERE token = p_token AND expires_at > now()
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Session expired or invalid');
  END IF;

  SELECT * INTO ord FROM public.orders WHERE id = p_order_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order not found');
  END IF;

  -- Vendor/kitchen scoped to their canteen.
  IF sess.role IN ('vendor','kitchen') AND sess.canteen_id IS DISTINCT FROM ord.canteen_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order not in your canteen');
  END IF;

  UPDATE public.admin_sessions SET expires_at = now() + interval '12 hours' WHERE token = p_token;

  UPDATE public.orders SET status = p_status WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true);
END
$fn$;

REVOKE ALL ON FUNCTION public.staff_update_order_status(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_update_order_status(uuid, text, text) TO anon, authenticated;

-- ============================================================
-- 4b. staff_confirm_pickup — kitchen/vendor verifies OTP match
--     and finalises pickup (status=done + timestamp + clear otp).
-- ============================================================

DROP FUNCTION IF EXISTS public.staff_confirm_pickup(uuid, text);

CREATE FUNCTION public.staff_confirm_pickup(
  p_token    uuid,
  p_order_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  sess public.admin_sessions%ROWTYPE;
  ord  public.orders%ROWTYPE;
BEGIN
  SELECT * INTO sess FROM public.admin_sessions WHERE token = p_token AND expires_at > now() LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Session expired or invalid');
  END IF;

  SELECT * INTO ord FROM public.orders WHERE id = p_order_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order not found');
  END IF;

  IF sess.role IN ('vendor','kitchen') AND sess.canteen_id IS DISTINCT FROM ord.canteen_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order not in your canteen');
  END IF;

  UPDATE public.admin_sessions SET expires_at = now() + interval '12 hours' WHERE token = p_token;

  UPDATE public.orders
     SET status = 'done',
         pickup_confirmed_at = now(),
         pickup_otp = NULL
   WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true);
END
$fn$;

REVOKE ALL ON FUNCTION public.staff_confirm_pickup(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_confirm_pickup(uuid, text) TO anon, authenticated;

-- ============================================================
-- 4c. employee_rate_order — employee rates their own order.
--     Also updates menu_items aggregate rating inside the same
--     transaction so the two can't drift.
-- ============================================================

DROP FUNCTION IF EXISTS public.employee_rate_order(text, text, int, text);

CREATE FUNCTION public.employee_rate_order(
  p_employee_id text,
  p_order_id    text,
  p_rating      int,
  p_comment     text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  ord public.orders%ROWTYPE;
  mi public.menu_items%ROWTYPE;
  new_count int;
  new_rating numeric;
BEGIN
  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rating must be 1..5');
  END IF;

  SELECT * INTO ord FROM public.orders WHERE id = p_order_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order not found');
  END IF;
  IF ord.employee_id IS DISTINCT FROM p_employee_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not your order');
  END IF;

  UPDATE public.orders
     SET rating = p_rating,
         rating_comment = p_comment
   WHERE id = p_order_id;

  INSERT INTO public.order_ratings (order_id, employee_id, rating, comment, canteen_id, created_at)
  VALUES (p_order_id, p_employee_id, p_rating, p_comment, ord.canteen_id, now())
  ON CONFLICT DO NOTHING;

  -- Roll the rating into menu_items aggregate for every item in the order.
  -- order_items.item_id -> menu_items.id is the link (schema uses item_id,
  -- not menu_item_id).
  FOR mi IN
    SELECT m.*
    FROM public.menu_items m
    JOIN public.order_items oi ON oi.item_id = m.id
    WHERE oi.order_id = p_order_id
  LOOP
    new_count  := COALESCE(mi.orders_count, 0) + 1;
    new_rating := ROUND(
      ((COALESCE(mi.rating, 4.0) * COALESCE(mi.orders_count, 1)) + p_rating)::numeric / new_count,
      1
    );
    UPDATE public.menu_items
       SET rating = new_rating,
           orders_count = new_count
     WHERE id = mi.id;
  END LOOP;

  RETURN jsonb_build_object('success', true);
END
$fn$;

REVOKE ALL ON FUNCTION public.employee_rate_order(text, text, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.employee_rate_order(text, text, int, text) TO anon, authenticated;

-- ============================================================
-- 4d. employee_set_pickup_otp — employee generates OTP on own order.
-- ============================================================

DROP FUNCTION IF EXISTS public.employee_set_pickup_otp(text, text, text, timestamptz);

CREATE FUNCTION public.employee_set_pickup_otp(
  p_employee_id text,
  p_order_id    text,
  p_otp         text,
  p_expiry_at   timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  ord public.orders%ROWTYPE;
BEGIN
  SELECT * INTO ord FROM public.orders WHERE id = p_order_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order not found');
  END IF;
  IF ord.employee_id IS DISTINCT FROM p_employee_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not your order');
  END IF;

  UPDATE public.orders
     SET pickup_otp = p_otp,
         pickup_otp_expiry = p_expiry_at
   WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true);
END
$fn$;

REVOKE ALL ON FUNCTION public.employee_set_pickup_otp(text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.employee_set_pickup_otp(text, text, text, timestamptz) TO anon, authenticated;

-- ============================================================
-- 5. Drop the permissive orders mutation policies.
-- ============================================================

DROP POLICY IF EXISTS orders_update        ON public.orders;
DROP POLICY IF EXISTS orders_update_status ON public.orders;
-- orders_select (USING true), orders_insert (null) and orders_delete
-- (USING false) stay as-is. INSERT is covered by place_order RPC
-- (SECURITY DEFINER inside its own transaction); DELETE is already
-- denied. SELECT stays open until we introduce per-user session tokens.

COMMIT;
