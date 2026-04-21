import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Restricted origins — web app only. APK uses capacitor:// and ignores CORS.
const ALLOWED_ORIGINS = new Set([
  "https://lt-foodhub.vercel.app",
  "http://localhost",
  "http://localhost:5173",
  "http://localhost:3000",
  "capacitor://localhost",
]);

function corsFor(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "https://lt-foodhub.vercel.app";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

// FIX 1: Cryptographically secure OTP
function generateSecureOTP(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return String(100000 + (array[0] % 900000));
}

serve(async (req) => {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { email } = await req.json();

    if (!email || !email.includes("@")) {
      return new Response(JSON.stringify({ success: false, error: "Invalid email" }), {
        headers: { ...cors, "Content-Type": "application/json" }, status: 400,
      });
    }

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // FIX 2: Rate limiting — max 3 OTP requests per email per 10 minutes
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: recentOtps } = await sb
      .from("email_otps")
      .select("created_at")
      .eq("email", email)
      .gte("created_at", tenMinutesAgo);

    if (recentOtps && recentOtps.length >= 3) {
      return new Response(JSON.stringify({
        success: false,
        error: "Too many OTP requests. Please wait 10 minutes before trying again."
      }), {
        headers: { ...cors, "Content-Type": "application/json" }, status: 429,
      });
    }

    // Check employee exists
    const { data: emp } = await sb.from("employees").select("id, name, email").eq("email", email).single();
    if (!emp) {
      return new Response(JSON.stringify({ success: false, error: "Email not registered. Please register first." }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Generate secure OTP
    const otp = generateSecureOTP();
    const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // DELETE old OTP, INSERT fresh
    await sb.from("email_otps").delete().eq("email", email);
    await sb.from("email_otps").insert({
      email,
      otp_code: otp,
      expires_at: expiry,
      attempts: 0,
      verified: false,
      created_at: new Date().toISOString(),
    });

    const [user, domain] = email.split("@");
    const maskedEmail = user.slice(0, 2) + "***@" + domain;

    const resendKey = Deno.env.get("RESEND_API_KEY")!;
    const fromAddr = Deno.env.get("RESEND_FROM") || "noreply@slphospitality.com";

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `SLP FoodHub <${fromAddr}>`,
        to: [email],
        // FIX 3: OTP removed from subject — not visible in email previews
        subject: `Your FoodHub Login Code`,
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
        <tr><td style="background:linear-gradient(135deg,#0F172A 0%,#1E3A5F 100%);padding:28px 32px;text-align:center">
          <div style="display:inline-block;background:#E8380D;border-radius:12px;padding:10px 18px;margin-bottom:12px">
            <span style="font-size:20px;font-weight:800;color:#fff;letter-spacing:1px">L&T FoodHub</span>
          </div>
          <div style="color:rgba(255,255,255,.6);font-size:13px">Powered by SLP Hospitality</div>
        </td></tr>
        <tr><td style="padding:36px 32px;text-align:center">
          <p style="margin:0 0 8px;font-size:16px;color:#1E293B;font-weight:600">Hello, ${emp.name || "there"} 👋</p>
          <p style="margin:0 0 28px;font-size:14px;color:#64748B">Use the OTP below to login to your FoodHub account</p>
          <div style="background:#f1f5f9;border-radius:12px;padding:24px;margin:0 0 24px;display:inline-block;min-width:200px">
            <div style="font-size:11px;font-weight:700;color:#94A3B8;letter-spacing:2px;margin-bottom:10px;text-transform:uppercase">Your OTP</div>
            <div style="font-size:42px;font-weight:800;color:#E8380D;letter-spacing:12px;font-family:'Courier New',monospace">${otp}</div>
          </div>
          <p style="margin:0 0 8px;font-size:13px;color:#94A3B8">⏰ Valid for <strong>10 minutes</strong> only</p>
          <p style="margin:0 0 28px;font-size:13px;color:#94A3B8">🔒 Never share this code with anyone</p>
          <div style="background:#FEF0ED;border-radius:8px;padding:14px;font-size:12px;color:#E8380D">
            If you didn't request this OTP, please ignore this email.
          </div>
        </td></tr>
        <tr><td style="background:#f8fafc;padding:20px 32px;text-align:center;border-top:1px solid #E2E8F0">
          <p style="margin:0;font-size:11px;color:#94A3B8">SLP Hospitality · Campus Canteen Management</p>
          <p style="margin:4px 0 0;font-size:11px;color:#CBD5E1">
            <a href="https://slphospitality.com" style="color:#CBD5E1">slphospitality.com</a> ·
            <a href="https://slphospitality.com/privacy-policy" style="color:#CBD5E1">Privacy Policy</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
      }),
    });

    if (!emailRes.ok) {
      const err = await emailRes.text();
      console.error("Resend error:", err);
      return new Response(JSON.stringify({ success: false, error: "Failed to send email. Try again." }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, maskedEmail }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("Edge function error:", e);
    return new Response(JSON.stringify({ success: false, error: "An error occurred. Please try again." }), {
      headers: { ...cors, "Content-Type": "application/json" }, status: 500,
    });
  }
});
