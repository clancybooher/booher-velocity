// Recurring monthly bills — auto-posted to the ledger on the first app use
// of each month (see transactions.js).
//
// GET /api/recurring → { ok, bills: [{ label, amount, category }] }
// PUT /api/recurring → { bills: [...] } replaces the whole list

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const KEY = 'household:recurring';

export async function onRequestGet({ env }) {
  const raw = await env.VELOCITY_KV.get(KEY);
  return new Response(JSON.stringify({ ok: true, bills: raw ? JSON.parse(raw) : [] }), { headers: JSON_HEADERS });
}

export async function onRequestPut({ request, env }) {
  try {
    const { bills } = await request.json();
    const clean = (bills || [])
      .map(b => ({
        label: String(b.label || '').trim(),
        amount: Math.round(Math.abs(parseFloat(b.amount) || 0) * 100) / 100,
        category: String(b.category || 'Biz: Bills & Subs'),
      }))
      .filter(b => b.label && b.amount > 0);
    await env.VELOCITY_KV.put(KEY, JSON.stringify(clean));
    return new Response(JSON.stringify({ ok: true, bills: clean }), { headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
}
