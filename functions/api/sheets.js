// /api/sheets — KV-backed budget and recategorize operations
// (Formerly proxied to Google Apps Script; now reads/writes Cloudflare KV directly)

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

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.VELOCITY_KV) {
    return new Response(JSON.stringify({ error: 'VELOCITY_KV not bound' }), { status: 503, headers: CORS });
  }

  try {
    const body = await request.json();

    if (body.action === 'update_budget') {
      const categories = body.categories || [];
      const existing   = await env.VELOCITY_KV.get('budgets');
      const budgets    = existing ? JSON.parse(existing) : { ...DEFAULT_BUDGETS };
      for (const { category, amount } of categories) {
        if (CATEGORIES.includes(category)) budgets[category] = parseFloat(amount) || 0;
      }
      await env.VELOCITY_KV.put('budgets', JSON.stringify(budgets));
      return new Response(JSON.stringify({ ok: true, action: 'budget_updated' }), { headers: CORS });
    }

    if (body.action === 'recategorize') {
      const raw     = await env.VELOCITY_KV.get('ledger');
      const entries = raw ? JSON.parse(raw) : [];
      // Find by vendor + amount match (last occurrence, like the GAS version)
      for (let i = entries.length - 1; i >= 0; i--) {
        const vendorMatch = String(entries[i].vendor).toLowerCase().trim() === String(body.vendor).toLowerCase().trim();
        const amtMatch    = Math.abs(Math.abs(parseFloat(entries[i].amount)) - Math.abs(parseFloat(body.amount))) < 0.02;
        if (vendorMatch && amtMatch) {
          entries[i].category = body.newCategory;
          await env.VELOCITY_KV.put('ledger', JSON.stringify(entries));
          return new Response(JSON.stringify({ ok: true, action: 'recategorized' }), { headers: CORS });
        }
      }
      return new Response(JSON.stringify({ ok: false, error: 'Transaction not found' }), { headers: CORS });
    }

    return new Response(JSON.stringify({ ok: false, error: 'Unknown action: ' + body.action }), { status: 400, headers: CORS });

  } catch (err) {
    console.error('Data error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}
