// Vercel Serverless Function — handles ICICI POST callback after payment.
// Returns HTML that immediately deep-links back to the SLP Nexus APK
// (via slpnexus:// scheme registered in AndroidManifest), with a web fallback
// for users not on the APK.
export default function handler(req, res) {
    const data = req.body || {};

    console.log('ICICI Callback received:', JSON.stringify(data));

    // ICICI success codes: "0000" (Orange PG) or "E000" (EazyPay)
    const responseCode = data.responseCode || data.Response_Code || '';
    const isSuccess = responseCode === '0000' || responseCode === 'E000' || responseCode === 'SUCCESS';
    const status = isSuccess ? 'success' : 'failed';
    const txnNo = data.merchantTxnNo || data.MerchantTxnNo || '';
    const iciciTxnNo = data.iciciTxnNo || data.IciciTxnNo || data.BankRefNo || '';
    const amount = data.amount || data.Amount || '';
    const message = data.message || data.errorMessage || data.Message || responseCode;

    const params = `payment=${encodeURIComponent(status)}` +
        `&txn=${encodeURIComponent(txnNo)}` +
        `&iciciTxn=${encodeURIComponent(iciciTxnNo)}` +
        `&amount=${encodeURIComponent(amount)}` +
        `&code=${encodeURIComponent(responseCode)}` +
        `&msg=${encodeURIComponent(message)}`;

    const deepLink = `slpnexus://payment-result?${params}`;
    const webLink = `https://lt-foodhub.vercel.app/?${params}`;

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Payment ${isSuccess ? 'Successful' : 'Failed'} — Returning to SLP Nexus</title>
  <style>
    body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; background: #0F172A; color: white; margin: 0; padding: 32px; min-height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
    .icon { font-size: 64px; margin-bottom: 16px; }
    h1 { margin: 8px 0; font-size: 22px; font-weight: 700; }
    p { color: #94a3b8; line-height: 1.5; max-width: 360px; margin: 8px 0; }
    .btn { background: #E8380D; color: white; padding: 14px 32px; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; margin-top: 24px; cursor: pointer; text-decoration: none; display: inline-block; }
    .spinner { border: 3px solid rgba(255,255,255,0.15); border-top-color: #E8380D; border-radius: 50%; width: 36px; height: 36px; animation: spin 1s linear infinite; margin: 16px 0; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .small { font-size: 13px; margin-top: 16px; color: #64748b; }
  </style>
</head>
<body>
  <div class="icon">${isSuccess ? '✅' : '❌'}</div>
  <h1>Payment ${isSuccess ? 'Successful' : 'Failed'}</h1>
  <div class="spinner"></div>
  <p>Returning to the SLP Nexus app...</p>
  <a href="${deepLink}" class="btn">Open SLP Nexus App</a>
  <p class="small">If the app does not open automatically, tap the button above.</p>

  <script>
    // Step 1: try the slpnexus:// deep link (APK users)
    setTimeout(function() {
      window.location.href = ${JSON.stringify(deepLink)};
    }, 100);

    // Step 2: web fallback — only fires if the page is still visible after 3s
    // (i.e. the deep link did NOT switch the user back to the app)
    setTimeout(function() {
      if (document.visibilityState !== 'hidden') {
        window.location.href = ${JSON.stringify(webLink)};
      }
    }, 3000);
  </script>
</body>
</html>`);
}
