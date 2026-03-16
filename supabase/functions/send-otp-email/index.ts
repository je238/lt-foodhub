import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { email } = await req.json()

    if (!email || !email.includes('@')) {
      return new Response(
        JSON.stringify({ success: false, error: 'Valid email required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Create Supabase admin client (bypasses RLS)
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Generate OTP server-side
    const { data: otpResult, error: otpErr } = await supabaseAdmin.rpc('generate_email_otp', {
      p_email: email
    })

    if (otpErr || !otpResult?.success) {
      return new Response(
        JSON.stringify({ success: false, error: otpResult?.error || otpErr?.message || 'Failed to generate OTP' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const otp = otpResult.otp
    const employeeName = otpResult.employee_name || 'Employee'

    // Send email via Gmail SMTP
    const GMAIL_USER = Deno.env.get('GMAIL_USER')
    const GMAIL_APP_PASSWORD = Deno.env.get('GMAIL_APP_PASSWORD')

    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      console.error('GMAIL credentials not set')
      return new Response(
        JSON.stringify({ success: false, error: 'Email service not configured. Contact admin.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const client = new SMTPClient({
      connection: {
        hostname: 'smtp.gmail.com',
        port: 465,
        tls: true,
        auth: {
          username: GMAIL_USER,
          password: GMAIL_APP_PASSWORD,
        },
      },
    })

    const htmlBody = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <div style="display: inline-block; background: #E8380D; color: white; font-weight: 700; font-size: 16px; padding: 12px 18px; border-radius: 12px;">L&T FoodHub</div>
        </div>
        <h2 style="font-size: 22px; font-weight: 600; color: #0F172A; margin: 0 0 8px; text-align: center;">
          Hi ${employeeName.split(' ')[0]}!
        </h2>
        <p style="font-size: 15px; color: #64748B; text-align: center; margin: 0 0 28px;">
          Here's your one-time login code
        </p>
        <div style="background: #F8FAFC; border: 2px solid #E2E8F0; border-radius: 16px; padding: 24px; text-align: center; margin: 0 0 24px;">
          <div style="font-size: 36px; font-weight: 800; letter-spacing: 10px; color: #E8380D; font-family: monospace;">
            ${otp}
          </div>
          <p style="font-size: 13px; color: #94A3B8; margin: 12px 0 0;">Valid for 10 minutes</p>
        </div>
        <p style="font-size: 13px; color: #94A3B8; text-align: center; line-height: 1.6;">
          Enter this code in the FoodHub app to sign in.<br>
          If you didn't request this, please ignore this email.
        </p>
        <hr style="border: none; border-top: 1px solid #E2E8F0; margin: 28px 0 16px;">
        <p style="font-size: 11px; color: #CBD5E1; text-align: center;">
          L&T FoodHub &middot; Larsen &amp; Toubro &middot; Powai Campus, Mumbai
        </p>
      </div>
    `

    await client.send({
      from: `L&T FoodHub <${GMAIL_USER}>`,
      to: email,
      subject: `${otp} — Your FoodHub Login OTP`,
      content: `Your FoodHub OTP is: ${otp} (valid for 10 minutes)`,
      html: htmlBody,
    })

    await client.close()

    return new Response(
      JSON.stringify({
        success: true,
        message: `OTP sent to ${email}`,
        maskedEmail: email.replace(/(.{2})(.*)(@)/, '$1***$3')
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('Edge function error:', err)
    return new Response(
      JSON.stringify({ success: false, error: 'Failed to send email. Please try again.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
