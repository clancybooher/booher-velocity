// POST /api/auth/signup  — create a new account
import { hashPassword, SESSION_COOKIE, SESSION_DAYS, CORS } from './_crypto.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { email, password, name } = await request.json();

    if (!email || !password || !name) {
      return new Response(JSON.stringify({ error: 'Name, email and password are required' }), { status: 400, headers: CORS });
    }
    if (password.length < 8) {
      return new Response(JSON.stringify({ error: 'Password must be at least 8 characters' }), { status: 400, headers: CORS });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ error: 'Invalid email address' }), { status: 400, headers: CORS });
    }

    const emailLower = email.toLowerCase().trim();
    const nameClean  = name.trim();

    // Check if email already exists
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(emailLower).first();
    if (existing) {
      return new Response(JSON.stringify({ error: 'An account with this email already exists' }), { status: 409, headers: CORS });
    }

    const userId      = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    await env.DB.prepare(
      'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)'
    ).bind(userId, emailLower, nameClean, passwordHash).run();

    // Create session immediately after signup
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
    ).bind(sessionId, userId, expiresAt).run();

    const cookie = `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;

    return new Response(JSON.stringify({
      ok: true,
      user: { id: userId, email: emailLower, name: nameClean },
    }), {
      headers: { ...CORS, 'Set-Cookie': cookie },
    });

  } catch (err) {
    console.error('Signup error:', err);
    return new Response(JSON.stringify({ error: 'Signup failed: ' + err.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
  });
}
