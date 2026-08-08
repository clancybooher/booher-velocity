// Recurring monthly bills — budgeted in but NOT counted as spent until
// they're actually paid. Pairing with functions/api/recurring/pay.js and
// unpay.js, which create/remove the real ledger entry.
//
// GET /api/recurring?month=YYYY-MM (optional, defaults to current month)
//   → { ok, month, bills: [{id,label,amount,category,dueDay}],
//       paid: { [billId]: { txnId, paidAt, amount } } }
// PUT /api/recurring → { bills: [...] } replaces the whole list, round-trips
//   id + dueDay (id auto-assigned if missing, dueDay clamped to 1-28)

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const KEY = 'household:recurring';
const PAID_KEY_PREFIX = 'recurring:paid:';

export const MONTH_RE = /^\d{4}-\d{2}$/;

export function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function genId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function clampDueDay(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(28, Math.max(1, n));
}

// Reads the bill list, migrating any legacy bills that have no id (assigns
// one and writes the migrated array back to KV). Idempotent — once every
// bill has an id, subsequent reads don't write.
export async function readBills(env) {
  const raw = await env.VELOCITY_KV.get(KEY);
  const stored = raw ? JSON.parse(raw) : [];

  let needsMigration = false;
  const bills = stored.map(b => {
    let id = typeof b.id === 'string' ? b.id.trim() : '';
    if (!id) {
      id = genId();
      needsMigration = true;
    }
    return {
      id,
      label: String(b.label || '').trim(),
      amount: Math.round(Math.abs(parseFloat(b.amount) || 0) * 100) / 100,
      category: String(b.category || 'Biz: Bills & Subs'),
      dueDay: clampDueDay(b.dueDay),
    };
  });

  if (needsMigration) {
    await env.VELOCITY_KV.put(KEY, JSON.stringify(bills));
  }
  return bills;
}

export async function writeBills(env, bills) {
  await env.VELOCITY_KV.put(KEY, JSON.stringify(bills));
}

export async function readPaid(env, month) {
  const raw = await env.VELOCITY_KV.get(`${PAID_KEY_PREFIX}${month}`);
  return raw ? JSON.parse(raw) : {};
}

export async function writePaid(env, month, paid) {
  await env.VELOCITY_KV.put(`${PAID_KEY_PREFIX}${month}`, JSON.stringify(paid));
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const qMonth = url.searchParams.get('month');
    const month = qMonth && MONTH_RE.test(qMonth) ? qMonth : currentMonth();

    const bills = await readBills(env);
    const paid = await readPaid(env, month);

    return new Response(JSON.stringify({ ok: true, month, bills, paid }), { headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
}

export async function onRequestPut({ request, env }) {
  try {
    const { bills } = await request.json();
    const usedIds = new Set();
    const clean = (bills || [])
      .map(b => {
        let id = typeof b.id === 'string' ? b.id.trim() : '';
        if (!id || usedIds.has(id)) id = genId();
        usedIds.add(id);
        return {
          id,
          label: String(b.label || '').trim(),
          amount: Math.round(Math.abs(parseFloat(b.amount) || 0) * 100) / 100,
          category: String(b.category || 'Biz: Bills & Subs'),
          dueDay: clampDueDay(b.dueDay),
        };
      })
      .filter(b => b.label && b.amount > 0);
    await writeBills(env, clean);
    return new Response(JSON.stringify({ ok: true, bills: clean }), { headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
}
