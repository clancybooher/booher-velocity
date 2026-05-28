// POST /api/auth/logout  — invalidate session
import { parseCookies, SESSION_COOKIE, CORS } from './_crypto.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const cookies   = parseCookies(request.headers.get('Cookie') || '');
  const sessionId = cookies[SESSION_COOKIE];

  if (sessionId) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run().catch(() => {});
  }

  const clearCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...CORS, 'Set-Cookie': clearCookie },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
  });
}
