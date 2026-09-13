import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bucketTxn,
  formatEmailBody,
  formatPlainSummary,
  formatUsd,
  isOwnerDraw,
  isRobinhoodGold,
  mergeTxns,
  summarize,
  watchDecision,
} from '../scripts/lib/cashflow.js';
import worker from '../src/index.js';
import { mockEnv } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('cashflow buckets', () => {
  it('calls Robinhood a Gold card payoff, not investing', () => {
    const txn = { date: '2026-09-02', vendor: 'ROBINHOOD GOLD', amount: -850, type: 'debit' };
    assert.equal(isRobinhoodGold(txn), true);
    assert.equal(bucketTxn(txn), 'robinhood_gold');
  });

  it('treats owner transfers to Clancy as draws', () => {
    const txn = {
      date: '2026-09-05',
      vendor: 'ONLINE TRANSFER TO CLANCY BOOHER',
      amount: -2000,
      type: 'debit',
    };
    assert.equal(isOwnerDraw(txn), true);
    assert.equal(bucketTxn(txn), 'owner_draw');
  });

  it('keeps Home Depot on the supplier bucket', () => {
    assert.equal(
      bucketTxn({
        date: '2026-08-22',
        vendor: 'HOME DEPOT #4012',
        amount: -312.18,
        type: 'debit',
        supplier: 'Home Depot',
      }),
      'supplier',
    );
  });

  it('counts job deposits as income and supplier credits as refunds', () => {
    assert.equal(
      bucketTxn({ vendor: 'ACME WINDOWS LLC', amount: 4200, type: 'credit' }),
      'income',
    );
    assert.equal(
      bucketTxn({ vendor: 'HOME DEPOT #4012', amount: 45, type: 'credit', supplier: 'Home Depot' }),
      'supplier_refund',
    );
  });
});

describe('month summary + email', () => {
  it('totals the fixture month and writes Bend-voice email', async () => {
    const fixture = JSON.parse(await readFile(join(here, 'fixtures/month.json'), 'utf8'));
    const summary = summarize(mergeTxns(fixture.recent.items), {
      startDate: '2026-08-15',
      endDate: '2026-09-13',
    });
    assert.equal(summary.totals.in, 4245);
    assert.equal(summary.totals.out, 5298.13);
    assert.equal(summary.totals.supplier, 2440.68);
    assert.equal(summary.totals.robinhood_gold, 850);
    assert.equal(summary.totals.owner_draw, 2000);
    assert.equal(summary.totals.income, 4200);
    assert.equal(summary.totals.other_out, 7.45);

    const email = formatEmailBody(summary, { pendingCount: 2, filled: true });
    assert.match(email, /Robinhood Gold card payoffs/);
    assert.match(email, /not investing/);
    assert.doesNotMatch(email, /—/);
    assert.doesNotMatch(email, /\bjust\b/i);
    assert.doesNotMatch(email, /investments?/i);

    const plain = formatPlainSummary(summary, { pendingCount: 2 });
    assert.match(plain, /Money in:\s+\$4,245\.00/);
    assert.match(plain, /Robinhood Gold card payoffs/);
  });

  it('formats money the way the email needs', () => {
    assert.equal(formatUsd(1488.5), '$1,488.50');
    assert.equal(formatUsd(-12), '-$12.00');
  });
});

describe('watch decision', () => {
  it('stays quiet when the queue is empty', () => {
    const d = watchDecision({ pendingCount: 0, newSuppliers: [] });
    assert.equal(d.ping, false);
    assert.equal(d.reason, 'quiet');
  });

  it('pings once for pending or a new supplier ≥ $50', () => {
    const pending = watchDecision({ pendingCount: 1, newSuppliers: [] });
    assert.equal(pending.ping, true);
    const supplier = watchDecision({
      pendingCount: 0,
      newSuppliers: [{ vendor: 'QXO BEND', amount: -1488.5, type: 'debit' }],
    });
    assert.equal(supplier.ping, true);
    const small = watchDecision({
      pendingCount: 0,
      newSuppliers: [{ vendor: "LOWE'S", amount: -12, type: 'debit' }],
    });
    assert.equal(small.ping, false);
  });
});

describe('GET /recent month limit', () => {
  it('accepts limit=500 on the Worker', async () => {
    const env = mockEnv();
    const res = await worker.fetch(
      new Request('https://peak-view-bank-mcp.example/recent?limit=500', {
        headers: { 'X-Sync-Secret': 'sync-secret' },
      }),
      env,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });
});
