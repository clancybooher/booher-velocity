// Learned vendor rules — "Chevron is always vehicle_fuel".
//
// Written automatically whenever a saved expense disagrees with what the AI
// guessed (see transactions.js), and read back into the Gemini prompt so the
// next photo from that vendor is categorized the way you actually file it.
//
// GET    /api/rules            → { ok, rules: { "chevron": { category, business, taxCategory? } } }
// POST   /api/rules            → set a rule { vendor, category, business?, taxCategory? }
// DELETE /api/rules  { vendor } → forget one rule (or { all: true } to reset)

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const KEY = 'household:rules';
const MAX_RULES = 200;

// Store names arrive inconsistently — "COSTCO WHOLESALE #1021", "Costco.",
// "costco" are all one store. Collapse to a stable key for learning/grouping.
const CHAIN_WORDS = /\b(wholesale|warehouse|supercenter|market|markets|store|stores|inc|llc|co|corp|company|the|of)\b/g;

export function vendorKey(vendor) {
  return String(vendor || '')
    .toLowerCase()
    .replace(/#\s*\d+/g, ' ')          // store numbers
    .replace(/\b\d{3,}\b/g, ' ')       // long digit runs (phone/store ids)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(CHAIN_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

// Prettiest display name we've seen for a store, so history reads cleanly.
export function tidyVendor(vendor) {
  const cleaned = String(vendor || '')
    .replace(/#\s*\d+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,\s]+$/, '')
    .trim();
  if (!cleaned) return 'Unknown';
  // ALL CAPS receipts read badly — title-case them, leave mixed case alone
  if (cleaned === cleaned.toUpperCase()) {
    return cleaned.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
  }
  return cleaned;
}

export async function readRules(env) {
  const raw = await env.VELOCITY_KV.get(KEY);
  return raw ? JSON.parse(raw) : {};
}

export async function learnRule(env, vendor, category, business, taxCategory) {
  const key = vendorKey(vendor);
  if (!key) return;
  const rules = await readRules(env);
  const prev = rules[key] || {};
  rules[key] = {
    category,
    business: !!business,
    vendor,
    taxCategory: taxCategory !== undefined ? (taxCategory || null) : (prev.taxCategory || null),
    updated_at: new Date().toISOString(),
  };

  // Keep the map bounded — drop the stalest entries first
  const keys = Object.keys(rules);
  if (keys.length > MAX_RULES) {
    keys.sort((a, b) => (rules[a].updated_at || '').localeCompare(rules[b].updated_at || ''));
    keys.slice(0, keys.length - MAX_RULES).forEach(k => delete rules[k]);
  }
  await env.VELOCITY_KV.put(KEY, JSON.stringify(rules));
  return rules[key];
}

export async function onRequestGet({ env }) {
  return new Response(JSON.stringify({ ok: true, rules: await readRules(env) }), { headers: JSON_HEADERS });
}

/** Explicit set from MCP / agent — same shape as learnRule. */
export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const vendor = body.vendor;
    const category = body.category;
    if (!vendor || !category) {
      return new Response(
        JSON.stringify({ error: 'vendor and category required' }),
        { status: 400, headers: JSON_HEADERS },
      );
    }
    const business = body.business !== undefined
      ? !!body.business
      : (String(category).startsWith('Biz:') ||
         [
           'materials', 'subcontractors', 'vehicle_fuel', 'vehicle_maint',
           'tools_equipment', 'ads_marketing', 'office_software', 'insurance',
           'permits_fees', 'disposal', 'meals', 'travel', 'rent_storage',
           'professional', 'training', 'misc_business',
         ].includes(category));
    const rule = await learnRule(env, vendor, category, business, body.taxCategory);
    const rules = await readRules(env);
    return new Response(JSON.stringify({ ok: true, rule, rules }), { headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
}

export async function onRequestDelete({ request, env }) {
  try {
    const { vendor, all } = await request.json();
    if (all) {
      await env.VELOCITY_KV.put(KEY, JSON.stringify({}));
      return new Response(JSON.stringify({ ok: true, rules: {} }), { headers: JSON_HEADERS });
    }
    const rules = await readRules(env);
    delete rules[vendorKey(vendor)];
    await env.VELOCITY_KV.put(KEY, JSON.stringify(rules));
    return new Response(JSON.stringify({ ok: true, rules }), { headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
}
