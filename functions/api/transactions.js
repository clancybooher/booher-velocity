// One shared household ledger for Clancy & Naomi.
//
// GET    /api/transactions — all entries, newest first
//        optional query: ?year=YYYY&jobId=...&business=1&clientId=...
// POST   /api/transactions — add an entry
// PATCH  /api/transactions — edit fields on an entry by id
// DELETE /api/transactions — remove an entry by id (keeps photo for audit)
//
// Optional job-costing / tax fields (all backward-compatible):
//   jobId, clientId, receiptDriveId, taxCategory, deductible, taxYear

import { learnRule, learnCardLast4, tidyVendor } from './rules.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const LEDGER_KEY = 'household:ledger';

// ── Schedule C–oriented contractor tax codes (Peak View OS Phase 3) ─────────
export const TAX_CATEGORIES = [
  'materials',
  'subcontractors',
  'vehicle_fuel',
  'vehicle_maint',
  'tools_equipment',
  'ads_marketing',
  'office_software',
  'insurance',
  'permits_fees',
  'disposal',
  'meals',
  'travel',
  'rent_storage',
  'professional',
  'training',
  'misc_business',
];

// Legacy phone-app labels — still accepted, mapped → tax codes
export const LEGACY_BIZ_CATEGORIES = [
  'Biz: Diesel', 'Biz: Advertising', 'Biz: Coffee Shop', 'Biz: Tesla',
  'Biz: Trailer', 'Biz: Bills & Subs',
];

export const LEGACY_TO_TAX = {
  'Biz: Diesel': 'vehicle_fuel',
  'Biz: Advertising': 'ads_marketing',
  'Biz: Coffee Shop': 'meals',
  'Biz: Tesla': 'vehicle_maint',
  'Biz: Trailer': 'vehicle_maint',
  'Biz: Bills & Subs': 'office_software',
};

// Everything that counts as business for card / export / tax filters
export const BUSINESS_CATEGORIES = [...TAX_CATEGORIES, ...LEGACY_BIZ_CATEGORIES];

export function isBusinessCategory(cat) {
  if (!cat) return false;
  if (BUSINESS_CATEGORIES.includes(cat)) return true;
  return String(cat).startsWith('Biz:');
}

/** Map any known category (legacy or tax code) → tax code, or null. */
export function normalizeTaxCategory(cat) {
  if (!cat) return null;
  if (LEGACY_TO_TAX[cat]) return LEGACY_TO_TAX[cat];
  if (TAX_CATEGORIES.includes(cat)) return cat;
  return null;
}

// Exported so functions/api/recurring/pay.js and unpay.js can read/write the
// same ledger when marking a bill paid or undoing that.
export async function readLedger(env) {
  const raw = await env.VELOCITY_KV.get(LEDGER_KEY);
  return raw ? JSON.parse(raw) : [];
}

export async function writeLedger(env, entries) {
  await env.VELOCITY_KV.put(LEDGER_KEY, JSON.stringify(entries));
}

