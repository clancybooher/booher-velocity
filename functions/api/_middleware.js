// Gate every /api/* route behind the shared-PIN session.
// /api/auth/* passes through so you can log in.

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') return next();
  if (url.pathname.startsWith('/api/auth/')) return next();

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
