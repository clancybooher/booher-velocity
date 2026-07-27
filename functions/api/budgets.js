// Optional monthly budget per category (shared for the household).
//
// GET /api/budgets → { ok, budgets: { "Groceries": 800, ... } }
// PUT /api/budgets → { budgets: {...} } replaces the whole map

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const KEY = 'household:budgets';

export async function onRequestGet({ env }) {
  const raw = await env.VELOCITY_KV.get(KEY);
  return new Response(JSON.stringify({ ok: true, budgets: raw ? JSON.parse(raw) : {} }), { headers: JSON_HEADERS });
}

export async function onRequestPut({ request, env }) {
  try {
    const { budgets } = await request.json();
    const clean = {};
    for (const [cat, val] of Object.entries(budgets || {})) {
      const n = parseFloat(val);
      if (n > 0) clean[cat] = Math.round(n * 100) / 100;
    }
    await env.VELOCITY_KV.put(KEY, JSON.stringify(clean));
    return new Response(JSON.stringify({ ok: true, budgets: clean }), { headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
}
