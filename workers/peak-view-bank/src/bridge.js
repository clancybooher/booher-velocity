import {
  DEFAULT_LOOKBACK_DAYS,
  clampDays,
  hasMtls,
  isoDateDaysAgo,
  normalizeTxn,
  readVelocityToken,
  tellerAuthHeader,
} from './lib.js';

const TELLER_API = 'https://api.teller.io';

/** Page size for Teller list. Velocity uses 100; we page until the lookback is covered. */
export const TELLER_PAGE_COUNT = 250;
export const TELLER_MAX_PAGES = 8;

export async function tellerFetch(env, path, token) {
  const url = path.startsWith('http') ? path : `${TELLER_API}${path}`;
  const init = {
    method: 'GET',
    headers: {
      Authorization: tellerAuthHeader(token),
      Accept: 'application/json',
    },
  };
  if (!hasMtls(env)) {
    throw new Error('TELLER_MTLS is not bound — use the velocity teller-velocity certificate');
  }
  return env.TELLER_MTLS.fetch(url, init);
}

/**
 * Strip anything that looks like a token from Teller error text.
 * Never put secrets in /sync debug.
 */
export function sanitizeTellerError(message) {
  if (!message) return '';
  return String(message)
    .replace(/(?:access[_-]?token|token|secret|bearer)[=:\s]+[^\s,;]+/gi, '[redacted]')
    .replace(/\b(?:test|live|prod)_[a-z0-9]{8,}\b/gi, '[redacted]')
    .slice(0, 160);
}

/**
 * Teller list endpoints return a JSON array on success.
 * Error payloads are objects: { error: { code, message } }.
 * The old reader treated those objects as [] and hid every account failure.
 */
export function parseTellerList(res, text) {
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    return { rows: [], error: `teller_invalid_json_${res.status}` };
  }

  const code = data?.error?.code;
  const message = sanitizeTellerError(data?.error?.message);

  if (!res.ok) {
    const http = `teller_http_${res.status}`;
    const detail = code || message;
    return { rows: [], error: detail ? `${http}:${detail}` : http };
  }
  if (Array.isArray(data)) return { rows: data, error: null };
  if (data && typeof data === 'object' && data.error) {
    return { rows: [], error: message ? `${code || 'teller_error'}:${message}` : String(code || 'teller_error_object') };
  }
  return { rows: [], error: 'teller_non_array' };
}

/**
 * Build the transactions path.
 *
 * Do NOT send start_date. velocity-teller-sync (working since May 2026) only
 * sends count + optional from_id. Live Peak View /sync with start_date=35 days
 * ago returned accounts_checked=5 and zero rows. Teller either ignores the
 * documented date filter or answers 200 + [] / error object.
 *
 * Filter the lookback locally after the pull.
 */
export function buildTransactionsPath(accountId, { count = TELLER_PAGE_COUNT, fromId } = {}) {
  const qs = new URLSearchParams({ count: String(count) });
  if (fromId) qs.set('from_id', fromId);
  return `/accounts/${encodeURIComponent(accountId)}/transactions?${qs}`;
}

export function accountDebugStub(account) {
  return {
    name: account?.name || null,
    last_four: account?.last_four || null,
    type: account?.type || null,
    subtype: account?.subtype || null,
    status: account?.status || null,
    has_transactions_link: Boolean(account?.links?.transactions),
    raw_count: 0,
    normalized_count: 0,
    pages: 0,
    used_start_date: false,
    sample_error: null,
  };
}

export async function listAccounts(env, token) {
  const res = await tellerFetch(env, '/accounts', token);
  const parsed = parseTellerList(res, await res.text());
  if (parsed.error && parsed.rows.length === 0) {
    throw new Error(parsed.error);
  }
  return parsed.rows;
}

export async function listTransactionPage(env, token, accountId, { count = TELLER_PAGE_COUNT, fromId } = {}) {
  const res = await tellerFetch(env, buildTransactionsPath(accountId, { count, fromId }), token);
  return parseTellerList(res, await res.text());
}

function inLookback(txn, startDate) {
  if (!startDate || !txn.date) return true;
  return String(txn.date).slice(0, 10) >= startDate;
}

/**
 * Pull one account newest-first, paging with from_id until we pass startDate
 * or run out of rows. Checking and credit accounts are both included.
 */
export async function pullAccount(env, token, account, startDate) {
  const debug = accountDebugStub(account);
  if (!account?.id) {
    debug.sample_error = 'missing_account_id';
    return { txns: [], debug };
  }

  const txns = [];
  let fromId;
  let reachedOld = false;

  while (debug.pages < TELLER_MAX_PAGES) {
    const parsed = await listTransactionPage(env, token, account.id, {
      count: TELLER_PAGE_COUNT,
      fromId,
    });
    debug.pages += 1;
    if (parsed.error && !debug.sample_error) debug.sample_error = parsed.error;

    const rows = parsed.rows;
    if (rows.length === 0) break;

    debug.raw_count += rows.length;
    for (const row of rows) {
      const n = normalizeTxn(row);
      if (!n) continue;
      if (!inLookback(n, startDate)) {
        reachedOld = true;
        continue;
      }
      txns.push(n);
    }

    if (rows.length < TELLER_PAGE_COUNT) break;
    if (reachedOld) break;
    fromId = rows[rows.length - 1]?.id;
    if (!fromId) break;
  }

  debug.normalized_count = txns.length;
  return { txns, debug };
}

/**
 * Pull Chase transactions using Velocity's working Teller enrollment.
 * Does not write Velocity KV. Caller persists to PEAK_VIEW_BANK_KV.
 */
export async function pullRecent(env, days = DEFAULT_LOOKBACK_DAYS) {
  const token = readVelocityToken(env);
  if (!token) {
    throw new Error(
      'no_velocity_teller_token: set TELLER_TOKEN from velocity-teller-sync. Do not re-run Chase Connect.',
    );
  }
  const lookback = clampDays(days);
  const startDate = isoDateDaysAgo(lookback);
  const accounts = (await listAccounts(env, token)).filter((a) => a.id && a.status !== 'closed');
  const txns = [];
  const accountDebug = [];
  for (const account of accounts) {
    const pulled = await pullAccount(env, token, account, startDate);
    accountDebug.push(pulled.debug);
    txns.push(...pulled.txns);
  }
  return {
    accountsChecked: accounts.length,
    txns,
    startDate,
    accounts: accountDebug,
    teller_query: {
      count: TELLER_PAGE_COUNT,
      start_date: false,
      filter: 'local',
      from_id: 'page',
    },
  };
}

export function enrollmentHealth(env) {
  return {
    enrollment_source: 'velocity-teller-sync',
    has_velocity_token: Boolean(readVelocityToken(env)),
    has_mtls: hasMtls(env),
    uses_peak_view_connect: false,
    teller_app: 'velocity (working Chase enrollment)',
  };
}
