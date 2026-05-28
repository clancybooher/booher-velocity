import type { Env } from './index';

// ── Types ────────────────────────────────────────────────────────────────────

export interface LedgerEntry {
  id: string;
  type: 'receipt' | 'bank_transaction';
  date: string;
  vendor: string;
  amount: number;
  category: string;
  notes?: string;
  teller_transaction_id?: string;
  teller_account_id?: string;
  created_at: string;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const BUDGET_CATEGORIES = [
  'Groceries', 'Dining Out & Coffee', 'Utilities & Bills', 'Transportation & Gas',
  'Entertainment & Date Nights', 'Home & Maintenance', 'Health & Personal Care',
  'Travel & Vacations', 'Savings & Investments', 'Gifts & Giving', 'Miscellaneous',
] as const;

const DEFAULT_BUDGETS: Record<string, number> = {
  'Groceries': 800, 'Dining Out & Coffee': 300, 'Utilities & Bills': 400,
  'Transportation & Gas': 250, 'Entertainment & Date Nights': 150,
  'Home & Maintenance': 200, 'Health & Personal Care': 100,
  'Travel & Vacations': 200, 'Savings & Investments': 500,
  'Gifts & Giving': 100, 'Miscellaneous': 100,
};

const SHEET_HEADERS = ['Date', 'Vendor', 'Amount', 'Category', 'Notes', 'ID', 'Type'];

// ── KV helpers ───────────────────────────────────────────────────────────────

async function loadLedger(env: Env): Promise<LedgerEntry[]> {
  const raw = await env.VELOCITY_KV.get('ledger');
  return raw ? JSON.parse(raw) : [];
}

async function saveLedger(env: Env, entries: LedgerEntry[]): Promise<void> {
  await env.VELOCITY_KV.put('ledger', JSON.stringify(entries));
}

async function loadBudgets(env: Env): Promise<Record<string, number>> {
  const raw = await env.VELOCITY_KV.get('budgets');
  return raw ? { ...DEFAULT_BUDGETS, ...JSON.parse(raw) } : { ...DEFAULT_BUDGETS };
}

async function saveBudgets(env: Env, budgets: Record<string, number>): Promise<void> {
  await env.VELOCITY_KV.put('budgets', JSON.stringify(budgets));
}

async function loadCursor(env: Env): Promise<Record<string, string>> {
  const raw = await env.VELOCITY_KV.get('teller_cursor');
  return raw ? JSON.parse(raw) : {};
}

async function saveCursor(env: Env, cursor: Record<string, string>): Promise<void> {
  await env.VELOCITY_KV.put('teller_cursor', JSON.stringify(cursor));
}

async function loadMerchantMap(env: Env): Promise<Record<string, string>> {
  const raw = await env.VELOCITY_KV.get('merchant_map');
  return raw ? JSON.parse(raw) : {};
}

function makeId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function pastMonths(n: number): string[] {
  const months: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toISOString().slice(0, 7));
  }
  return months;
}

function getMonthSpent(entries: LedgerEntry[], yearMonth: string): Record<string, number> {
  const spent: Record<string, number> = {};
  for (const e of entries) {
    if (e.date.startsWith(yearMonth)) {
      const cat = e.category;
      spent[cat] = (spent[cat] ?? 0) + Math.abs(e.amount);
    }
  }
  return spent;
}

// ── Google Sheets auth ───────────────────────────────────────────────────────

async function getGoogleToken(env: Env): Promise<string> {
  const cached = await env.VELOCITY_KV.get('_gtoken', 'json') as { token: string; exp: number } | null;
  if (cached && cached.exp > Date.now() / 1000 + 60) return cached.token;

  const sa: ServiceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);

  const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const sigInput = `${header}.${payload}`;

  const pemBody = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', keyBytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBytes = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(sigInput));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const jwt = `${sigInput}.${sig}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await resp.json() as { access_token: string };
  await env.VELOCITY_KV.put('_gtoken', JSON.stringify({ token: data.access_token, exp: now + 3500 }));
  return data.access_token;
}

