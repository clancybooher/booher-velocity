// GET    /api/transactions  — returns all transactions from KV (user-scoped)
// POST   /api/transactions  — adds a new transaction
// PATCH  /api/transactions  — re-categorizes a transaction by ID
// DELETE /api/transactions  — removes a transaction by ID

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

function kvKey(userId, key) { return `user:${userId}:${key}`; }

export async function onRequestGet(context) {
  const { env, data } = context;
  try {
    const raw = await env.VELOCITY_KV.get(kvKey(data.userId, 'ledger'));
    const entries = raw ? JSON.parse(raw) : [];
    entries.sort((a, b) => b.date.localeCompare(a.date));
    return new Response(JSON.stringify({ ok: true, transactions: entries }), { headers: CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestPost(context) {
  const { request, env, data } = context;
  try {
    const body  = await request.json();
    const today = new Date().toISOString().split('T')[0];
    const entry = {
      id:         crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      type:       'manual',
      date:       body.date || today,
      vendor:     String(body.vendor || 'Unknown').trim(),
      amount:     -Math.abs(parseFloat(body.amount) || 0),
      category:   body.category || 'Miscellaneous',
      notes:      String(body.notes || body.note || '').trim(),
      created_at: new Date().toISOString(),
    };

    const raw     = await env.VELOCITY_KV.get(kvKey(data.userId, 'ledger'));
    const entries = raw ? JSON.parse(raw) : [];
    entries.push(entry);
    await env.VELOCITY_KV.put(kvKey(data.userId, 'ledger'), JSON.stringify(entries));
    return new Response(JSON.stringify({ ok: true, entry }), { headers: CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestPatch(context) {
  const { request, env, data } = context;
  try {
    const { id, category } = await request.json();
    if (!id || !category) {
      return new Response(JSON.stringify({ error: 'id and category required' }), { status: 400, headers: CORS });
    }
    const raw     = await env.VELOCITY_KV.get(kvKey(data.userId, 'ledger'));
    const entries = raw ? JSON.parse(raw) : [];
    const idx = entries.findIndex(e => e.id === id);
    if (idx < 0) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: CORS });
    entries[idx].category = category;
    await env.VELOCITY_KV.put(kvKey(data.userId, 'ledger'), JSON.stringify(entries));
    return new Response(JSON.stringify({ ok: true, entry: entries[idx] }), { headers: CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestDelete(context) {
  const { request, env, data } = context;
  try {
    const { id } = await request.json();
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: CORS });
    const raw     = await env.VELOCITY_KV.get(kvKey(data.userId, 'ledger'));
    const entries = raw ? JSON.parse(raw) : [];
    const filtered = entries.filter(e => e.id !== id);
    await env.VELOCITY_KV.put(kvKey(data.userId, 'ledger'), JSON.stringify(filtered));
    return new Response(JSON.stringify({ ok: true }), { headers: CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
  });
}
