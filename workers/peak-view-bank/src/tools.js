import {
  DEFAULT_LOOKBACK_DAYS,
  ENROLLMENT_SOURCE,
  PEAK_VIEW_LAST_FOURS,
  PERSONAL_LAST_FOURS,
  SERVICE,
  clampDays,
  clampLimit,
  shouldQueueExpense,
  toPublic,
} from './lib.js';
import { enrollmentHealth, pullRecent } from './bridge.js';
import { isolationReport, loadCursor, loadLedger, loadPending, persistIngest } from './kv.js';

export const TOOL_SCHEMAS = [
  {
    name: 'bank_health',
    description:
      'Peak View bank enrollment + KV health (ledger_count, seen_ids_count). Uses Velocity Teller Chase enrollment. Does not read or write the household ledger.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'bank_sync',
    description:
      'Pull recent Chase transactions via the working Velocity Teller token and queue Peak View supplier debits ≥ $50 as pending expenses (status needs_job). Writes PEAK_VIEW_BANK_KV only.',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Lookback window in days (1–90). Default 14.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bank_list_pending',
    description:
      'List Peak View pending supplier expenses waiting for a job tag. Shape: { teller_transaction_id, date, vendor, amount, status }.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status. Default needs_job.',
        },
        limit: {
          type: 'number',
          description: 'Max rows to return (1–200). Default 50.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bank_list_recent',
    description:
      'List recent Peak View-normalized Chase transactions from the last sync (Peak View KV, not the household ledger).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max rows to return (1–500). Default 25. Use 500 for a month cashflow.',
        },
        supplier_only: {
          type: 'boolean',
          description: 'If true, only supplier-matched rows.',
        },
      },
      additionalProperties: false,
    },
  },
];

export async function bankHealth(env) {
  const cursor = env?.PEAK_VIEW_BANK_KV ? await loadCursor(env) : { lastSyncAt: null, seenIds: [] };
  const pending = env?.PEAK_VIEW_BANK_KV ? await loadPending(env) : [];
  const ledger = env?.PEAK_VIEW_BANK_KV ? await loadLedger(env) : [];
  return {
    ok: true,
    service: SERVICE,
    ...enrollmentHealth(env),
    has_sync_secret: Boolean(env?.SYNC_SECRET),
    last_sync_at: cursor.lastSyncAt,
    pending_needs_job: pending.filter((p) => p.status === 'needs_job').length,
    ledger_count: ledger.length,
    seen_ids_count: Array.isArray(cursor.seenIds) ? cursor.seenIds.length : 0,
    account_filter: {
      mode: 'business_depository',
      allowlist_last_fours: [...PEAK_VIEW_LAST_FOURS],
      exclude_last_fours: [...PERSONAL_LAST_FOURS],
    },
    isolation: isolationReport(),
  };
}

export async function bankSync(env, args = {}) {
  const days = clampDays(args.days, DEFAULT_LOOKBACK_DAYS);
  const { accountsChecked, peakViewAccounts, txns, startDate, accounts, teller_query, account_filter } =
    await pullRecent(env, days);
  const { fresh, queued } = await persistIngest(env, txns);
  return {
    ok: true,
    enrollment_source: ENROLLMENT_SOURCE,
    start_date: startDate,
    accounts_checked: accountsChecked,
    peak_view_accounts: peakViewAccounts,
    pulled_count: txns.length,
    new_count: fresh.length,
    queued_count: queued.length,
    queued,
    new_transactions: fresh.map(toPublic),
    accounts,
    account_filter,
    teller_query,
    isolation: isolationReport(),
  };
}

export async function bankListPending(env, args = {}) {
  const status = typeof args.status === 'string' && args.status ? args.status : 'needs_job';
  const limit = clampLimit(args.limit, 50, 200);
  const all = await loadPending(env);
  const items = all.filter((p) => p.status === status).slice(0, limit);
  return {
    ok: true,
    status,
    count: items.length,
    items,
  };
}

export async function bankListRecent(env, args = {}) {
  const limit = clampLimit(args.limit, 25, 500);
  const supplierOnly = Boolean(args.supplier_only);
  let items = await loadLedger(env);
  if (supplierOnly) items = items.filter((t) => t.category === 'supplier');
  items = items.slice(0, limit);
  return {
    ok: true,
    count: items.length,
    items: items.map((t) => ({
      ...toPublic(t),
      queued: shouldQueueExpense(t),
    })),
  };
}

export const TOOL_HANDLERS = {
  bank_health: bankHealth,
  bank_sync: bankSync,
  bank_list_pending: bankListPending,
  bank_list_recent: bankListRecent,
};

export async function runTool(name, env, args = {}) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    const err = new Error(`unknown_tool: ${name}`);
    err.code = 'unknown_tool';
    throw err;
  }
  return handler(env, args || {});
}
