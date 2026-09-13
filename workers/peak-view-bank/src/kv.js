import {
  ALLOWED_PEAK_VIEW_KEYS,
  CURSOR_KEY,
  LEDGER_KEY,
  PENDING_KEY,
  assertAllowedPeakViewKey,
  assertNotHouseholdKey,
  mergeLedger,
  mergePending,
  mergeSeen,
} from './lib.js';

export function peakViewKv(env) {
  const kv = env?.PEAK_VIEW_BANK_KV;
  if (!kv) throw new Error('PEAK_VIEW_BANK_KV is not bound');
  return kv;
}

export async function peakPut(env, key, value) {
  assertNotHouseholdKey(key);
  assertAllowedPeakViewKey(key);
  await peakViewKv(env).put(key, value);
}

export async function loadCursor(env) {
  const raw = await peakViewKv(env).get(CURSOR_KEY, 'json');
  if (raw && typeof raw === 'object' && Array.isArray(raw.seenIds)) {
    return raw;
  }
  return { lastSyncAt: null, seenIds: [], enrollment_source: 'velocity-teller-sync' };
}

export async function loadLedger(env) {
  const raw = await peakViewKv(env).get(LEDGER_KEY, 'json');
  return Array.isArray(raw) ? raw : [];
}

export async function loadPending(env) {
  const raw = await peakViewKv(env).get(PENDING_KEY, 'json');
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray(raw.items)) return raw.items;
  return [];
}

export async function persistIngest(env, incoming, now = new Date()) {
  const cursor = await loadCursor(env);
  const seen = new Set(cursor.seenIds);
  const fresh = incoming.filter((t) => !seen.has(t.id));
  if (fresh.length === 0) {
    await peakPut(
      env,
      CURSOR_KEY,
      JSON.stringify({
        lastSyncAt: now.toISOString(),
        seenIds: cursor.seenIds,
        enrollment_source: 'velocity-teller-sync',
      }),
    );
    return { fresh: [], queued: [] };
  }

  const ledger = mergeLedger(await loadLedger(env), fresh);
  const pending = mergePending(await loadPending(env), fresh);
  const queued = pending.filter((p) =>
    fresh.some((t) => t.id === p.teller_transaction_id),
  );
  const nextCursor = {
    lastSyncAt: now.toISOString(),
    seenIds: mergeSeen(
      cursor.seenIds,
      fresh.map((t) => t.id),
    ),
    enrollment_source: 'velocity-teller-sync',
  };

  await Promise.all([
    peakPut(env, CURSOR_KEY, JSON.stringify(nextCursor)),
    peakPut(env, LEDGER_KEY, JSON.stringify(ledger)),
    peakPut(env, PENDING_KEY, JSON.stringify(pending)),
  ]);

  return { fresh, queued };
}

export function isolationReport() {
  return {
    binds_velocity_kv: false,
    writes_household_ledger: false,
    writes_velocity_teller_cursor: false,
    allowed_peak_view_keys: [...ALLOWED_PEAK_VIEW_KEYS],
  };
}
