// email/send.js
// Sends transactional emails via the Resend API using native fetch (no extra deps).
// Set RESEND_API_KEY in Railway Variables to enable real delivery.
// In dev (no key), the verification link is printed to the console instead.

function verificationHtml(verifyUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:480px;margin:40px auto;padding:40px 32px;background:#111;border:1px solid #222;border-radius:16px;">
    <div style="text-align:center;margin-bottom:28px;">
      <span style="font-size:1.4rem;font-weight:800;color:#D9B65A;letter-spacing:0.12em;">AUREON</span>
    </div>
    <h1 style="color:#fff;font-size:1.2rem;font-weight:700;margin:0 0 12px;line-height:1.3;">Verify your email address</h1>
    <p style="color:rgba(255,255,255,0.6);font-size:0.875rem;line-height:1.65;margin:0 0 28px;">
      Click the button below to verify your email and unlock full access to Aureon — including alerts, favorites, and portfolio tracking.
    </p>
    <div style="text-align:center;margin-bottom:28px;">
      <a href="${verifyUrl}"
         style="display:inline-block;background:#D9B65A;color:#000;font-weight:700;
                font-size:0.9rem;padding:14px 36px;border-radius:10px;
                text-decoration:none;letter-spacing:0.03em;">
        Verify my email
      </a>
    </div>
    <p style="color:rgba(255,255,255,0.35);font-size:0.72rem;line-height:1.55;margin:0 0 20px;text-align:center;">
      This link expires in 24 hours. If you didn't create an Aureon account, you can safely ignore this email.
    </p>
    <hr style="border:none;border-top:1px solid #1e1e1e;margin:20px 0;" />
    <p style="color:rgba(255,255,255,0.2);font-size:0.68rem;text-align:center;margin:0;">
      Aureon · Real-time market insight powered by AI<br>
      This is an automated message — please do not reply.
    </p>
  </div>
</body>
</html>`;
}

export async function sendVerificationEmail({ to, token, baseUrl }) {
  const verifyUrl = `${baseUrl}/api/auth/verify?token=${token}`;

  if (!process.env.RESEND_API_KEY) {
    // Always log the link so local dev can verify without an email service
    console.log(`[email:dev] Verification link for ${to}:`);
    console.log(`[email:dev] ${verifyUrl}`);
    // On Render (RENDER=true is injected automatically) a missing key is a
    // misconfiguration — return a real error so callers surface it correctly.
    if (process.env.RENDER) {
      console.error('[email] RESEND_API_KEY is not set — email was NOT sent. Add it in Render → Environment → RESEND_API_KEY');
      return { ok: false, error: 'Email service not configured (RESEND_API_KEY missing)' };
    }
    return { ok: true };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:    process.env.EMAIL_FROM || 'Aureon <onboarding@resend.dev>',
        to,
        subject: 'Verify your Aureon account',
        html:    verificationHtml(verifyUrl),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('[email] Resend API error:', res.status, body);
      return { ok: false, error: body };
    }

    console.log(`[email] Verification email sent to ${to}`);
    return { ok: true };
  } catch (err) {
    console.error('[email] Failed to send verification email:', err.message);
    return { ok: false, error: err.message };
  }
}
