import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TELLER_PAGE_COUNT,
  accountDebugStub,
  buildTransactionsPath,
  parseTellerList,
  pullRecent,
  sanitizeTellerError,
} from '../src/bridge.js';
import { bankHealth, bankListRecent, bankSync } from '../src/tools.js';
import { CURSOR_KEY, LEDGER_KEY } from '../src/lib.js';
import { mockEnv } from './helpers.js';

function txn(id, date, amount, description = 'HOME DEPOT') {
  return { id, date, amount, description, type: 'card_payment' };
}

describe('Teller query shape', () => {
  it('never puts start_date on the transactions URL', () => {
    const path = buildTransactionsPath('acc_chase', { count: 250 });
    assert.equal(path.includes('start_date'), false);
    assert.match(path, /count=250/);
    assert.equal(path.includes('from_id'), false);
    const paged = buildTransactionsPath('acc_chase', { count: 250, fromId: 'txn_old' });
    assert.match(paged, /from_id=txn_old/);
    assert.equal(paged.includes('start_date'), false);
  });

  it('pullRecent matches Velocity: count + from_id only, local date filter', async () => {
    const now = new Date();
    const recent = now.toISOString().slice(0, 10);
    const old = new Date(now.getTime() - 80 * 86400000).toISOString().slice(0, 10);
    const env = mockEnv({
      txns: [
        txn('txn_new', recent, '-87.40'),
        txn('txn_old', old, '-210.00'),
      ],
    });
    const out = await pullRecent(env, 35);
    assert.equal(out.teller_query.start_date, false);
    assert.equal(out.teller_query.filter, 'local');
    assert.equal(out.txns.length, 1);
    assert.equal(out.txns[0].id, 'txn_new');
    assert.ok(env._tellerUrls.every((u) => !u.includes('start_date')));
    assert.ok(env._tellerUrls.some((u) => u.includes('/transactions?count=')));
    assert.equal(out.accounts[0].raw_count, 2);
    assert.equal(out.accounts[0].normalized_count, 1);
    assert.equal(out.accounts[0].used_start_date, false);
    assert.equal(out.accounts[0].type, 'depository');
    assert.equal(out.accounts[0].subtype, 'checking');
  });

  it('pulls credit cards and checking in the same sync', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const env = mockEnv({
      accounts: [
        {
          id: 'acc_check',
          name: 'Business Checking',
          status: 'open',
          type: 'depository',
          subtype: 'checking',
          last_four: '1111',
          links: { transactions: 'https://api.teller.io/accounts/acc_check/transactions' },
        },
        {
          id: 'acc_card',
          name: 'Ink Card',
          status: 'open',
          type: 'credit',
          subtype: 'credit_card',
          last_four: '2222',
          links: { transactions: 'https://api.teller.io/accounts/acc_card/transactions' },
        },
      ],
      txnsByAccount: {
        acc_check: [txn('txn_chk', day, '-50.00', 'QXO BEND')],
        acc_card: [txn('txn_card', day, '-12.00', 'STARBUCKS')],
      },
    });
    const out = await pullRecent(env, 14);
    assert.equal(out.accountsChecked, 2);
    assert.equal(out.txns.length, 2);
    assert.deepEqual(
      out.accounts.map((a) => a.type).sort(),
      ['credit', 'depository'],
    );
  });

  it('pages with from_id until the lookback is covered', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const rows = [];
    for (let i = 0; i < TELLER_PAGE_COUNT + 3; i++) {
      rows.push(txn(`txn_${i}`, day, '-1.00', `ROW ${i}`));
    }
    const env = mockEnv({ txns: rows });
    const out = await pullRecent(env, 14);
    assert.equal(out.txns.length, TELLER_PAGE_COUNT + 3);
    assert.equal(out.accounts[0].pages, 2);
    assert.ok(env._tellerUrls.some((u) => u.includes('from_id=')));
  });
});

describe('Teller error objects', () => {
  it('does not treat {error} as an empty success list', () => {
    const parsed = parseTellerList(
      { ok: true, status: 200 },
      JSON.stringify({ error: { code: 'enrollment.product.unavailable', message: 'transactions not enabled' } }),
    );
    assert.deepEqual(parsed.rows, []);
    assert.match(parsed.error, /enrollment\.product\.unavailable/);
  });

  it('surfaces per-account HTTP errors instead of failing the whole sync', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const env = mockEnv({
      accounts: [
        { id: 'acc_ok', name: 'Checking', status: 'open', type: 'depository', subtype: 'checking', last_four: '0001' },
        { id: 'acc_bad', name: 'Closed-ish', status: 'open', type: 'credit', subtype: 'credit_card', last_four: '0002' },
      ],
      txnsByAccount: {
        acc_ok: [txn('txn_ok', day, '-60.00')],
      },
      tellerErrors: {
        acc_bad: { status: 403, body: { error: { code: 'enrollment.disconnected', message: 'disconnected' } } },
      },
    });
    const out = await bankSync(env, { days: 14 });
    assert.equal(out.ok, true);
    assert.equal(out.new_count, 1);
    assert.equal(out.accounts.length, 2);
    const bad = out.accounts.find((a) => a.last_four === '0002');
    assert.match(bad.sample_error, /teller_http_403/);
    assert.equal(bad.raw_count, 0);
  });

  it('redacts token-shaped text in sample errors', () => {
    assert.equal(sanitizeTellerError('bad token=live_abcdefghijk'), 'bad [redacted]');
  });
});

describe('health + recent caps', () => {
  it('reports ledger_count and seen_ids_count', async () => {
    const env = mockEnv();
    env.PEAK_VIEW_BANK_KV.store.set(
      LEDGER_KEY,
      JSON.stringify([{ id: 'txn_1', date: '2026-09-01', vendor: 'QXO', amount: -10, category: 'supplier', type: 'debit' }]),
    );
    env.PEAK_VIEW_BANK_KV.store.set(
      CURSOR_KEY,
      JSON.stringify({ lastSyncAt: '2026-09-13T00:00:00.000Z', seenIds: ['a', 'b', 'c'] }),
    );
    const health = await bankHealth(env);
    assert.equal(health.ledger_count, 1);
    assert.equal(health.seen_ids_count, 3);
  });

  it('returns up to 500 recent rows', async () => {
    const items = Array.from({ length: 120 }, (_, i) => ({
      id: `txn_${i}`,
      date: '2026-09-01',
      vendor: 'QXO',
      amount: -1,
      category: 'supplier',
      type: 'debit',
    }));
    const env = mockEnv();
    env.PEAK_VIEW_BANK_KV.store.set(LEDGER_KEY, JSON.stringify(items));
    const recent = await bankListRecent(env, { limit: 500 });
    assert.equal(recent.count, 120);
  });
});

describe('account debug stub', () => {
  it('never includes tokens', () => {
    const stub = accountDebugStub({
      name: 'Checking',
      last_four: '1234',
      type: 'depository',
      subtype: 'checking',
      status: 'open',
      links: { transactions: 'https://api.teller.io/accounts/acc_x/transactions' },
    });
    assert.equal(JSON.stringify(stub).includes('token'), false);
    assert.equal(stub.used_start_date, false);
  });
});
