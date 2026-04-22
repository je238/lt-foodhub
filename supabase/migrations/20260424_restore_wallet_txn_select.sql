-- Follow-up to 20260423_lockdown_password_hash.sql:
-- That migration dropped four redundant permissive SELECT policies
-- on wallet_transactions, leaving only wallet_select which gates
-- on request.jwt.claims. Under this app's custom-auth / anon-key
-- model those claims are NULL, so no client read gets through —
-- the transaction history stopped rendering.
--
-- Restore a single explicit permissive SELECT policy so behaviour
-- matches pre-migration. This re-opens the privacy gap (any anon
-- client could enumerate all wallet txns) but that gap existed
-- yesterday and before. Real per-user enforcement needs a signed
-- session token on the client — out of scope for this hotfix.

BEGIN;

CREATE POLICY wallet_txn_read_open ON public.wallet_transactions
  FOR SELECT USING (true);

COMMIT;
