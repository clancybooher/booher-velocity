// POST /api/auth/reset  — verify reset code and set new password
// Body: { email, code, newPassword }

import { hashPassword, CORS } from './_crypto.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { email, code, newPassword } = await request.json();
    if (!email || !code || !newPassword) {
      return new Response(JSON.stringify({ error: 'Email, code, and new password are required' }), { status: 400, headers: CORS });
    }
    if (newPassword.length < 8) {
      return new Response(JSON.stringify({ error: 'Password must be at least 8 characters' }), { status: 400, headers: CORS });
    }

    const emailLower = email.toLowerCase().trim();
    const stored = await env.VELOCITY_KV.get(`reset:${emailLower}`);

    if (!stored || stored.toUpperCase() !== code.toUpperCase().trim()) {
      return new Response(JSON.stringify({ error: 'Invalid or expired reset code' }), { status: 400, headers: CORS });
    }

    // Code is valid — update password
    const newHash = await hashPassword(newPassword);
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE email = ?').bind(newHash, emailLower).run();

    // Invalidate all sessions for this user
    const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(emailLower).first();
    if (user) {
      await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
    }

    // Delete the reset token
    await env.VELOCITY_KV.delete(`reset:${emailLower}`);

    return new Response(JSON.stringify({ ok: true }), { headers: CORS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' },
  });
}
