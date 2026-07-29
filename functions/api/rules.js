// Learned vendor rules — "Chevron is always Biz: Diesel".
//
// Written automatically whenever a saved expense disagrees with what the AI
// guessed (see transactions.js), and read back into the Gemini prompt so the
// next photo from that vendor is categorized the way you actually file it.
//
// GET    /api/rules            → { ok, rules: { "chevron": { category, business } } }
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

export async function learnRule(env, vendor, category, business) {
  const key = vendorKey(vendor);
  if (!key) return;
  const rules = await readRules(env);
  rules[key] = { category, business: !!business, vendor, updated_at: new Date().toISOString() };

  // Keep the map bounded — drop the stalest entries first
  const keys = Object.keys(rules);
  if (keys.length > MAX_RULES) {
    keys.sort((a, b) => (rules[a].updated_at || '').localeCompare(rules[b].updated_at || ''));
    keys.slice(0, keys.length - MAX_RULES).forEach(k => delete rules[k]);
  }
  await env.VELOCITY_KV.put(KEY, JSON.stringify(rules));
}

export async function onRequestGet({ env }) {
  return new Response(JSON.stringify({ ok: true, rules: await readRules(env) }), { headers: JSON_HEADERS });
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
