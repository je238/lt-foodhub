// Vercel Serverless Function — handles ICICI POST callback after payment.
// Restored from v1.4 working commit d0e6f96 (lost in merge ddbc42b on 2026-04-21).
// When the request includes ?source=apk (set by the icici-payment edge fn for
// Capacitor users), the redirect uses the slpnexus:// scheme so Android routes
// it back into the APK. Web users get the normal HTTPS redirect.
export default function handler(req, res) {
    // ICICI POSTs payment result to returnURL
    const data = req.body || {};

    console.log('ICICI Callback received:', JSON.stringify(data));

    // Extract payment result fields from ICICI's POST
    // ICICI success codes: "0000" (Orange PG) or "E000" (EazyPay)
    const responseCode = data.responseCode || data.Response_Code || '';
    const isSuccess = responseCode === '0000' || responseCode === 'E000' || responseCode === 'SUCCESS';
    const status = isSuccess ? 'success' : 'failed';
    const txnNo = data.merchantTxnNo || data.MerchantTxnNo || '';
    const iciciTxnNo = data.iciciTxnNo || data.IciciTxnNo || data.BankRefNo || '';
    const amount = data.amount || data.Amount || '';
    const message = data.message || data.errorMessage || data.Message || responseCode;

    // Redirect browser back to the app (APK via slpnexus:// scheme) or web
    const { source } = req.query || {};
    const isApk = source === 'apk';
    const baseUrl = isApk ? 'slpnexus://payment' : 'https://lt-foodhub.vercel.app/';
    const redirectUrl = `${baseUrl}?payment=${status}&txn=${txnNo}&iciciTxn=${iciciTxnNo}&amount=${amount}&code=${responseCode}&msg=${encodeURIComponent(message)}`;

    res.redirect(302, redirectUrl);
}
