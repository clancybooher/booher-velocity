// Protect all /api/* routes — attach userId to context.data
// Auth endpoints (/api/auth/*) pass through unauthenticated.
import { parseCookies, SESSION_COOKIE } from './auth/_crypto.js';

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // OPTIONS preflight — let it through always
  if (request.method === 'OPTIONS') return next();

  // Auth endpoints don't need a session
  if (url.pathname.startsWith('/api/auth/')) return next();

  const cookies   = parseCookies(request.headers.get('Cookie') || '');
  const sessionId = cookies[SESSION_COOKIE];

  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Not authenticated', code: 'UNAUTHENTICATED' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > datetime('now')`
  ).bind(sessionId).first();

  if (!row) {
    const clearCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    return new Response(JSON.stringify({ error: 'Session expired', code: 'UNAUTHENTICATED' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Set-Cookie': clearCookie,
      },
    });
  }

  // Attach user to context for downstream functions
  context.data.userId    = row.id;
  context.data.userEmail = row.email;
  context.data.userName  = row.name;

  return next();
}