async function sheetsRequest(
  env: Env, method: string, path: string, body?: unknown
): Promise<unknown> {
  const token = await getGoogleToken(env);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}${path}`;
  const resp = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) throw new Error(`Sheets API ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

function entryToRow(e: LedgerEntry): (string | number)[] {
  return [e.date, e.vendor, -Math.abs(e.amount), e.category, e.notes ?? '', e.id, e.type];
}

async function sheetsAppendRow(env: Env, row: (string | number)[]): Promise<void> {
  await sheetsRequest(env, 'POST', `/values/Transactions!A:G:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    values: [row],
  });
}

async function sheetsClearRange(env: Env, range: string): Promise<void> {
  await sheetsRequest(env, 'POST', `/values/${encodeURIComponent(range)}:clear`, {});
}

async function sheetsUpdateRange(env: Env, range: string, values: (string | number)[][]): Promise<void> {
  await sheetsRequest(env, 'PUT', `/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, { values });
}

// ── Teller ───────────────────────────────────────────────────────────────────

async function tellerGet(env: Env, path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`https://api.teller.io${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const auth = btoa(`${env.TELLER_ACCESS_TOKEN}:`);
  const resp = await env.TELLER_MTLS.fetch(url.toString(), {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`Teller ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

function autoCategory(vendor: string, merchantMap: Record<string, string>): string {
  const key = vendor.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (merchantMap[key]) return merchantMap[key];

  const patterns: [RegExp, string][] = [
    [/costco|safeway|kroger|traderjoe|wholefoods|walmart|target|fred.?meyer|winco|albertson/i, 'Groceries'],
    [/starbucks|mcdonald|chipotle|panda|subway|domino|pizza|sushi|restaurant|cafe|coffee|doordash|grubhub|ubereats/i, 'Dining Out & Coffee'],
    [/comcast|xfinity|pacific.*power|pg&e|power|electric|gas.*company|water|internet|att|verizon|spotify|netflix|hulu/i, 'Utilities & Bills'],
    [/shell|chevron|arco|76|exxon|mobil|costco.*gas|uber|lyft|parking|fred.*meyer.*gas/i, 'Transportation & Gas'],
    [/amazon|apple|google.*play|steam|netflix|hulu|disney|ticketmaster|eventbrite/i, 'Entertainment & Date Nights'],
    [/home.*depot|lowes|ace.*hardware|ikea|wayfair|hardware/i, 'Home & Maintenance'],
    [/cvs|walgreen|rite.*aid|pharmacy|doctor|dental|vision|gym|fitness/i, 'Health & Personal Care'],
    [/hotel|motel|airbnb|expedia|delta|southwest|alaska.*air|flight|airline/i, 'Travel & Vacations'],
    [/venmo|paypal|transfer|investment|fidelity|vanguard|schwab|robinhood/i, 'Savings & Investments'],
  ];
  for (const [re, cat] of patterns) if (re.test(vendor)) return cat;
  return 'Miscellaneous';
}

// ── Tool implementations ─────────────────────────────────────────────────────

export async function saveReceipt(
  env: Env,
  args: { vendor: string; total: number; date: string; category: string; notes?: string }
): Promise<object> {
  const entries = await loadLedger(env);
  const budgets = await loadBudgets(env);
  const yearMonth = args.date.slice(0, 7);

  // Duplicate check
  const dup = entries.find(e =>
    e.vendor.toLowerCase() === args.vendor.toLowerCase() &&
    Math.abs(Math.abs(e.amount) - args.total) < 0.02 &&
    e.date === args.date
  );
  if (dup) {
    return { duplicate: true, existing_id: dup.id, message: 'Receipt already logged.' };
  }

  const entry: LedgerEntry = {
    id: makeId(),
    type: 'receipt',
    date: args.date,
    vendor: args.vendor,
    amount: -args.total,
    category: args.category,
    notes: args.notes,
    created_at: new Date().toISOString(),
  };

  entries.push(entry);
  await saveLedger(env, entries);

  const monthSpent = getMonthSpent(entries, yearMonth);
  const spent = monthSpent[args.category] ?? 0;
  const budget = budgets[args.category] ?? 0;
  const remaining = budget - spent;

  // Append to Sheets (best-effort)
  try {
    await sheetsAppendRow(env, entryToRow(entry));
    // Refresh Budget tab
    const budgetRows = buildBudgetRows(entries, budgets);
    await sheetsClearRange(env, 'Budget!A:Z');
    await sheetsUpdateRange(env, 'Budget!A1', budgetRows);
  } catch { /* sheets errors are non-fatal */ }

  return {
    id: entry.id,
    vendor: args.vendor,
    total: args.total,
    category: args.category,
    date: args.date,
    monthly_budget: budget,
    monthly_spent: spent,
    remaining,
    over_budget: remaining < 0,
  };
}

export async function getBudgetSummary(env: Env, args: { year_month?: string }): Promise<object> {
  const yearMonth = args.year_month ?? currentYearMonth();
  const entries = await loadLedger(env);
  const budgets = await loadBudgets(env);
  const spent = getMonthSpent(entries, yearMonth);

  const summary = BUDGET_CATEGORIES.map(cat => ({
    category: cat,
    budget: budgets[cat] ?? 0,
    spent: Math.round((spent[cat] ?? 0) * 100) / 100,
    remaining: Math.round(((budgets[cat] ?? 0) - (spent[cat] ?? 0)) * 100) / 100,
    over: (spent[cat] ?? 0) > (budgets[cat] ?? 0),
  }));

  const totalBudget = summary.reduce((s, c) => s + c.budget, 0);
  const totalSpent  = summary.reduce((s, c) => s + c.spent, 0);

  return { year_month: yearMonth, summary, total_budget: totalBudget, total_spent: Math.round(totalSpent * 100) / 100 };
}

export async function getEnvelopeBalance(env: Env, args: { category: string; year_month?: string }): Promise<object> {
  const yearMonth = args.year_month ?? currentYearMonth();
  const entries = await loadLedger(env);
  const budgets = await loadBudgets(env);
  const spent = getMonthSpent(entries, yearMonth)[args.category] ?? 0;
  const budget = budgets[args.category] ?? 0;
  return { category: args.category, budget, spent: Math.round(spent * 100) / 100, remaining: Math.round((budget - spent) * 100) / 100 };
}

export async function getSpendingByCategory(env: Env, args: { year_month?: string; category?: string }): Promise<object> {
  const yearMonth = args.year_month ?? currentYearMonth();
  const entries = await loadLedger(env);
  const filtered = entries.filter(e => e.date.startsWith(yearMonth) && (!args.category || e.category === args.category));
  const byCategory: Record<string, { total: number; items: { date: string; vendor: string; amount: number }[] }> = {};
  for (const e of filtered) {
    if (!byCategory[e.category]) byCategory[e.category] = { total: 0, items: [] };
    byCategory[e.category].total += Math.abs(e.amount);
    byCategory[e.category].items.push({ date: e.date, vendor: e.vendor, amount: Math.abs(e.amount) });
  }
  return { year_month: yearMonth, spending: byCategory };
}

export async function listReceipts(env: Env, args: { limit?: number; start_date?: string }): Promise<object> {
  const entries = await loadLedger(env);
  let filtered = [...entries].sort((a, b) => b.date.localeCompare(a.date));
  if (args.start_date) filtered = filtered.filter(e => e.date >= args.start_date!);
  return { receipts: filtered.slice(0, args.limit ?? 20) };
}

export async function searchReceipts(env: Env, args: { keyword: string; start_date?: string }): Promise<object> {
  const entries = await loadLedger(env);
  const kw = args.keyword.toLowerCase();
  const filtered = entries.filter(e => {
    const match = e.vendor.toLowerCase().includes(kw) || (e.notes ?? '').toLowerCase().includes(kw);
    return match && (!args.start_date || e.date >= args.start_date);
  }).sort((a, b) => b.date.localeCompare(a.date));
  return { keyword: args.keyword, results: filtered.slice(0, 50) };
}

export async function correctCategory(env: Env, args: { entry_id: string; new_category: string }): Promise<object> {
  const entries = await loadLedger(env);
  const idx = entries.findIndex(e => e.id === args.entry_id);
  if (idx < 0) return { error: `Entry ${args.entry_id} not found` };
  entries[idx].category = args.new_category;
  await saveLedger(env, entries);
  // Full sync to sheets to reflect category change
  try { await sheetsSyncAll(env, {}); } catch { /* non-fatal */ }
  return { updated: true, entry: entries[idx] };
}

export async function setMonthlyBudget(env: Env, args: { category: string; amount: number }): Promise<object> {
  const budgets = await loadBudgets(env);
  const prev = budgets[args.category];
  budgets[args.category] = args.amount;
  await saveBudgets(env, budgets);
  try {
    const entries = await loadLedger(env);
    const rows = buildBudgetRows(entries, budgets);
    await sheetsClearRange(env, 'Budget!A:Z');
    await sheetsUpdateRange(env, 'Budget!A1', rows);
  } catch { /* non-fatal */ }
  return { category: args.category, previous: prev, new_amount: args.amount };
}

export async function trainMerchantCategory(env: Env, args: { merchant: string; category: string }): Promise<object> {
  const map = await loadMerchantMap(env);
  const key = args.merchant.toLowerCase().replace(/[^a-z0-9]/g, '');
  map[key] = args.category;
  await env.VELOCITY_KV.put('merchant_map', JSON.stringify(map));
  return { merchant: args.merchant, category: args.category, saved: true };
}

export async function analyzeSpendingPatterns(env: Env, args: { months_back?: number }): Promise<object> {
  const n = args.months_back ?? 3;
  const months = pastMonths(n);
  const entries = await loadLedger(env);
  const budgets = await loadBudgets(env);

  const avgs: Record<string, number> = {};
  for (const cat of BUDGET_CATEGORIES) {
    const total = months.reduce((s, m) => s + (getMonthSpent(entries, m)[cat] ?? 0), 0);
    avgs[cat] = Math.round((total / n) * 100) / 100;
  }

  const analysis = BUDGET_CATEGORIES.map(cat => {
    const avg = avgs[cat];
    const budget = budgets[cat] ?? 0;
    const pct = budget > 0 ? Math.round((avg / budget) * 100) : 0;
    const trend = avg > budget * 1.05 ? 'over' : avg < budget * 0.6 ? 'under' : 'on_track';
    return { category: cat, avg_monthly: avg, budget, pct, trend };
  });

  return { months_analyzed: months, analysis };
}

export async function suggestBudgetAdjustments(env: Env, args: { months_back?: number }): Promise<object> {
  const n = args.months_back ?? 3;
  const { analysis } = await analyzeSpendingPatterns(env, { months_back: n }) as {
    analysis: Array<{ category: string; avg_monthly: number; budget: number; trend: string }>;
  };
  const budgets = await loadBudgets(env);

  const suggestions = analysis
    .filter(a => a.trend !== 'on_track')
    .map(a => {
      const suggested = Math.ceil(a.avg_monthly / 25) * 25;
      return {
        category: a.category,
        current_budget: budgets[a.category] ?? 0,
        avg_spent: a.avg_monthly,
        suggested_budget: suggested,
        action: a.trend === 'over' ? 'increase' : 'decrease',
        confidence: 'high',
      };
    });

  const netChange = suggestions.reduce((s, sg) => s + (sg.suggested_budget - sg.current_budget), 0);
  return { suggestions, net_monthly_change: netChange };
}

export async function applyBudgetAdjustments(env: Env, args: { months_back?: number }): Promise<object> {
  const { suggestions } = await suggestBudgetAdjustments(env, args) as {
    suggestions: Array<{ category: string; suggested_budget: number }>;
  };
  const budgets = await loadBudgets(env);
  for (const s of suggestions) budgets[s.category] = s.suggested_budget;
  await saveBudgets(env, budgets);
  try {
    const entries = await loadLedger(env);
    const rows = buildBudgetRows(entries, budgets);
    await sheetsClearRange(env, 'Budget!A:Z');
    await sheetsUpdateRange(env, 'Budget!A1', rows);
  } catch { /* non-fatal */ }
  return { applied: suggestions.length, updated_budgets: budgets };
}

// ── Sheets sync ──────────────────────────────────────────────────────────────

function buildBudgetRows(entries: LedgerEntry[], budgets: Record<string, number>): (string | number)[][] {
  const yearMonth = currentYearMonth();
  const spent = getMonthSpent(entries, yearMonth);
  const rows: (string | number)[][] = [['Category', 'Monthly Budget', 'Spent', 'Remaining', 'Month']];
  for (const cat of BUDGET_CATEGORIES) {
    const b = budgets[cat] ?? 0;
    const s = Math.round((spent[cat] ?? 0) * 100) / 100;
    rows.push([cat, b, s, Math.round((b - s) * 100) / 100, yearMonth]);
  }
  return rows;
}

export async function sheetsSyncAll(env: Env, _args: object): Promise<object> {
  const entries = await loadLedger(env);
  const budgets = await loadBudgets(env);
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));

  const txRows: (string | number)[][] = [SHEET_HEADERS, ...sorted.map(entryToRow)];
  await sheetsClearRange(env, 'Transactions!A:Z');
  await sheetsUpdateRange(env, 'Transactions!A1', txRows);

  const budgetRows = buildBudgetRows(entries, budgets);
  await sheetsClearRange(env, 'Budget!A:Z');
  await sheetsUpdateRange(env, 'Budget!A1', budgetRows);

  return { synced: true, transaction_rows: sorted.length };
}

