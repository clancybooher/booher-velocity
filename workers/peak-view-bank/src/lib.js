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

/**
 * Peak View ledger / cashflow / supplier pending use business
 * checking + savings only. Last-four allowlist is the source of truth
 * for the current Velocity Chase enrollment.
 *
 * Include: BUS COMPLETE CHK …7120, CHASE BUS TOTAL SAV …7736
 * Exclude: Clancy and Naomi …3340, Maples Place …7915,
 *          personal Freedom Unlimited …0185
 */
export const PEAK_VIEW_LAST_FOURS = Object.freeze(['7120', '7736']);
export const PERSONAL_LAST_FOURS = Object.freeze(['3340', '7915', '0185']);
export const PERSONAL_ACCOUNT_NAME_RE =
  /freedom\s*unlimited|clancy\s+and\s+naomi|maples\s*place/i;
export const BUSINESS_ACCOUNT_NAME_RE =
  /\bbus(?:iness)?\b|complete\s*chk|total\s*sav/i;

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

export function accountLastFour(account) {
  return String(account?.last_four || '')
    .replace(/\D/g, '')
    .slice(-4);
}

/**
 * Peak View default: business depository only.
 * Allowlisted last fours always win. Personal names / last fours
 * never enter ledger, pending, or cashflow.
 */
export function classifyAccount(account) {
  const last4 = accountLastFour(account);
  const name = String(account?.name || '');
  const subtype = String(account?.subtype || '').toLowerCase();
  const type = String(account?.type || '').toLowerCase();
  const depository =
    type === 'depository' || subtype === 'checking' || subtype === 'savings';

  if (PERSONAL_LAST_FOURS.includes(last4) || PERSONAL_ACCOUNT_NAME_RE.test(name)) {
    return { peak_view: false, reason: 'personal_excluded' };
  }
  if (PEAK_VIEW_LAST_FOURS.includes(last4)) {
    return { peak_view: true, reason: 'allowlist_last_four' };
  }
  if (BUSINESS_ACCOUNT_NAME_RE.test(name) && depository) {
    return { peak_view: true, reason: 'business_depository' };
  }
  return { peak_view: false, reason: 'not_business_depository' };
}

export function isPeakViewAccount(account) {
  return classifyAccount(account).peak_view;
}

export function unwrapTellerTxn(row) {
  if (row == null) return null;
  if (typeof row === 'string') {
    const trimmed = row.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return unwrapTellerTxn(JSON.parse(trimmed));
      } catch {
        return null;
      }
    }
    return null;
  }
  if (typeof row !== 'object' || Array.isArray(row)) return null;
  if (row.transaction && typeof row.transaction === 'object') return row.transaction;
  if (
    row.data &&
    typeof row.data === 'object' &&
    !Array.isArray(row.data) &&
    (row.data.id || row.data.transaction_id || row.data.amount != null)
  ) {
    return row.data;
  }
  return row;
}

