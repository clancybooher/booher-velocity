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
    { id: 'acc_chase', name: 'Checking', status: 'open' },
  ];
  const txns = overrides.txns || [];
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/accounts')) {
      return new Response(JSON.stringify(accounts), { status: 200 });
    }
    if (String(url).includes('/transactions')) {
      return new Response(JSON.stringify(txns), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  return {
    PEAK_VIEW_BANK_KV: kv,
    TELLER_TOKEN: overrides.TELLER_TOKEN === undefined ? 'velocity-token' : overrides.TELLER_TOKEN,
    SYNC_SECRET: overrides.SYNC_SECRET === undefined ? 'sync-secret' : overrides.SYNC_SECRET,
    TELLER_MTLS: overrides.TELLER_MTLS === undefined ? { fetch: fetchImpl } : overrides.TELLER_MTLS,
    ...overrides,
    PEAK_VIEW_BANK_KV: kv,
  };
}
