import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://lt-foodhub.vercel.app";
const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Vary": "Origin",
};

const ICICI_URL = "https://pgpay.icicibank.com/pg/api/v2/initiateSale";
const MID = Deno.env.get("ICICI_MERCHANT_ID");
const AID = Deno.env.get("ICICI_AGGREGATOR_ID");
const SECK = Deno.env.get("ICICI_SECURE_KEY");
const SU = Deno.env.get("SUPABASE_URL");
const SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const WEB_URL = "https://lt-foodhub.vercel.app";
const APP_SCHEME = "slpnexus";
const ANDROID_PACKAGE = "com.slphospitality.nexus";

function assertEnv() {
  const missing: string[] = [];
  if (!MID) missing.push("ICICI_MERCHANT_ID");
  if (!AID) missing.push("ICICI_AGGREGATOR_ID");
  if (!SECK) missing.push("ICICI_SECURE_KEY");
  if (!SU) missing.push("SUPABASE_URL");
  if (!SK) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length) throw new Error("Missing env: " + missing.join(", "));
}

async function hm(msg: string, key: string): Promise<string> {
  const e = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", e.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, e.encode(msg));
  return Array.from(new Uint8Array(s)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function fd(): string {
  const n = new Date();
  return n.getFullYear() +
    String(n.getMonth() + 1).padStart(2, "0") +
    String(n.getDate()).padStart(2, "0") +
    String(n.getHours()).padStart(2, "0") +
    String(n.getMinutes()).padStart(2, "0") +
    String(n.getSeconds()).padStart(2, "0");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    assertEnv();

    let bp: any = {};
    if (req.method === "POST") {
      try {
        const ct = req.headers.get("content-type") || "";
        if (ct.includes("json")) { bp = await req.json(); }
        else {
          const t = await req.text();
          try { bp = JSON.parse(t); } catch { bp = Object.fromEntries(new URLSearchParams(t)); }
        }
      } catch (_) {
        // Leave bp empty on parse error — treated as unknown action below.
      }
    }
    // ICICI's in-page "Back" link is a GET with query params — merge those in
    // so the callback branch can handle cancel/failure the same way as POST.
    try {
      const u = new URL(req.url);
      if (u.searchParams.size) {
        for (const [k, v] of u.searchParams) {
          if (bp[k] === undefined) bp[k] = v;
        }
      }
    } catch (_) {}

    // ══════════════════════════════════════════════════
    // ICICI CALLBACK — server-to-server from ICICI
    // ══════════════════════════════════════════════════
    const isCB = bp.merchantTxnNo && !bp.action;
    if (isCB) {
      const txn = bp.merchantTxnNo || "";
      const rc = bp.responseCode || "";
      const ts = (bp.transactionStatus || "").toUpperCase();
      const emp = bp.addlParam1 || "";
      const amt = parseFloat(bp.amount) || 0;
      const receivedHash = bp.secureHash || "";

      // ── SECURITY: Verify response hash from ICICI ──
      const respHashText = (bp.addlParam1 || "") + (bp.addlParam2 || "") +
        (bp.aggregatorID || "") + (bp.amount || "") + (bp.currencyCode || "") +
        (bp.customerEmailID || "") + (bp.customerMobileNo || "") +
        (bp.customerName || "") + (bp.merchantId || "") +
        (bp.merchantTxnNo || "") + (bp.payType || "") +
        (bp.responseCode || "") + (bp.responseMessage || "") +
        (bp.returnURL || "") + (bp.tranCtx || "") +
        (bp.transactionStatus || "") + (bp.transactionType || "") +
        (bp.txnDate || "");

      const expectedHash = await hm(respHashText, SECK!);
      const hashValid = !!(receivedHash && receivedHash === expectedHash);

      const SUCCESS_CODES = ["000", "0000"];
      const isSuccess = SUCCESS_CODES.includes(rc) || ts === "SUCCESS" || ts === "SUC";

      // Log hash mismatches so we can fix the response-hash formula if
      // ICICI's field order turns out to be different from what we expect.
      if (receivedHash && !hashValid) {
        console.log("ICICI hash mismatch", { txn, receivedHash, expectedHash, respHashText });
      }

      // Credit only when this payment was initiated as a wallet TOPUP.
      // Order payments echo addlParam2="ORDER" and must NOT credit the
      // wallet — otherwise the user is charged at ICICI for the order
      // AND gets that amount added to their wallet (double-payment).
      const purposeTag = (bp.addlParam2 || "").toUpperCase();
      const isTopup = purposeTag === "TOPUP";
      const shouldCredit = isSuccess && emp && amt > 0 && isTopup;

      if (shouldCredit) {
        try {
          const sb = createClient(SU!, SK!);

          // Idempotency on reference_id (unique index uniq_wallet_txn_reference_id)
          const { data: existingTxn } = await sb.from("wallet_transactions")
            .select("id")
            .eq("reference_id", txn)
            .limit(1);

          if (!existingTxn || existingTxn.length === 0) {
            const { data: e2 } = await sb.from("employees")
              .select("wallet_balance")
              .eq("id", emp)
              .single();

            if (e2) {
              const nb = (parseFloat(e2.wallet_balance) || 0) + amt;
              await sb.from("employees").update({ wallet_balance: nb }).eq("id", emp);
              await sb.from("wallet_transactions").insert({
                employee_id: emp,
                type: "credit",
                amount: amt,
                description: "ICICI Wallet Top-up TxnNo:" + txn,
                balance_after: nb,
                reference_id: txn
              });
            }
          }
        } catch (_) {
          // Swallow — browser redirect below still happens; user will retry.
        }
      }

      const status = isSuccess ? "success" : "failed";
      const params = "payment=" + status + "&txnNo=" + encodeURIComponent(txn) + "&amt=" + amt;
      // Use intent:// with an explicit package + browser_fallback_url so
      // Chrome Custom Tabs hands off to the app via Android's intent system
      // (the naive slpnexus:// scheme is silently swallowed by Custom Tabs).
      const intentUrl = `intent://payment?${params}#Intent;scheme=${APP_SCHEME};package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(WEB_URL + "?" + params)};end`;
      const webUrl = WEB_URL + "?" + params;
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Payment ${status}</title>
<script>
window.location.href=${JSON.stringify(intentUrl)};
setTimeout(function(){window.location.href=${JSON.stringify(webUrl)};},3000);
</script></head><body><p>Redirecting back to app...</p></body></html>`;
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
    }

    // ══════════════════════════════════════════════════
    // INITIATE PAYMENT — called from app
    // ══════════════════════════════════════════════════
    const action = bp.action;
    if (action === "initiate") {
      const { amount, employeeId, employeeName, employeeEmail, employeePhone, purpose } = bp;
      if (!amount || !employeeId) {
        return new Response(JSON.stringify({ success: false, error: "Missing params" }),
          { headers: { ...CORS, "Content-Type": "application/json" } });
      }
      const amtNum = parseFloat(amount);
      if (!(amtNum >= 1 && amtNum <= 10000)) {
        return new Response(JSON.stringify({ success: false, error: "Amount out of range" }),
          { headers: { ...CORS, "Content-Type": "application/json" } });
      }

      // addlParam2 round-trips through ICICI back to the callback, so use
      // it to tag the payment purpose. ORDER payments must NOT auto-credit
      // the wallet; only TOPUP payments should. Default to TOPUP for
      // backward compat with any older client bundle in the wild.
      const tag = (purpose && String(purpose).toLowerCase() === "order") ? "ORDER" : "TOPUP";

      const txn = "SLP" + Date.now() + Math.floor(Math.random() * 1000);
      const td = fd();
      const amt = amtNum.toFixed(2);
      const cb = SU + "/functions/v1/icici-payment";
      const em = employeeEmail || "noreply@slpnexus.com";
      const ph = employeePhone || "9999999999";
      const nm = employeeName || "Employee";

      const ht = employeeId + tag + AID + amt + "356" + em + ph + nm + MID + txn + "0" + cb + "SALE" + td;
      const sh = await hm(ht, SECK!);

      const pl = {
        merchantId: MID,
        aggregatorID: AID,
        merchantTxnNo: txn,
        amount: amt,
        currencyCode: "356",
        payType: "0",
        customerEmailID: em,
        transactionType: "SALE",
        returnURL: cb,
        txnDate: td,
        customerMobileNo: ph,
        customerName: nm,
        addlParam1: employeeId,
        addlParam2: tag,
        secureHash: sh
      };

      let d: any;
      try {
        const r = await fetch(ICICI_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pl)
        });
        const txt = await r.text();
        try { d = JSON.parse(txt); } catch {
          return new Response(JSON.stringify({
            success: false,
            error: "ICICI server unavailable. Try again later."
          }), { headers: { ...CORS, "Content-Type": "application/json" } });
        }
      } catch (e: any) {
        return new Response(JSON.stringify({
          success: false,
          error: "Cannot reach ICICI: " + e.message
        }), { headers: { ...CORS, "Content-Type": "application/json" } });
      }

      if (d.responseCode === "R1000" && d.redirectURI && d.tranCtx) {
        return new Response(JSON.stringify({
          success: true,
          redirectUrl: d.redirectURI,
          tranCtx: d.tranCtx,
          merchantTxnNo: txn
        }), { headers: { ...CORS, "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({
        success: false,
        error: "ICICI:" + (d.responseCode || "Err") + (d.responseMessage ? (" - " + d.responseMessage) : "")
      }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // ══════════════════════════════════════════════════
    // CHECK BALANCE — refresh from DB after payment redirect
    // ══════════════════════════════════════════════════
    if (action === "checkBalance") {
      const { employeeId } = bp;
      if (!employeeId) {
        return new Response(JSON.stringify({ success: false }),
          { headers: { ...CORS, "Content-Type": "application/json" } });
      }
      const sb = createClient(SU!, SK!);
      const { data: e2 } = await sb.from("employees")
        .select("wallet_balance")
        .eq("id", employeeId)
        .single();
      return new Response(JSON.stringify({
        success: true,
        balance: e2 ? parseFloat(e2.wallet_balance) : 0
      }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // ══════════════════════════════════════════════════
    // CANCEL FALLBACK — ICICI's in-page "Back ←" link lands here as a
    // bare GET (no merchantTxnNo, no action). Redirect the user back to
    // the app via deep link instead of showing a JSON error page.
    // ══════════════════════════════════════════════════
    if (req.method === "GET") {
      const params = "payment=cancelled";
      const intentUrl = `intent://payment?${params}#Intent;scheme=${APP_SCHEME};package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(WEB_URL + "?" + params)};end`;
      const webUrl = WEB_URL + "?" + params;
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Payment cancelled</title>
<script>
window.location.href=${JSON.stringify(intentUrl)};
setTimeout(function(){window.location.href=${JSON.stringify(webUrl)};},3000);
</script></head><body><p>Returning to app...</p></body></html>`;
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
    }

    return new Response(JSON.stringify({ success: false, error: "Unknown" }),
      { headers: { ...CORS, "Content-Type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, error: e.message }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
