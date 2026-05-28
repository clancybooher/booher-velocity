// GET  /api/budget  — budget + this-month spending (user-scoped KV)
// POST /api/budget  — save envelope amounts

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

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

function kvKey(userId, key) { return `user:${userId}:${key}`; }

export async function onRequestGet(context) {
  const { env, data } = context;
  try {
    const [ledgerRaw, budgetsRaw] = await Promise.all([
      env.VELOCITY_KV.get(kvKey(data.userId, 'ledger')),
      env.VELOCITY_KV.get(kvKey(data.userId, 'budgets')),
    ]);
    const entries = ledgerRaw  ? JSON.parse(ledgerRaw)  : [];
    const budgets = budgetsRaw ? { ...DEFAULT_BUDGETS, ...JSON.parse(budgetsRaw) } : { ...DEFAULT_BUDGETS };

    const now = new Date();
    const ym  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const spent = {};
    for (const e of entries) {
      if (!e.date.startsWith(ym)) continue;
      spent[e.category] = (spent[e.category] || 0) + Math.abs(parseFloat(e.amount) || 0);
    }

    const cats = {};
    let totalBudget = 0, totalSpent = 0;
    for (const cat of CATEGORIES) {
      const budget    = budgets[cat] || 0;
      const s         = Math.round((spent[cat] || 0) * 100) / 100;
      cats[cat]       = { budget, spent: s, remaining: Math.round((budget - s) * 100) / 100 };
      totalBudget    += budget;
      totalSpent     += s;
    }

    return new Response(JSON.stringify({
      ok: true, yearMonth: ym, cats,
      totalBudget, totalSpent: Math.round(totalSpent * 100) / 100,
    }), { headers: CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestPost(context) {
  const { request, env, data } = context;
  try {
    const body    = await request.json();
    const updates = Array.isArray(body.categories)
      ? Object.fromEntries(body.categories.map(({ category, amount }) => [category, parseFloat(amount) || 0]))
      : body;

    const existing = await env.VELOCITY_KV.get(kvKey(data.userId, 'budgets'));
    const budgets  = existing ? JSON.parse(existing) : { ...DEFAULT_BUDGETS };
    for (const [cat, amt] of Object.entries(updates)) {
      if (CATEGORIES.includes(cat)) budgets[cat] = parseFloat(amt) || 0;
    }
    await env.VELOCITY_KV.put(kvKey(data.userId, 'budgets'), JSON.stringify(budgets));
    return new Response(JSON.stringify({ ok: true, budgets }), { headers: CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
  });
}
