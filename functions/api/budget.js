// GET  /api/budget  — returns budget amounts + this-month spending from KV
// POST /api/budget  — saves budget envelope amounts to KV

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const CATEGORIES = [
  'Groceries', 'Dining Out & Coffee', 'Utilities & Bills', 'Transportation & Gas',
  'Entertainment & Date Nights', 'Home & Maintenance', 'Health & Personal Care',
  'Travel & Vacations', 'Savings & Investments', 'Gifts & Giving', 'Miscellaneous',
];

const DEFAULT_BUDGETS = {
  'Groceries': 800, 'Dining Out & Coffee': 300, 'Utilities & Bills': 400,
  'Transportation & Gas': 250, 'Entertainment & Date Nights': 150,
  'Home & Maintenance': 200, 'Health & Personal Care': 100,
  'Travel & Vacations': 200, 'Savings & Investments': 500,
  'Gifts & Giving': 100, 'Miscellaneous': 100,
};

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.VELOCITY_KV) {
    return new Response(JSON.stringify({ error: 'VELOCITY_KV not bound' }), { status: 503, headers: CORS });
  }
  try {
    const [ledgerRaw, budgetsRaw] = await Promise.all([
      env.VELOCITY_KV.get('ledger'),
      env.VELOCITY_KV.get('budgets'),
    ]);
    const entries = ledgerRaw ? JSON.parse(ledgerRaw) : [];
    const budgets = budgetsRaw ? { ...DEFAULT_BUDGETS, ...JSON.parse(budgetsRaw) } : { ...DEFAULT_BUDGETS };

    // Compute spending for current calendar month
    const now = new Date();
    const ym  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const spent = {};
    for (const e of entries) {
      if (!e.date.startsWith(ym)) continue;
      const amt = Math.abs(parseFloat(e.amount) || 0);
      spent[e.category] = (spent[e.category] || 0) + amt;
    }

    const cats = {};
    let totalBudget = 0, totalSpent = 0;
    for (const cat of CATEGORIES) {
      const budget    = budgets[cat] || 0;
      const s         = Math.round((spent[cat] || 0) * 100) / 100;
      const remaining = Math.round((budget - s) * 100) / 100;
      cats[cat]       = { budget, spent: s, remaining };
      totalBudget    += budget;
      totalSpent     += s;
    }

    return new Response(JSON.stringify({
      ok: true,
      yearMonth: ym,
      cats,
      totalBudget,
      totalSpent: Math.round(totalSpent * 100) / 100,
    }), { headers: CORS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.VELOCITY_KV) {
    return new Response(JSON.stringify({ error: 'VELOCITY_KV not bound' }), { status: 503, headers: CORS });
  }
  try {
    const body = await request.json();
    // Accept either {categories:[{category, amount}]} or {cat: amount, ...}
    let updates;
    if (Array.isArray(body.categories)) {
      updates = {};
      for (const { category, amount } of body.categories) {
        updates[category] = parseFloat(amount) || 0;
      }
    } else {
      updates = body;
    }

    const existing = await env.VELOCITY_KV.get('budgets');
    const budgets  = existing ? JSON.parse(existing) : { ...DEFAULT_BUDGETS };
    for (const [cat, amt] of Object.entries(updates)) {
      if (CATEGORIES.includes(cat)) budgets[cat] = parseFloat(amt) || 0;
    }
    await env.VELOCITY_KV.put('budgets', JSON.stringify(budgets));
    return new Response(JSON.stringify({ ok: true, budgets }), { headers: CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}
