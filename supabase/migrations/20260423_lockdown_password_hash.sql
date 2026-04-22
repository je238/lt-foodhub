-- Locks down employees.password_hash so anon clients cannot
-- enumerate hashes via PostgREST. Also consolidates the redundant
-- wallet_transactions SELECT policies that were making the per-user
-- filter a no-op.
--
-- After this migration, the client MUST NOT .select('*') on employees;
-- it must use explicit column lists (password_hash is no longer in the
-- grant), and login MUST go through verify_employee_login /
-- employee_account_status RPCs which are SECURITY DEFINER and
-- compare hashes server-side.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1. verify_employee_login — returns employee row on success
--    without ever exposing password_hash to the client.
--    Handles both bcrypt-style ($2*) and legacy plaintext values,
--    auto-upgrading plaintext entries to bcrypt on first login.
--    DROP before CREATE: existing function has a different return
--    type so CREATE OR REPLACE won't work.
-- ============================================================

DROP FUNCTION IF EXISTS public.verify_employee_login(text, text);

CREATE FUNCTION public.verify_employee_login(
  p_email text,
  p_password text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  emp public.employees%ROWTYPE;
  ok  boolean := false;
BEGIN
  SELECT * INTO emp
  FROM public.employees
  WHERE lower(email) = lower(p_email)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_user');
  END IF;

  IF emp.is_active IS NOT NULL AND emp.is_active = false THEN
    RETURN jsonb_build_object('success', false, 'reason', 'inactive');
  END IF;

  IF emp.password_hash IS NULL OR length(emp.password_hash) = 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_password');
  END IF;

  IF emp.password_hash LIKE '$%' THEN
    -- bcrypt / pgcrypto crypt() format
    ok := (emp.password_hash = crypt(p_password, emp.password_hash));
  ELSE
    -- Legacy plaintext — compare directly, then upgrade in place
    ok := (emp.password_hash = p_password);
    IF ok THEN
      UPDATE public.employees
         SET password_hash = crypt(p_password, gen_salt('bf', 10))
       WHERE id = emp.id;
    END IF;
  END IF;

  IF NOT ok THEN
    RETURN jsonb_build_object('success', false, 'reason', 'wrong_password');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'employee', jsonb_build_object(
      'id',               emp.id,
      'name',             emp.name,
      'email',            emp.email,
      'phone',            emp.phone,
      'department',       emp.department,
      'campus',           emp.campus,
      'designation',      emp.designation,
      'joining_date',     emp.joining_date,
      'wallet_balance',   emp.wallet_balance,
      'subsidy_per_meal', emp.subsidy_per_meal,
      'monthly_limit',    emp.monthly_limit,
      'meal_pass_active', emp.meal_pass_active,
      'meal_pass_used',   emp.meal_pass_used,
      'meal_pass_limit',  emp.meal_pass_limit,
      'points_balance',   emp.points_balance,
      'is_active',        emp.is_active,
      'role',             emp.role,
      'initials',         emp.initials,
      'last_login',       emp.last_login,
      'created_at',       emp.created_at,
      'updated_at',       emp.updated_at
    )
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.verify_employee_login(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_employee_login(text, text) TO anon, authenticated;

-- ============================================================
-- 2. employee_account_status — used by the registration flow to
--    decide "new user", "existing w/o password (finish OTP)",
--    or "existing w/ password (send to login)" without ever
--    returning the hash.
-- ============================================================

DROP FUNCTION IF EXISTS public.employee_account_status(text);

CREATE FUNCTION public.employee_account_status(
  p_email text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  emp public.employees%ROWTYPE;
BEGIN
  SELECT * INTO emp
  FROM public.employees
  WHERE lower(email) = lower(p_email)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('exists', false);
  END IF;

  RETURN jsonb_build_object(
    'exists',       true,
    'has_password', (emp.password_hash IS NOT NULL AND length(emp.password_hash) > 0),
    'id',           emp.id,
    'name',         emp.name,
    'email',        emp.email
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.employee_account_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.employee_account_status(text) TO anon, authenticated;

-- ============================================================
-- 3. Column-level lockdown on employees sensitive columns.
--    password_hash  — full credential leak via anon.
--    temp_otp       — OTPs for email verification; if readable,
--                     an attacker observes the OTP after triggering
--                     it for any email and bypasses verification.
--    otp_created_at — paired metadata; hide to keep the OTP feature
--                     fully opaque to anon clients.
-- ============================================================

REVOKE SELECT (password_hash, temp_otp, otp_created_at) ON public.employees FROM PUBLIC;
REVOKE SELECT (password_hash, temp_otp, otp_created_at) ON public.employees FROM anon;
REVOKE SELECT (password_hash, temp_otp, otp_created_at) ON public.employees FROM authenticated;

-- service_role (edge functions) keeps full access for OTP send / verify.
GRANT SELECT (password_hash, temp_otp, otp_created_at) ON public.employees TO service_role;
GRANT UPDATE (password_hash, temp_otp, otp_created_at) ON public.employees TO service_role;

-- Anon/authenticated explicitly get every OTHER column so
-- .select('id,name,email,...') keeps working. Listed explicitly so
-- a future ALTER TABLE ADD COLUMN doesn't silently re-expose data.
GRANT SELECT (
  id, name, email, phone, department, campus, designation,
  joining_date, wallet_balance, subsidy_per_meal, monthly_limit,
  meal_pass_active, meal_pass_used, meal_pass_limit,
  points_balance, is_active, role, initials, last_login,
  created_at, updated_at
) ON public.employees TO anon, authenticated;

-- ============================================================
-- 4. wallet_transactions — consolidate the 3 redundant permissive
--    SELECT policies that made wallet_select / txns_own_only no-ops.
--    Keep a single open SELECT until we add session-token auth
--    (RLS can't enforce per-user ownership under the anon-key +
--    custom-auth model without a signed token). At minimum this
--    stops the accidental drift and makes the intent explicit.
-- ============================================================

DROP POLICY IF EXISTS "Allow read by employee_id"           ON public.wallet_transactions;
DROP POLICY IF EXISTS "Allow employee read own transactions" ON public.wallet_transactions;
DROP POLICY IF EXISTS allow_wallet_txn_read                  ON public.wallet_transactions;
DROP POLICY IF EXISTS txns_own_only                          ON public.wallet_transactions;
-- keep wallet_select (it's a no-op today because auth.uid() is NULL
-- under the anon key, but stays in place for when session tokens land)

COMMIT;
