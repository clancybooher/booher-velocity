// Mark a recurring bill paid for a month — creates the real ledger entry at
// the moment it's paid (see functions/api/transactions.js for the shared
// ledger and functions/api/recurring.js for the bill list + paid map).
//
// POST /api/recurring/pay
//   body { billId, month?, amount?, date? }
//   → { ok: true, transaction, paid: { txnId, paidAt, amount } }
//   → { ok: true, already: true, paid } if that bill was already marked
//     paid for the month (no duplicate ledger entry is created)

import { readLedger, writeLedger, BUSINESS_CATEGORIES } from '../transactions.js';
import { readBills, readPaid, writePaid, MONTH_RE, currentMonth } from '../recurring.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const billId = body.billId;
    if (!billId) {
      return new Response(JSON.stringify({ error: 'billId required' }), { status: 400, headers: JSON_HEADERS });
    }

    const month = body.month && MONTH_RE.test(body.month) ? body.month : currentMonth();

    const bills = await readBills(env);
    const bill = bills.find(b => b.id === billId);
    if (!bill) {
      return new Response(JSON.stringify({ error: 'Bill not found' }), { status: 404, headers: JSON_HEADERS });
    }

    const paid = await readPaid(env, month);
    if (paid[billId]) {
      return new Response(JSON.stringify({ ok: true, already: true, paid: paid[billId] }), { headers: JSON_HEADERS });
    }

    const amount = body.amount !== undefined ? Math.abs(parseFloat(body.amount) || 0) : bill.amount;
    const today = new Date().toISOString().split('T')[0];
    const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : today;
    const now = new Date().toISOString();

    const transaction = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      date,
      vendor: bill.label,
      amount: -Math.abs(amount),
      category: bill.category,
      person: 'Bills',
      notes: 'Monthly bill',
      photoId: null,
      card: BUSINESS_CATEGORIES.includes(bill.category) ? 'business' : 'personal',
      created_at: now,
    };

    // Re-read right before writing so a save from the other phone isn't lost
    const entries = await readLedger(env);
    entries.push(transaction);
    await writeLedger(env, entries);

    const record = { txnId: transaction.id, paidAt: now, amount };
    paid[billId] = record;
    await writePaid(env, month, paid);

    return new Response(JSON.stringify({ ok: true, transaction, paid: record }), { headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
}
