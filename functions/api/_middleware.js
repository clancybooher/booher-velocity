// Gate every /api/* route behind the shared-PIN session.
// /api/auth/* passes through so you can log in.
// Service-token (MCP / agent) bypass: Authorization: Bearer <token>
// matches env.MCP_SERVICE_TOKEN or env.VELOCITY_MCP_TOKEN.

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') return next();
  if (url.pathname.startsWith('/api/auth/')) return next();

  // Agent / MCP service-token bypass (no cookie required)
  const authHeader = request.headers.get('Authorization') || '';
  const bearer = authHeader.match(/^Bearer\s+(\S+)/i);
  if (bearer) {
    const expected = env.MCP_SERVICE_TOKEN || env.VELOCITY_MCP_TOKEN;
    if (expected && bearer[1] === expected) {
      return next();
    }
  }

  const cookies = Object.fromEntries(
    (request.headers.get('Cookie') || '')
      .split(';')
      .map(c => c.trim().split('='))
      .filter(p => p.length === 2)
  );
  const token = cookies['velocity_session'];
  const valid = token && await env.VELOCITY_KV.get(`session:${token}`);

  if (!valid) {
    return new Response(
      JSON.stringify({ error: 'Not authenticated', code: 'UNAUTHENTICATED' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return next();
}
