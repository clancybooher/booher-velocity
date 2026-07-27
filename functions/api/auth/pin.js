// Shared household PIN — one PIN for both phones.
//
// GET    /api/auth/pin          → { set: true|false }  (has a PIN been created yet?)
// POST   /api/auth/pin  { pin } → first call creates the PIN, later calls verify it;
//                                 success sets a long-lived session cookie
// DELETE /api/auth/pin          → log this device out

const SESSION_TTL = 60 * 60 * 24 * 365; // 1 year — it's a household app
const MAX_FAILS = 10;
const FAIL_WINDOW = 900; // 15 min lockout window

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function hashPin(pin, salt) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${salt}:${pin}`)
  );
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function sessionCookie(token, maxAge) {
  return `velocity_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function onRequestGet({ env }) {
  const rec = await env.VELOCITY_KV.get('auth:pin');
  return new Response(JSON.stringify({ set: !!rec }), { headers: JSON_HEADERS });
}

export async function onRequestPost({ request, env }) {
  let pin;
  try {
    ({ pin } = await request.json());
  } catch {
    return new Response(JSON.stringify({ error: 'Bad request' }), { status: 400, headers: JSON_HEADERS });
  }

  if (!/^\d{4,8}$/.test(String(pin || ''))) {
    return new Response(JSON.stringify({ error: 'PIN must be 4–8 digits' }), { status: 400, headers: JSON_HEADERS });
  }
  pin = String(pin);

  const fails = parseInt(await env.VELOCITY_KV.get('auth:fails') || '0', 10);
  if (fails >= MAX_FAILS) {
    return new Response(JSON.stringify({ error: 'Too many attempts — try again in 15 minutes' }), { status: 429, headers: JSON_HEADERS });
  }

  const raw = await env.VELOCITY_KV.get('auth:pin');

  if (!raw) {
    // First run — create the household PIN
    const salt = crypto.randomUUID();
    const hash = await hashPin(pin, salt);
    await env.VELOCITY_KV.put('auth:pin', JSON.stringify({ salt, hash }));
  } else {
    const { salt, hash } = JSON.parse(raw);
    const attempt = await hashPin(pin, salt);
    if (attempt !== hash) {
      await env.VELOCITY_KV.put('auth:fails', String(fails + 1), { expirationTtl: FAIL_WINDOW });
      return new Response(JSON.stringify({ error: 'Wrong PIN' }), { status: 401, headers: JSON_HEADERS });
    }
  }

  await env.VELOCITY_KV.delete('auth:fails');

  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  await env.VELOCITY_KV.put(`session:${token}`, '1', { expirationTtl: SESSION_TTL });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...JSON_HEADERS, 'Set-Cookie': sessionCookie(token, SESSION_TTL) },
  });
}

export async function onRequestDelete({ request, env }) {
  const cookies = Object.fromEntries(
    (request.headers.get('Cookie') || '')
      .split(';')
      .map(c => c.trim().split('='))
      .filter(p => p.length === 2)
  );
  const token = cookies['velocity_session'];
  if (token) await env.VELOCITY_KV.delete(`session:${token}`);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...JSON_HEADERS, 'Set-Cookie': sessionCookie('', 0) },
  });
}
