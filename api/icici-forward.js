export default function handler(req, res) {
    const { target } = req.query;
    if (!target) return res.status(400).send('Missing target');
    res.setHeader('Content-Type', 'text/html');
    res.send(
        <html>
        <head>
            <title>Redirecting to Secure Payment...</title>
            <meta name="referrer" content="origin" />
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #fafafa; margin: 0; }
                .loader { border: 4px solid #f3f3f3; border-top: 4px solid #f26b21; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; }
                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            </style>
        </head>
        <body>
            <div style="text-align: center;">
                <div class="loader" style="margin: 0 auto 16px auto;"></div>
                <div style="color: #666; font-size: 14px;">Connecting to ICICI Bank...</div>
            </div>
            <script>
                setTimeout(() => {
                    window.location.href = "";
                }, 100);
            </script>
        </body>
        </html>
    );
}
