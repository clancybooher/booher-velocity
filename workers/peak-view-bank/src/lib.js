/**
 * Peak View bank helpers.
 *
 * Shared: Velocity Teller enrollment (TELLER_TOKEN + TELLER_MTLS).
 * Isolated: writes land only on PEAK_VIEW_BANK_KV. This module never
 * names household Velocity keys as write targets.
 */

export const SERVICE = 'peak-view-bank-mcp';
export const ENROLLMENT_SOURCE = 'velocity-teller-sync';

export const PENDING_KEY = 'pending_expense_tags';
export const LEDGER_KEY = 'peak_view_bank_ledger';
export const CURSOR_KEY = 'peak_view_sync_cursor';

export const EXPENSE_MIN_ABS = 50;
export const MAX_LEDGER = 500;
export const MAX_SEEN_IDS = 2000;
export const MAX_PENDING = 200;
export const DEFAULT_LOOKBACK_DAYS = 14;

/** Keys this Worker is allowed to write on PEAK_VIEW_BANK_KV. */
export const ALLOWED_PEAK_VIEW_KEYS = Object.freeze([
  PENDING_KEY,
  LEDGER_KEY,
  CURSOR_KEY,
]);

/**
 * booher-velocity-kv keys we must never write. Documented + asserted so
 * a future edit cannot quietly merge Peak View money into the household app.
 */
export const FORBIDDEN_VELOCITY_KEYS = Object.freeze([
  'household:ledger',
  'household:budgets',
  'household:cards',
  'household:goals',
  'household:recurring',
  'household:rules',
  'auth:pin',
  'ledger',
  'teller_cursor',
  'merchant_map',
]);

export const FORBIDDEN_VELOCITY_PREFIXES = Object.freeze([
  'household:',
  'session:',
  'photo:',
  'recurring:',
  'user:',
  'auth:',
]);

export const SUPPLIERS = Object.freeze([
  { re: /home\s*depot|homedepot/i, name: 'Home Depot' },
  { re: /lowe'?s|\blowes\b/i, name: "Lowe's" },
  { re: /alpine/i, name: 'Alpine' },
  { re: /andersen/i, name: 'Andersen' },
  { re: /\bqxo\b/i, name: 'QXO' },
  { re: /milgard/i, name: 'Milgard' },
  { re: /therma[\s-]*tru|\btherma\b/i, name: 'Therma-Tru' },
  { re: /sierra\s*pacific/i, name: 'Sierra Pacific' },
  { re: /\bpella\b/i, name: 'Pella' },
  { re: /jeld[\s-]*wen|\bjeld\b/i, name: 'Jeld-Wen' },
  { re: /\bcodel\b/i, name: 'Codel' },
  { re: /deschutes/i, name: 'Deschutes' },
  { re: /millwork/i, name: 'millwork' },
  { re: /shoots|dwd\s*bend/i, name: 'Shoots / DWD' },
  { re: /\bglass\b/i, name: 'glass' },
]);

export function assertAllowedPeakViewKey(key) {
  if (!ALLOWED_PEAK_VIEW_KEYS.includes(key)) {
    throw new Error(`refusing write to unrecognized Peak View key: ${key}`);
  }
}

export function isForbiddenVelocityKey(key) {
  const name = String(key || '');
  if (FORBIDDEN_VELOCITY_KEYS.includes(name)) return true;
  return FORBIDDEN_VELOCITY_PREFIXES.some((p) => name.startsWith(p));
}

export function assertNotHouseholdKey(key) {
  if (isForbiddenVelocityKey(key)) {
    throw new Error(`refusing household / Velocity ledger write: ${key}`);
  }
}

export function vendorText(txn) {
  const counter = txn.details?.counterparty?.name?.trim();
  const desc = txn.description?.trim();
  return counter || desc || 'Unknown';
}

export function matchSupplier(text) {
  const hay = String(text || '').replace(/\s+/g, ' ');
  for (const s of SUPPLIERS) {
    if (s.re.test(hay)) return s.name;
  }
  return undefined;
}

export function classifyDirection(txn, amount) {
  const cat = (txn.details?.category || '').toLowerCase();
  const typ = (txn.type || '').toLowerCase();
  if (cat === 'income' || typ === 'deposit' || typ === 'credit') return 'credit';
  if (amount < 0) return 'debit';
  if (
    typ === 'card_payment' ||
    typ === 'ach' ||
    typ === 'atm' ||
    typ === 'wire' ||
    typ === 'check' ||
    typ === 'fee'
  ) {
    return 'debit';
  }
  if (amount > 0) return 'credit';
  return 'debit';
}

export function normalizeTxn(txn) {
  if (!txn?.id) return null;
  const amount = Number.parseFloat(String(txn.amount ?? ''));
  if (!Number.isFinite(amount)) return null;
  const vendor = vendorText(txn);
  const supplier = matchSupplier(`${vendor} ${txn.description || ''}`);
  return {
    id: txn.id,
    date: txn.date || '',
    vendor,
    amount,
    category: supplier ? 'supplier' : 'other',
    type: classifyDirection(txn, amount),
    supplier,
  };
}

export function toPublic(txn) {
  return {
    date: txn.date,
    vendor: txn.vendor,
    amount: txn.amount,
    category: txn.category,
    type: txn.type,
    supplier: txn.supplier || null,
  };
}

export function shouldQueueExpense(txn) {
  return (
    txn &&
    txn.amount < 0 &&
    txn.category === 'supplier' &&
    Math.abs(txn.amount) >= EXPENSE_MIN_ABS
  );
}

export function toPending(txn) {
  return {
    teller_transaction_id: txn.id,
    date: txn.date,
    vendor: txn.vendor,
    amount: Math.abs(txn.amount),
    status: 'needs_job',
  };
}

export function mergeSeen(prev, ids) {
  const incoming = new Set(ids);
  return [...ids, ...prev.filter((id) => !incoming.has(id))].slice(0, MAX_SEEN_IDS);
}

export function mergeLedger(prev, incoming) {
  const seen = new Set(incoming.map((t) => t.id));
  return [...incoming, ...prev.filter((t) => !seen.has(t.id))].slice(0, MAX_LEDGER);
}

export function mergePending(prev, incoming) {
  const have = new Set(prev.map((p) => p.teller_transaction_id));
  const add = [];
  for (const t of incoming) {
    if (!shouldQueueExpense(t) || have.has(t.id)) continue;
    add.push(toPending(t));
  }
  return [...add, ...prev].slice(0, MAX_PENDING);
}

export function isoDateDaysAgo(days, now = new Date()) {
  const d = new Date(now.getTime() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

export function clampDays(value, fallback = DEFAULT_LOOKBACK_DAYS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(90, Math.max(1, Math.floor(n)));
}

export function clampLimit(value, fallback, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

export async function sha256(data) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return new Uint8Array(buf);
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i] ^ b[i];
  return x === 0;
}

export async function secretsEqual(given, expected) {
  if (!given || !expected) return false;
  const [ha, hb] = await Promise.all([sha256(given), sha256(expected)]);
  return bytesEqual(ha, hb);
}

export function hasMtls(env) {
  return typeof env?.TELLER_MTLS?.fetch === 'function';
}

export function readVelocityToken(env) {
  const token = env?.TELLER_TOKEN?.trim();
  return token || null;
}

export function tellerAuthHeader(token) {
  return `Basic ${btoa(`${token}:`)}`;
}
