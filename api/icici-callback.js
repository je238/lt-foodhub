// Vercel Serverless Function — handles ICICI POST callback after payment
export default function handler(req, res) {
    // ICICI POSTs payment result to returnURL
    const data = req.body || {};
    
    console.log('ICICI Callback received:', JSON.stringify(data));

    // Extract payment result fields from ICICI's POST
    const status = data.responseCode === 'E000' ? 'success' : 'failed';
    const txnNo = data.merchantTxnNo || '';
    const iciciTxnNo = data.iciciTxnNo || '';
    const amount = data.amount || '';
    const responseCode = data.responseCode || '';
    const message = data.message || data.errorMessage || '';

    // Redirect browser back to the app with result as query params
    const redirectUrl = `https://lt-foodhub.vercel.app/?payment=${status}&txn=${txnNo}&iciciTxn=${iciciTxnNo}&amount=${amount}&code=${responseCode}&msg=${encodeURIComponent(message)}`;
    
    res.redirect(302, redirectUrl);
}
