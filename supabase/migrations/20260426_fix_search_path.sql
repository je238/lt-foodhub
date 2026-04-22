-- Hotfix: SET search_path = public on verify_employee_login and
-- verify_staff_login silently removed access to extensions.crypt()
-- and extensions.gen_salt(). Both functions error at runtime with:
--   ERROR: function crypt(text, text) does not exist
--
-- crypt/gen_salt live in the `extensions` schema, not `public`.
-- Extend the search_path to include extensions so the bcrypt path works.

BEGIN;

ALTER FUNCTION public.verify_employee_login(text, text)      SET search_path = public, extensions;
ALTER FUNCTION public.verify_staff_login(text, text, text)   SET search_path = public, extensions;

COMMIT;
