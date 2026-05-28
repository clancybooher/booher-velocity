// GET /api/auth/me  — return the currently logged-in user (or 401)
import { parseCookies, SESSION_COOKIE, CORS } from './_crypto.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const cookies   = parseCookies(request.headers.get('Cookie') || '');
  const sessionId = cookies[SESSION_COOKIE];

  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: CORS });
  }

  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > datetime('now')`
  ).bind(sessionId).first();

  if (!row) {
    const clearCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    return new Response(JSON.stringify({ error: 'Session expired' }), {
      status: 401,
      headers: { ...CORS, 'Set-Cookie': clearCookie },
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    user: { id: row.id, email: row.email, name: row.name, createdAt: row.created_at },
  }), { headers: CORS });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
  });
}