// ── Teller sync ──────────────────────────────────────────────────────────────

export async function tellerSyncTransactions(env: Env, _args: object): Promise<object> {
  const cursor = await loadCursor(env);
  const merchantMap = await loadMerchantMap(env);
  const entries = await loadLedger(env);
  const budgets = await loadBudgets(env);

  const accounts = await tellerGet(env, '/accounts') as Array<{ id: string; name: string; type: string; subtype: string }>;
  const newEntries: LedgerEntry[] = [];

  for (const acct of accounts) {
    const params: Record<string, string> = { count: '100' };
    const fromId = cursor[acct.id];
    if (fromId) params.from_id = fromId;

    const txns = await tellerGet(env, `/accounts/${acct.id}/transactions`, params) as Array<{
      id: string; date: string; description: string; amount: string;
      details?: { counterparty?: { name?: string }; category?: string };
    }>;

    let latestId = fromId;
    for (const txn of txns) {
      // Skip if already in ledger
      if (entries.some(e => e.teller_transaction_id === txn.id)) continue;

      const amount = parseFloat(txn.amount);
      if (amount >= 0) continue; // Skip credits/deposits

      const vendor = txn.details?.counterparty?.name ?? txn.description;
      const category = autoCategory(vendor, merchantMap);

      const entry: LedgerEntry = {
        id: makeId(),
        type: 'bank_transaction',
        date: txn.date,
        vendor,
        amount,
        category,
        teller_transaction_id: txn.id,
        teller_account_id: acct.id,
        created_at: new Date().toISOString(),
      };
      newEntries.push(entry);
      if (!latestId || txn.id > latestId) latestId = txn.id;
    }
    if (latestId) cursor[acct.id] = latestId;
  }

  if (newEntries.length > 0) {
    const updated = [...entries, ...newEntries];
    await saveLedger(env, updated);
    await saveCursor(env, cursor);

    // Append new rows to sheets
    try {
      for (const e of newEntries) await sheetsAppendRow(env, entryToRow(e));
      const budgetRows = buildBudgetRows(updated, budgets);
      await sheetsClearRange(env, 'Budget!A:Z');
      await sheetsUpdateRange(env, 'Budget!A1', budgetRows);
    } catch { /* non-fatal */ }
  } else {
    await saveCursor(env, cursor);
  }

  const yearMonth = currentYearMonth();
  const allEntries = newEntries.length > 0 ? [...entries, ...newEntries] : entries;
  const spent = getMonthSpent(allEntries, yearMonth);
  const hotEnvelopes = BUDGET_CATEGORIES
    .map(cat => ({ category: cat, spent: spent[cat] ?? 0, budget: budgets[cat] ?? 0 }))
    .filter(c => c.spent > c.budget);

  return {
    new_transactions: newEntries.length,
    new_items: newEntries.map(e => ({ date: e.date, vendor: e.vendor, amount: e.amount, category: e.category })),
    hot_envelopes: hotEnvelopes,
  };
}

