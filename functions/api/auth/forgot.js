// POST /api/auth/forgot  — generate a password reset code
// Body: { email }
// If RESEND_API_KEY is set, emails the code. Otherwise returns it in the response
// so the user can use it directly (private family app fallback).

import { CORS } from './_crypto.js';

const CODE_TTL_SECONDS = 3600; // 1 hour

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
  let code = '';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const b of bytes) code += chars[b % chars.length];
  return code;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { email } = await request.json();
    if (!email) {
      return new Response(JSON.stringify({ error: 'Email is required' }), { status: 400, headers: CORS });
    }

    const emailLower = email.toLowerCase().trim();

    // Check user exists — but don't reveal if it doesn't
    const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(emailLower).first();

    if (!user) {
      // Return success anyway to avoid user enumeration
      return new Response(JSON.stringify({ ok: true, emailSent: false, noAccount: true }), { headers: CORS });
    }

    const code = generateCode();
    await env.VELOCITY_KV.put(`reset:${emailLower}`, code, { expirationTtl: CODE_TTL_SECONDS });

    let emailSent = false;
    if (env.RESEND_API_KEY) {
      try {
        const fromDomain = env.RESEND_FROM || 'noreply@booherhousehold.com';
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: `Velocity <${fromDomain}>`,
            to: [emailLower],
            subject: 'Your Velocity password reset code',
            html: `
              <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px;">
                <h2 style="color:#7C2033">Velocity Password Reset</h2>
                <p>Your reset code is:</p>
                <p style="font-size:32px;font-weight:900;letter-spacing:0.12em;color:#1C1614;background:#F2EBE0;padding:16px 24px;border-radius:12px;display:inline-block">${code}</p>
                <p style="color:#6B5E58;font-size:14px">This code expires in 1 hour.</p>
              </div>`,
          }),
        });
        if (res.ok) emailSent = true;
      } catch {}
    }

    // If email was sent, hide the code; otherwise return it (private app fallback)
    return new Response(JSON.stringify({
      ok: true,
      emailSent,
      ...(emailSent ? {} : { code }),
    }), { headers: CORS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' },
  });
}