export function tellerTxnId(txn) {
  const raw =
    txn?.id ??
    txn?.transaction_id ??
    txn?.teller_transaction_id ??
    txn?.txn_id ??
    txn?.transactionId;
  if (raw != null && String(raw).trim()) return String(raw).trim();
  const self = txn?.links?.self;
  if (typeof self === 'string') {
    const m = self.match(/transactions\/([^/?#]+)/i);
    if (m?.[1]) return m[1];
  }
  return '';
}

/**
 * Teller docs: signed decimal string. Live Chase sometimes sends a
 * number, "$1,234.56", unicode minus, or { amount | value }.
 */
export function parseTellerAmount(txn) {
  const raw =
    txn?.amount ??
    txn?.details?.amount ??
    txn?.value ??
    txn?.amount_value;
  if (raw == null || raw === '') return Number.NaN;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : Number.NaN;
  if (typeof raw === 'object') {
    return parseTellerAmount({
      amount: raw.amount ?? raw.value ?? raw.amount_cents,
    });
  }
  let s = String(raw).trim();
  s = s.replace(/[\s$,]/g, '').replace(/\u2212/g, '-').replace(/^\((.+)\)$/, '-$1');
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Local lookback compares YYYY-MM-DD. Teller docs use that; Chase
 * payloads have also shown timestamps, MM/DD/YYYY, and YYYYMMDD.
 * Unparseable dates stay empty so the lookback keeps the row.
 */
export function parseTellerDate(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  if (typeof value === 'object') {
    const y = value.year ?? value.yyyy;
    const m = value.month ?? value.mm;
    const day = value.day ?? value.dd;
    if (y && m && day) {
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return parseTellerDate(value.date ?? value.value ?? '');
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const mdy = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (mdy) {
    return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  }
  if (/^\d{10,13}$/.test(s)) return parseTellerDate(Number(s));
  const d = new Date(s);
  if (!Number.isNaN(d.getTime()) && /^\d{4}/.test(s)) return d.toISOString().slice(0, 10);
  return '';
}

function dateShape(value) {
  if (value == null || value === '') return 'empty';
  if (typeof value === 'number') return value > 1e12 ? 'unix_ms' : 'unix_s';
  if (typeof value === 'object') return 'object';
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return 'YYYY-MM-DD';
  if (/^\d{8}$/.test(s)) return 'YYYYMMDD';
  if (/^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{4}$/.test(s)) return 'MDY';
  if (/^\d{10,13}$/.test(s)) return 'unix_string';
  return 'other';
}

/**
 * Field names + types only. No vendor, description, counterparty,
 * amount value, or full transaction id.
 */
export function sampleRawShape(row) {
  const rawType = row == null ? 'null' : Array.isArray(row) ? 'array' : typeof row;
  if (rawType !== 'object') {
    return { row_type: rawType, keys: [] };
  }
  const keys = Object.keys(row).slice(0, 24);
  const nested = unwrapTellerTxn(row);
  const amount = nested?.amount ?? row.amount;
  const date = nested?.date ?? row.date;
  const idVal =
    nested?.id ??
    nested?.transaction_id ??
    nested?.teller_transaction_id ??
    row.id ??
    row.transaction_id;
  const idField = nested?.id != null || row.id != null
    ? 'id'
    : nested?.transaction_id != null || row.transaction_id != null
      ? 'transaction_id'
      : nested?.teller_transaction_id != null || row.teller_transaction_id != null
        ? 'teller_transaction_id'
        : nested?.links?.self || row.links?.self
          ? 'links.self'
          : null;
  return {
    row_type: 'object',
    keys,
    nested_keys: nested && nested !== row ? Object.keys(nested).slice(0, 24) : [],
    has_id: Boolean(tellerTxnId(nested || row)),
    id_field: idField,
    id_prefix: typeof idVal === 'string' ? idVal.slice(0, 4) : idVal == null ? null : typeof idVal,
    amount_type: amount == null ? 'null' : Array.isArray(amount) ? 'array' : typeof amount,
    amount_keys: amount && typeof amount === 'object' ? Object.keys(amount).slice(0, 8) : undefined,
    amount_parseable: Number.isFinite(parseTellerAmount(nested || row)),
    date_type: date == null ? 'null' : typeof date,
    date_len: date == null ? 0 : String(date).length,
    date_shape: dateShape(date),
    status: typeof (nested?.status ?? row.status) === 'string' ? (nested?.status ?? row.status) : null,
    type: typeof (nested?.type ?? row.type) === 'string' ? (nested?.type ?? row.type) : null,
    has_details: Boolean(nested?.details || row.details),
    has_description: typeof (nested?.description ?? row.description) === 'string',
  };
}

export function normalizeFailReason(txn) {
  const row = unwrapTellerTxn(txn);
  if (!row) return 'not_object';
  if (!tellerTxnId(row)) return 'missing_id';
  if (!Number.isFinite(parseTellerAmount(row))) return 'bad_amount';
  return null;
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

export function normalizeTxn(txn, account) {
  const row = unwrapTellerTxn(txn);
  if (!row) return null;
  const id = tellerTxnId(row);
  if (!id) return null;
  const amount = parseTellerAmount(row);
  if (!Number.isFinite(amount)) return null;
  const date = parseTellerDate(
    row.date ?? row.booked_on ?? row.transacted_at ?? row.timestamp,
  );
  const vendor = vendorText(row);
  const supplier = matchSupplier(`${vendor} ${row.description || ''}`);
  const classified = account ? classifyAccount(account) : null;
  return {
    id,
    date,
    vendor,
    amount,
    category: supplier ? 'supplier' : 'other',
    type: classifyDirection(row, amount),
    supplier,
    status: typeof row.status === 'string' ? row.status : null,
    account_id: account?.id || row.account_id || null,
    account_name: account?.name || null,
    account_last_four: account ? accountLastFour(account) : accountLastFour({ last_four: row.account_last_four }),
    peak_view: classified ? classified.peak_view : true,
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
    account_last_four: txn.account_last_four || null,
    account_name: txn.account_name || null,
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
