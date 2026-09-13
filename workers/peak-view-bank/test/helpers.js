export function memoryKv(initial = {}) {
  const store = new Map(
    Object.entries(initial).map(([k, v]) => [
      k,
      typeof v === 'string' ? v : JSON.stringify(v),
    ]),
  );
  return {
    store,
    async get(key, type) {
      const raw = store.get(key);
      if (raw == null) return null;
      if (type === 'json') return JSON.parse(raw);
      return raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

export function mockEnv(overrides = {}) {
  const kv = overrides.PEAK_VIEW_BANK_KV || memoryKv();
  const accounts = overrides.accounts || [
    {
      id: 'acc_chase',
      name: 'Checking',
      status: 'open',
      type: 'depository',
      subtype: 'checking',
      last_four: '1234',
      links: { transactions: 'https://api.teller.io/accounts/acc_chase/transactions' },
    },
  ];
  const txns = overrides.txns || [];
  const txnsByAccount = overrides.txnsByAccount || null;
  const tellerErrors = overrides.tellerErrors || {};
  const requested = [];

  const fetchImpl = async (url) => {
    const href = String(url);
    requested.push(href);
    if (href.endsWith('/accounts') || href.endsWith('/accounts/')) {
      const body = overrides.accountsResponse ?? accounts;
      const status = overrides.accountsStatus ?? 200;
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }
    if (href.includes('/transactions')) {
      const parsed = new URL(href);
      const parts = parsed.pathname.split('/').filter(Boolean);
      const accountId = decodeURIComponent(parts[1] || '');
      if (tellerErrors[accountId]) {
        const e = tellerErrors[accountId];
        return new Response(typeof e.body === 'string' ? e.body : JSON.stringify(e.body ?? { error: { code: 'error' } }), {
          status: e.status || 200,
        });
      }
      const rows = txnsByAccount?.[accountId] ?? txns;
      const fromId = parsed.searchParams.get('from_id');
      const count = Number(parsed.searchParams.get('count') || 100);
      let slice = rows;
      if (fromId) {
        const idx = rows.findIndex((t) => t.id === fromId);
        slice = idx >= 0 ? rows.slice(idx + 1) : [];
      }
      return new Response(JSON.stringify(slice.slice(0, count)), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };

  return {
    PEAK_VIEW_BANK_KV: kv,
    TELLER_TOKEN: overrides.TELLER_TOKEN === undefined ? 'velocity-token' : overrides.TELLER_TOKEN,
    SYNC_SECRET: overrides.SYNC_SECRET === undefined ? 'sync-secret' : overrides.SYNC_SECRET,
    TELLER_MTLS: overrides.TELLER_MTLS === undefined ? { fetch: fetchImpl } : overrides.TELLER_MTLS,
    _tellerUrls: requested,
    ...overrides,
    PEAK_VIEW_BANK_KV: kv,
  };
}
