-- ICICI Pay kill-switch:
--
-- 1. Seeds the app_settings flag so the admin toggle has a row to upsert
--    into and the default (ON) is explicit rather than implied.
-- 2. Ensures app_settings is published to supabase_realtime so admin
--    toggles propagate to all ~7000 active sessions within seconds —
--    without this, only new logins pick up the change.

BEGIN;

INSERT INTO public.app_settings (key, value)
VALUES ('icici_pay_enabled', 'true')
ON CONFLICT (key) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.app_settings';
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
  END IF;
END $$;

COMMIT;
