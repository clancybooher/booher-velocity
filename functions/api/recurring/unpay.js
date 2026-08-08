// Undo a recurring bill payment for a month — removes the ledger entry it
// created and clears the paid record. Idempotent: succeeds even if the bill
// wasn't marked paid for that month.
//
// POST /api/recurring/unpay
//   body { billId, month? }
//   → { ok: true }

import { readLedger, writeLedger } from '../transactions.js';
import { readPaid, writePaid, MONTH_RE, currentMonth } from '../recurring.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const billId = body.billId;
    if (!billId) {
      return new Response(JSON.stringify({ error: 'billId required' }), { status: 400, headers: JSON_HEADERS });
    }

    const month = body.month && MONTH_RE.test(body.month) ? body.month : currentMonth();

    const paid = await readPaid(env, month);
    const record = paid[billId];

    if (record) {
      const entries = await readLedger(env);
      await writeLedger(env, entries.filter(e => e.id !== record.txnId));
      delete paid[billId];
      await writePaid(env, month, paid);
    }

    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
}
