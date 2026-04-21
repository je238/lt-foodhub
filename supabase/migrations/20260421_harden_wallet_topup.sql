-- Hardens wallet top-up flow.
--
-- 1. Removes self_wallet_topup RPC — any employee could call it from
--    DevTools and credit their own wallet without ICICI ever confirming
--    the payment. Wallet credits now happen only in the icici-payment
--    edge function after server-side hash verification.
-- 2. Adds a partial unique index on wallet_transactions.reference_id so
--    duplicate callbacks (ICICI retries) cannot double-credit.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.self_wallet_topup(TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
DROP FUNCTION IF EXISTS public.self_wallet_topup(TEXT, NUMERIC, TEXT, TEXT);

-- Catch older signature variants if they exist
DO $$
DECLARE
  f_oid oid;
BEGIN
  FOR f_oid IN
    SELECT p.oid FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'self_wallet_topup'
  LOOP
    EXECUTE 'DROP FUNCTION ' || f_oid::regprocedure;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_wallet_txn_reference_id
  ON public.wallet_transactions(reference_id)
  WHERE reference_id IS NOT NULL;

COMMIT;
