import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const MERCHANT_ID = Deno.env.get('ICICI_MERCHANT_ID') || '100000000417983';
const AGGREGATOR_ID = Deno.env.get('ICICI_AGGREGATOR_ID') || '100000000417982';
const SECRET_KEY = Deno.env.get('ICICI_SECURE_KEY') || 'f1aac8b6-fd42-439a-a102-d58465b75876';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ICICI Hash = HMAC-SHA256 of VALUES concatenated in ALPHABETICAL order of parameter NAMES
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
    return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const body = await req.json();
        const { action } = body;

        // ── GENERATE HASH — browser will submit form directly to ICICI ──
        if (action === 'initiate') {
            const { amount, employeeId, employeeName, employeeEmail, employeePhone } = body;
            const txnRefNo = `TXN${Date.now()}`;
            const amt = Number(amount).toFixed(2);
            const txnDate = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
            const returnURL = 'https://lt-foodhub.vercel.app/';

            const params: Record<string, string> = {
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

            const secureHash = await generateICICIHash(params, SECRET_KEY);
            console.log('Generated hash:', secureHash);

            // Return ALL params + hash to the browser — browser will POST to ICICI directly
            return new Response(JSON.stringify({
                success: true,
                iciciUrl: 'https://pgpay.icicibank.com/pg/api/v2/initiateSale',
                params: { ...params, secureHash },
                merchantTxnNo: txnRefNo,
            }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // ── VERIFY CALLBACK ────────────────────────────────────────────
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