function applyOptionalFields(entry, body) {
  if (body.jobId !== undefined) entry.jobId = body.jobId ? String(body.jobId) : null;
  if (body.jobName !== undefined) entry.jobName = body.jobName ? String(body.jobName).trim() : null;
  if (body.clientId !== undefined) entry.clientId = body.clientId ? String(body.clientId) : null;
  if (body.receiptDriveId !== undefined) {
    entry.receiptDriveId = body.receiptDriveId ? String(body.receiptDriveId) : null;
  }
  if (body.taxCategory !== undefined) {
    const tc = body.taxCategory ? String(body.taxCategory) : null;
    entry.taxCategory = tc && (TAX_CATEGORIES.includes(tc) || LEGACY_TO_TAX[tc])
      ? (LEGACY_TO_TAX[tc] || tc)
      : (tc || null);
  }
  if (body.deductible !== undefined) entry.deductible = !!body.deductible;
  if (body.taxYear !== undefined) {
    entry.taxYear = body.taxYear ? String(body.taxYear) : null;
  }
  return entry;
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const year = url.searchParams.get('year') || '';
    const jobId = url.searchParams.get('jobId') || '';
    const clientId = url.searchParams.get('clientId') || '';
    const businessOnly = ['1', 'true', 'yes'].includes(
      (url.searchParams.get('business') || '').toLowerCase(),
    );
    const unassigned = ['1', 'true', 'yes'].includes(
      (url.searchParams.get('unassigned') || '').toLowerCase(),
    );

    let entries = await readLedger(env);

    if (year) {
      entries = entries.filter(e => (e.date || '').startsWith(year) || e.taxYear === year);
    }
    if (jobId) {
      entries = entries.filter(e => e.jobId === jobId);
    }
    if (clientId) {
      entries = entries.filter(e => e.clientId === clientId);
    }
    if (businessOnly) {
      entries = entries.filter(e =>
        e.card === 'business' || isBusinessCategory(e.category) || e.taxCategory,
      );
    }
    if (unassigned) {
      // Business expenses not yet tagged to a job
      entries = entries.filter(e =>
        (e.card === 'business' || isBusinessCategory(e.category) || e.taxCategory) &&
        !e.jobId,
      );
    }

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
    const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : today;
    const category = body.category || 'Everything Else';
    const card = body.card === 'business'
      ? 'business'
      : (body.card === 'personal' ? 'personal' : (isBusinessCategory(category) ? 'business' : 'personal'));

    // Prefer explicit taxCategory; else derive from category (legacy Biz:* or tax code)
    let taxCategory = null;
    if (body.taxCategory) {
      taxCategory = LEGACY_TO_TAX[body.taxCategory] || (TAX_CATEGORIES.includes(body.taxCategory) ? body.taxCategory : null);
    } else {
      taxCategory = normalizeTaxCategory(category);
    }

    const isBiz = card === 'business' || isBusinessCategory(category) || !!taxCategory;

    const entry = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
      date,
      vendor: tidyVendor(body.vendor),
      amount: -Math.abs(parseFloat(body.amount) || 0),
      category,
      person: ['Naomi', 'Bills'].includes(body.person) ? body.person : 'Clancy',
      notes: String(body.notes || body.note || '').trim(),
      photoId: body.photoId || null,
      card,
      // Job costing + tax (optional; null when omitted)
      jobId: body.jobId ? String(body.jobId) : null,
      jobName: body.jobName ? String(body.jobName).trim() : null,
      clientId: body.clientId ? String(body.clientId) : null,
      receiptDriveId: body.receiptDriveId ? String(body.receiptDriveId) : null,
      taxCategory,
      deductible: body.deductible !== undefined ? !!body.deductible : isBiz,
      taxYear: body.taxYear ? String(body.taxYear) : date.slice(0, 4),
      created_at: new Date().toISOString(),
    };

    // Re-read right before writing so a save from the other phone isn't lost
    const entries = await readLedger(env);
    entries.push(entry);
    await writeLedger(env, entries);

    // If they filed it somewhere other than the AI's guess, remember that
    if (body.aiCategory && body.aiCategory !== entry.category) {
      await learnRule(env, entry.vendor, entry.category, isBiz, entry.taxCategory, entry.card);
    }
    if (body.cardLast4) await learnCardLast4(env, body.cardLast4, entry.card);

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
    if (body.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      e.date = body.date;
      if (body.taxYear === undefined && !e.taxYear) e.taxYear = body.date.slice(0, 4);
    }
    if (body.amount !== undefined) e.amount = -Math.abs(parseFloat(body.amount) || 0);
    if (body.card !== undefined) e.card = body.card === 'business' ? 'business' : 'personal';
    if (body.photoId !== undefined) e.photoId = body.photoId || null;

    applyOptionalFields(e, body);

    // If category changed and taxCategory wasn't explicit, re-derive
    if (body.category !== undefined && body.taxCategory === undefined) {
      const derived = normalizeTaxCategory(e.category);
      if (derived) e.taxCategory = derived;
    }
    // Default deductible when flipping to business
    if (body.deductible === undefined && (body.card === 'business' || (body.category && isBusinessCategory(body.category)))) {
      if (e.deductible === undefined) e.deductible = true;
    }

    await writeLedger(env, entries);

    // Recategorizing an existing expense teaches the same lesson
    if (body.category !== undefined || body.taxCategory !== undefined) {
      await learnRule(
        env,
        e.vendor,
        e.category,
        isBusinessCategory(e.category) || !!e.taxCategory || e.card === 'business',
        e.taxCategory,
        e.card,
      );
    }
    if (body.cardLast4) await learnCardLast4(env, body.cardLast4, e.card);

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

    // Keep the receipt image. A deleted expense may still need substantiating,
    // and an orphaned photo costs far less than a missing one at audit time.
    if (gone) {
      const trashRaw = await env.VELOCITY_KV.get('household:deleted');
      const trash = trashRaw ? JSON.parse(trashRaw) : [];
      trash.push({ ...gone, deleted_at: new Date().toISOString() });
      await env.VELOCITY_KV.put('household:deleted', JSON.stringify(trash.slice(-500)));
    }

    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
}
