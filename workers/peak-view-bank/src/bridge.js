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

async function readJsonArray(res) {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`teller_http_${res.status}`);
  }
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : [];
}

export async function listAccounts(env, token) {
  const res = await tellerFetch(env, '/accounts', token);
  return readJsonArray(res);
}

export async function listTransactions(env, token, accountId, startDate) {
  const qs = new URLSearchParams({ count: '100', start_date: startDate });
  const res = await tellerFetch(env, `/accounts/${accountId}/transactions?${qs}`, token);
  return readJsonArray(res);
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
  for (const account of accounts) {
    const rows = await listTransactions(env, token, account.id, startDate);
    for (const row of rows) {
      const n = normalizeTxn(row);
      if (n) txns.push(n);
    }
  }
  return { accountsChecked: accounts.length, txns, startDate };
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
