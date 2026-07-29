// Savings goals — Italy, Bali, a road bike. What the money is actually for.
//
// GET  /api/goals              → { ok, goals: [...] }
// PUT  /api/goals { goals }    → replace the list
// POST /api/goals { id, add }  → add (or, with a negative number, remove) savings

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const KEY = 'household:goals';

async function read(env) {
  const raw = await env.VELOCITY_KV.get(KEY);
  return raw ? JSON.parse(raw) : [];
}

export async function onRequestGet({ env }) {
  return new Response(JSON.stringify({ ok: true, goals: await read(env) }), { headers: JSON_HEADERS });
}

export async function onRequestPut({ request, env }) {
  try {
    const { goals } = await request.json();
    const existing = await read(env);
    const clean = (goals || [])
      .map(g => {
        const prior = existing.find(e => e.id === g.id);
        return {
          id: g.id || crypto.randomUUID().replace(/-/g, '').slice(0, 10),
          name: String(g.name || '').trim().slice(0, 60),
          target: Math.max(0, Math.round((parseFloat(g.target) || 0) * 100) / 100),
          // never let an edit silently wipe money already put aside
          saved: Math.max(0, Math.round((parseFloat(g.saved ?? prior?.saved ?? 0) || 0) * 100) / 100),
          due: /^\d{4}-\d{2}(-\d{2})?$/.test(g.due || '') ? g.due : '',
          created_at: prior?.created_at || new Date().toISOString(),
        };
      })
      .filter(g => g.name && g.target > 0);
    await env.VELOCITY_KV.put(KEY, JSON.stringify(clean));
    return new Response(JSON.stringify({ ok: true, goals: clean }), { headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const { id, add } = await request.json();
    const goals = await read(env);
    const g = goals.find(x => x.id === id);
    if (!g) return new Response(JSON.stringify({ error: 'Goal not found' }), { status: 404, headers: JSON_HEADERS });
    g.saved = Math.max(0, Math.round((g.saved + (parseFloat(add) || 0)) * 100) / 100);
    await env.VELOCITY_KV.put(KEY, JSON.stringify(goals));
    return new Response(JSON.stringify({ ok: true, goal: g }), { headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
}
