// POST /api/auth/login  — authenticate with email + password
import { verifyPassword, SESSION_COOKIE, SESSION_DAYS, CORS } from './_crypto.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { email, password } = await request.json();
    if (!email || !password) {
      return new Response(JSON.stringify({ error: 'Email and password are required' }), { status: 400, headers: CORS });
    }

    const emailLower = email.toLowerCase().trim();
    const user = await env.DB.prepare(
      'SELECT id, email, name, password_hash FROM users WHERE email = ?'
    ).bind(emailLower).first();

    if (!user) {
      // Avoid user enumeration — same response for wrong email or wrong password
      return new Response(JSON.stringify({ error: 'Invalid email or password' }), { status: 401, headers: CORS });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return new Response(JSON.stringify({ error: 'Invalid email or password' }), { status: 401, headers: CORS });
    }

    // Create new session
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
    ).bind(sessionId, user.id, expiresAt).run();

    const cookie = `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;

    return new Response(JSON.stringify({
      ok: true,
      user: { id: user.id, email: user.email, name: user.name },
    }), {
      headers: { ...CORS, 'Set-Cookie': cookie },
    });

  } catch (err) {
    console.error('Login error:', err);
    return new Response(JSON.stringify({ error: 'Login failed: ' + err.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
  });
}
