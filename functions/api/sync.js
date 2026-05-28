// POST /api/sync  — pull new transactions from Teller via mTLS, store in KV
// Returns summary of new transactions

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

function autoCategory(vendor) {
  const v = vendor.toLowerCase();
  if (/costco|safeway|kroger|trader.?joe|whole.?foods|walmart|winco|albertson|fred.?meyer|aldi|sprouts/i.test(v)) return 'Groceries';
  if (/starbucks|mcdonald|chipotle|panda|subway|domino|pizza|sushi|restaurant|cafe|coffee|doordash|grubhub|ubereats|diner|bistro|burger|taco|wendy|jack.in/i.test(v)) return 'Dining Out & Coffee';
  if (/comcast|xfinity|pacific.*power|pg&e|electric|gas.*co|water.*district|internet|att|verizon|spotify|netflix|hulu|disney.?plus|apple.*bill|microsoft/i.test(v)) return 'Utilities & Bills';
  if (/shell|chevron|arco|76 gas|exxon|mobil|costco.*gas|uber(?!eats)|lyft|parking|dmv|auto.*parts|o'reilly|advance.*auto/i.test(v)) return 'Transportation & Gas';
  if (/amazon|apple.*store|google.*play|steam|netflix|hulu|ticketmaster|eventbrite|movie|theater|cinema|game|amc|regal/i.test(v)) return 'Entertainment & Date Nights';
  if (/home.?depot|lowes|ace.*hardware|ikea|wayfair|menards|floor.*decor|plumbing|lumber/i.test(v)) return 'Home & Maintenance';
  if (/cvs|walgreen|rite.?aid|pharmacy|clinic|doctor|dental|vision|gym|planet.*fitness|24.?hour/i.test(v)) return 'Health & Personal Care';
  if (/hotel|motel|airbnb|expedia|booking|delta|southwest|alaska.*air|united.*air|american.*air|flight|airline|hyatt|marriott/i.test(v)) return 'Travel & Vacations';
  if (/venmo|paypal|transfer|fidelity|vanguard|schwab|robinhood|coinbase|savings/i.test(v)) return 'Savings & Investments';
  return 'Miscellaneous';
}

function makeId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

export async function onRequestPost(context) {
  const { env } = context;

  if (!env.VELOCITY_KV) {
    return new Response(JSON.stringify({ error: 'VELOCITY_KV not bound' }), { status: 503, headers: CORS });
  }
  if (!env.TELLER_TOKEN) {
    return new Response(JSON.stringify({ error: 'TELLER_TOKEN not configured' }), { status: 503, headers: CORS });
  }
  if (!env.TELLER_MTLS) {
    return new Response(JSON.stringify({ error: 'TELLER_MTLS cert not bound — check Pages bindings' }), { status: 503, headers: CORS });
  }

  try {
    const auth = 'Basic ' + btoa(env.TELLER_TOKEN + ':');

    // Fetch all accounts
    const acctRes = await env.TELLER_MTLS.fetch('https://api.teller.io/accounts', {
      headers: { Authorization: auth, Accept: 'application/json' },
    });
    if (!acctRes.ok) {
      const txt = await acctRes.text();
      return new Response(JSON.stringify({ error: `Teller accounts error ${acctRes.status}`, detail: txt }), { status: 502, headers: CORS });
    }
    const accounts = await acctRes.json();

    // Load existing ledger and cursor
    const [ledgerRaw, cursorRaw, merchantMapRaw] = await Promise.all([
      env.VELOCITY_KV.get('ledger'),
      env.VELOCITY_KV.get('teller_cursor'),
      env.VELOCITY_KV.get('merchant_map'),
    ]);
    const entries     = ledgerRaw     ? JSON.parse(ledgerRaw)     : [];
    const cursor      = cursorRaw     ? JSON.parse(cursorRaw)     : {};
    const merchantMap = merchantMapRaw ? JSON.parse(merchantMapRaw) : {};

    const existingTellerIds = new Set(entries.map(e => e.teller_transaction_id).filter(Boolean));
    const newEntries = [];

    for (const acct of accounts) {
      const params = new URLSearchParams({ count: '100' });
      if (cursor[acct.id]) params.set('from_id', cursor[acct.id]);

      const txnRes = await env.TELLER_MTLS.fetch(
        `https://api.teller.io/accounts/${acct.id}/transactions?${params}`,
        { headers: { Authorization: auth, Accept: 'application/json' } }
      );
      if (!txnRes.ok) continue; // Skip unavailable accounts

      const txns = await txnRes.json();
      if (!Array.isArray(txns)) continue;

      let latestId = cursor[acct.id];
      for (const txn of txns) {
        // Skip already-imported
        if (existingTellerIds.has(txn.id)) continue;

        const amount = parseFloat(txn.amount);
        // In Teller, negative = debit/expense. Skip credits/deposits.
        if (amount >= 0) continue;

        const vendor = txn.details?.counterparty?.name || txn.description || 'Unknown';
        const vKey   = vendor.toLowerCase().replace(/[^a-z0-9]/g, '');
        const category = merchantMap[vKey] || autoCategory(vendor);

        newEntries.push({
          id:                    makeId(),
          type:                  'bank',
          date:                  txn.date,
          vendor,
          amount,  // keep negative (debit)
          category,
          notes:                 txn.details?.category || '',
          teller_transaction_id: txn.id,
          teller_account_id:     acct.id,
          teller_account_name:   acct.name || acct.type,
          created_at:            new Date().toISOString(),
        });

        if (!latestId || txn.id > latestId) latestId = txn.id;
      }
      if (latestId) cursor[acct.id] = latestId;
    }

    // Save everything back to KV
    if (newEntries.length > 0) {
      const updated = [...entries, ...newEntries];
      await Promise.all([
        env.VELOCITY_KV.put('ledger', JSON.stringify(updated)),
        env.VELOCITY_KV.put('teller_cursor', JSON.stringify(cursor)),
      ]);
    } else {
      await env.VELOCITY_KV.put('teller_cursor', JSON.stringify(cursor));
    }

    return new Response(JSON.stringify({
      ok: true,
      new_count: newEntries.length,
      accounts_checked: accounts.length,
      new_transactions: newEntries.map(e => ({
        date: e.date, vendor: e.vendor,
        amount: Math.abs(e.amount).toFixed(2),
        category: e.category,
      })),
    }), { headers: CORS });

  } catch (err) {
    console.error('Sync error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}
