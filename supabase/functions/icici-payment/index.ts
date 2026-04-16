import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const MERCHANT_ID = Deno.env.get('ICICI_MERCHANT_ID') || '100000000417983';
const AGGREGATOR_ID = Deno.env.get('ICICI_AGGREGATOR_ID') || '100000000417982';
const SECRET_KEY = Deno.env.get('ICICI_SECURE_KEY') || 'f1aac8b6-fd42-439a-a102-d58465b75876';
const ICICI_URL = 'https://pgpay.icicibank.com/pg/api/v2/initiateSale';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ICICI Hash = HMAC-SHA256 of VALUES concatenated in ALPHABETICAL order of parameter NAMES
// IMPORTANT: aggregatorID is EXCLUDED from hash (per ICICI sample)
async function generateICICIHash(params: Record<string, string>, secretKey: string): Promise<string> {
    const sortedKeys = Object.keys(params).sort();
    const hashText = sortedKeys.map(k => params[k]).join('');

    console.log('Hash keys order:', sortedKeys.join(', '));
    console.log('Hash text:', hashText);

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(secretKey),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, enc.encode(hashText));
    const hash = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
    console.log('Generated hash:', hash);
    return hash;
}

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const body = await req.json();
        const { action } = body;

        if (action === 'initiate') {
            const { amount, employeeId, employeeName, employeeEmail, employeePhone } = body;
            const txnRefNo = `TXN${Date.now()}`;
            const amt = Number(amount).toFixed(2);
            const txnDate = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
            const returnURL = 'https://lt-foodhub.vercel.app/api/icici-callback';

            // Parameters for HASH — aggregatorID IS included
            const hashParams: Record<string, string> = {
                addlParam1: employeeId || '000',
                addlParam2: 'TOPUP',
                aggregatorID: AGGREGATOR_ID,
                amount: amt,
                currencyCode: '356',
                customerEmailID: employeeEmail || 'info@slphospitality.com',
                customerMobileNo: employeePhone || '9999999999',
                customerName: employeeName || 'SLP Employee',
                merchantId: MERCHANT_ID,
                merchantTxnNo: txnRefNo,
                payType: '0',
                returnURL: returnURL,
                transactionType: 'SALE',
                txnDate: txnDate,
            };

            const secureHash = await generateICICIHash(hashParams, SECRET_KEY);

            // Full request body = hash params + secureHash
            const requestBody = {
                ...hashParams,
                secureHash: secureHash,
            };

            console.log('ICICI request body:', JSON.stringify(requestBody));

            const iciciRes = await fetch(ICICI_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });

            const iciciData = await iciciRes.json();
            console.log('ICICI res:', JSON.stringify(iciciData));

            if (iciciData.responseCode === 'R1000' && (iciciData.redirectURI || iciciData.redirectUrl)) {
                const redirectBase = iciciData.redirectURI || iciciData.redirectUrl;

                return new Response(JSON.stringify({
                    success: true,
                    redirectUrl: redirectBase,
                    tranCtx: iciciData.tranCtx,
                    merchantTxnNo: txnRefNo,
                }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
            } else {
                return new Response(JSON.stringify({
                    success: false,
                    error: iciciData.message || iciciData.responseCode || 'ICICI rejected the request',
                    rawResponse: iciciData,
                }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
            }
        }

        if (action === 'verify') {
            return new Response(JSON.stringify({ success: true }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        return new Response(JSON.stringify({ error: 'Invalid action' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 400,
        });

    } catch (error) {
        console.error('Edge function error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
        });
    }
});
