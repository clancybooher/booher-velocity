// One shared household ledger for Clancy & Naomi.
//
// GET    /api/transactions — all entries, newest first
// POST   /api/transactions — add an entry { vendor, amount, date, category, person, notes, photoId? }
// PATCH  /api/transactions — edit fields on an entry by id
// DELETE /api/transactions — remove an entry by id (also deletes its photo)

import { learnRule } from './rules.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const LEDGER_KEY = 'household:ledger';
const BUSINESS_CATEGORIES = [
  'Biz: Diesel', 'Biz: Advertising', 'Biz: Coffee Shop', 'Biz: Tesla',
  'Biz: Trailer', 'Biz: Bills & Subs',
];

async function readLedger(env) {
  const raw = await env.VELOCITY_KV.get(LEDGER_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function writeLedger(env, entries) {
  await env.VELOCITY_KV.put(LEDGER_KEY, JSON.stringify(entries));
}

// On the first app use of a new month, post the recurring bills
// (household:recurring) into the ledger, dated the 1st and tagged "Bills".
async function postRecurringBills(env) {
  const ym = new Date().toISOString().slice(0, 7);
  const flagKey = `recurring:posted:${ym}`;
  if (await env.VELOCITY_KV.get(flagKey)) return;

  const raw = await env.VELOCITY_KV.get('household:recurring');
  const bills = raw ? JSON.parse(raw) : [];
  await env.VELOCITY_KV.put(flagKey, '1');
  if (!bills.length) return;

  const entries = await readLedger(env);
  const now = new Date().toISOString();
  bills.forEach(b => entries.push({
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
    date: `${ym}-01`,
    vendor: b.label,
    amount: -Math.abs(b.amount),
    category: b.category || 'Biz: Bills & Subs',
    person: 'Bills',
    notes: 'Monthly bill (auto)',
    photoId: null,
    created_at: now,
  }));
  await writeLedger(env, entries);
}

export async function onRequestGet({ env }) {
  try {
    await postRecurringBills(env);
    const entries = await readLedger(env);
    entries.sort((a, b) => b.date.localeCompare(a.date) || (b.created_at || '').localeCompare(a.created_at || ''));
    return new Response(JSON.stringify({ ok: true, transactions: entries }), { headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const today = new Date().toISOString().split('T')[0];
    const entry = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      date: body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : today,
      vendor: String(body.vendor || 'Unknown').trim() || 'Unknown',
      amount: -Math.abs(parseFloat(body.amount) || 0),
      category: body.category || 'Everything Else',
      person: ['Naomi', 'Bills'].includes(body.person) ? body.person : 'Clancy',
      notes: String(body.notes || body.note || '').trim(),
      photoId: body.photoId || null,
      created_at: new Date().toISOString(),
    };

    // Re-read right before writing so a save from the other phone isn't lost
    const entries = await readLedger(env);
    entries.push(entry);
    await writeLedger(env, entries);

    // If they filed it somewhere other than the AI's guess, remember that
    if (body.aiCategory && body.aiCategory !== entry.category) {
      await learnRule(env, entry.vendor, entry.category, BUSINESS_CATEGORIES.includes(entry.category));
    }

    return new Response(JSON.stringify({ ok: true, entry }), { headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
}

export async function onRequestPatch({ request, env }) {
  try {
    const body = await request.json();
    if (!body.id) {
      return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: JSON_HEADERS });
    }
    const entries = await readLedger(env);
    const idx = entries.findIndex(e => e.id === body.id);
    if (idx < 0) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: JSON_HEADERS });

    const e = entries[idx];
    if (body.category !== undefined) e.category = body.category;
    if (body.person !== undefined) e.person = ['Naomi', 'Bills'].includes(body.person) ? body.person : 'Clancy';
    if (body.vendor !== undefined) e.vendor = String(body.vendor).trim() || e.vendor;
    if (body.notes !== undefined) e.notes = String(body.notes).trim();
    if (body.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) e.date = body.date;
    if (body.amount !== undefined) e.amount = -Math.abs(parseFloat(body.amount) || 0);

    await writeLedger(env, entries);

    // Recategorizing an existing expense teaches the same lesson
    if (body.category !== undefined) {
      await learnRule(env, e.vendor, e.category, BUSINESS_CATEGORIES.includes(e.category));
    }

    return new Response(JSON.stringify({ ok: true, entry: e }), { headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
}

export async function onRequestDelete({ request, env }) {
  try {
    const { id } = await request.json();
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: JSON_HEADERS });

    const entries = await readLedger(env);
    const gone = entries.find(e => e.id === id);
    await writeLedger(env, entries.filter(e => e.id !== id));
    if (gone?.photoId) {
      try { await env.VELOCITY_KV.delete(`photo:${gone.photoId}`); } catch {}
    }
    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
}
