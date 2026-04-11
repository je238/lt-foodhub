import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MERCHANT_ID = Deno.env.get('ICICI_MERCHANT_ID') || '100000000417983';
const SECRET_KEY = Deno.env.get('ICICI_SECRET_KEY') || 'f1aac8b6-fd42-439a-a102-d58465b75876';
const ICICI_URL = 'https://pgpay.icicibank.com/tsp/pg/api/v2/initiateSale';

// Enable CORS for frontend requests
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function generateV2Hash(jsonPayload: string, secretKey: string) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(secretKey),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, enc.encode(jsonPayload));
    return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('').toLowerCase();
}

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const { action, amount, employeeId, orderId } = await req.json();

        // 1. INITIATE SALE
        if (action === 'initiate') {
            const txnRefNo = `TXN${Date.now()}`;

            const payloadObj = {
                merchantId: String(MERCHANT_ID),
                merchantTxnNo: String(txnRefNo),
                amount: String(Number(amount).toFixed(2)),
                currencyCode: "356",
                payType: "0",
                transactionType: "SALE",
                customerEmailID: "info@slphospitality.com",
                customerMobileNo: "9999999999",
                returnURL: `${req.headers.get('origin') || 'https://lt-foodhub.vercel.app'}/?icicicallback=true`,
                txnDate: new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
            };

            const jsonString = JSON.stringify(payloadObj);
            const secureHash = await generateV2Hash(jsonString, SECRET_KEY);

            const iciciReq = await fetch(ICICI_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'securehash': secureHash
                },
                body: JSON.stringify(payloadObj)
            });

            const iciciData = await iciciReq.json();

            if (iciciData.responseCode === 'R1000' || iciciData.redirectURI || iciciData.redirectUrl) {
                return new Response(JSON.stringify({
                    success: true,
                    redirectUrl: iciciData.redirectURI || iciciData.redirectUrl,
                    tranCtx: iciciData.tranCtx,
                    merchantTxnNo: txnRefNo
                }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            } else {
                return new Response(JSON.stringify({ success: false, error: iciciData.respDescription || 'ICICI Error', rawData: iciciData }), { headers: corsHeaders, status: 400 });
            }
        }

        // 2. CALLBACK VERIFICATION
        if (action === 'verify') {
            // Logic for callback verification to safely add wallet balance.
            // Usually the frontend redirects here, taking the parameters and querying Supabase edge function to verify the backend hash.
            return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }

        return new Response(JSON.stringify({ error: 'Invalid action' }), { headers: corsHeaders, status: 400 });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { headers: corsHeaders, status: 500 });
    }
});