// ── Hourly sync (called by cron) ─────────────────────────────────────────────

export async function runHourlySync(env: Env): Promise<{ new_transactions: number; message: string }> {
  const result = await tellerSyncTransactions(env, {}) as {
    new_transactions: number;
    new_items: Array<{ date: string; vendor: string; amount: number; category: string }>;
    hot_envelopes: Array<{ category: string; spent: number; budget: number }>;
  };

  if (result.new_transactions === 0) return { new_transactions: 0, message: 'HEARTBEAT_OK — no new transactions' };

  const lines = result.new_items.map(
    t => `• ${t.date} ${t.vendor}: $${Math.abs(t.amount).toFixed(2)} → ${t.category}`
  );
  const alerts = result.hot_envelopes.map(
    h => `⚠️ ${h.category} over by $${(h.spent - h.budget).toFixed(2)}`
  );

  let msg = `💳 ${result.new_transactions} new transaction${result.new_transactions > 1 ? 's' : ''}:\n${lines.join('\n')}`;
  if (alerts.length) msg += `\n\n${alerts.join('\n')}`;

  return { new_transactions: result.new_transactions, message: msg };
}

// ── Tool dispatcher ──────────────────────────────────────────────────────────

type ToolArgs = Record<string, unknown>;

export async function executeTool(env: Env, name: string, args: ToolArgs): Promise<unknown> {
  switch (name) {
    case 'save_receipt':           return saveReceipt(env, args as Parameters<typeof saveReceipt>[1]);
    case 'get_budget_summary':     return getBudgetSummary(env, args as { year_month?: string });
    case 'get_envelope_balance':   return getEnvelopeBalance(env, args as { category: string; year_month?: string });
    case 'get_spending_by_category': return getSpendingByCategory(env, args as { year_month?: string; category?: string });
    case 'list_receipts':          return listReceipts(env, args as { limit?: number; start_date?: string });
    case 'search_receipts':        return searchReceipts(env, args as { keyword: string; start_date?: string });
    case 'correct_category':       return correctCategory(env, args as { entry_id: string; new_category: string });
    case 'set_monthly_budget':     return setMonthlyBudget(env, args as { category: string; amount: number });
    case 'train_merchant_category': return trainMerchantCategory(env, args as { merchant: string; category: string });
    case 'analyze_spending_patterns': return analyzeSpendingPatterns(env, args as { months_back?: number });
    case 'suggest_budget_adjustments': return suggestBudgetAdjustments(env, args as { months_back?: number });
    case 'apply_suggested_budget': return applyBudgetAdjustments(env, args as { months_back?: number });
    case 'sheets_sync_all':        return sheetsSyncAll(env, {});
    case 'teller_sync_transactions': return tellerSyncTransactions(env, {});
    default: return { error: `Unknown tool: ${name}` };
  }
}
