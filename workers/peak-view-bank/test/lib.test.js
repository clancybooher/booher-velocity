import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_PEAK_VIEW_KEYS,
  FORBIDDEN_VELOCITY_KEYS,
  assertAllowedPeakViewKey,
  assertNotHouseholdKey,
  isForbiddenVelocityKey,
  matchSupplier,
  mergePending,
  normalizeTxn,
  shouldQueueExpense,
  toPending,
} from '../src/lib.js';

describe('supplier matching', () => {
  it('recognizes Peak View suppliers', () => {
    assert.equal(matchSupplier('HOME DEPOT #4012'), 'Home Depot');
    assert.equal(matchSupplier("LOWE'S 1234"), "Lowe's");
    assert.equal(matchSupplier('ALPINE PRODUCTS INC'), 'Alpine');
    assert.equal(matchSupplier('QXO BEND'), 'QXO');
    assert.equal(matchSupplier('STARBUCKS'), undefined);
  });
});

describe('pending expense queue', () => {
  const hd = normalizeTxn({
    id: 'txn_hd',
    date: '2026-09-12',
    amount: '-87.40',
    description: 'HOME DEPOT #4012',
    type: 'card_payment',
  });

  it('queues supplier debits of $50 or more', () => {
    assert.equal(hd.category, 'supplier');
    assert.equal(shouldQueueExpense(hd), true);
    assert.deepEqual(toPending(hd), {
      teller_transaction_id: 'txn_hd',
      date: '2026-09-12',
      vendor: 'HOME DEPOT #4012',
      amount: 87.4,
      status: 'needs_job',
    });
  });

  it('skips small supplier debits and non-suppliers', () => {
    const small = normalizeTxn({
      id: 'txn_small',
      date: '2026-09-12',
      amount: '-12.00',
      description: 'HOME DEPOT',
    });
    const coffee = normalizeTxn({
      id: 'txn_coffee',
      date: '2026-09-12',
      amount: '-80.00',
      description: 'STARBUCKS',
    });
    assert.equal(shouldQueueExpense(small), false);
    assert.equal(shouldQueueExpense(coffee), false);
  });

  it('skips credits even from suppliers', () => {
    const refund = normalizeTxn({
      id: 'txn_ref',
      date: '2026-09-12',
      amount: '120.00',
      description: 'HOME DEPOT',
      type: 'credit',
    });
    assert.equal(shouldQueueExpense(refund), false);
  });

  it('dedupes pending by teller_transaction_id', () => {
    const first = mergePending([], [hd]);
    const again = mergePending(first, [hd]);
    assert.equal(first.length, 1);
    assert.equal(again.length, 1);
  });
});

describe('no household ledger writes', () => {
  it('forbids Velocity household keys', () => {
    for (const key of FORBIDDEN_VELOCITY_KEYS) {
      assert.equal(isForbiddenVelocityKey(key), true);
      assert.throws(() => assertNotHouseholdKey(key), /household/);
    }
    assert.equal(isForbiddenVelocityKey('household:ledger'), true);
    assert.equal(isForbiddenVelocityKey('session:abc'), true);
    assert.equal(isForbiddenVelocityKey('photo:xyz'), true);
    assert.equal(isForbiddenVelocityKey('user:1:ledger'), true);
    assert.equal(isForbiddenVelocityKey('pending_expense_tags'), false);
  });

  it('only allows Peak View bank keys', () => {
    for (const key of ALLOWED_PEAK_VIEW_KEYS) {
      assert.doesNotThrow(() => assertAllowedPeakViewKey(key));
    }
    assert.throws(() => assertAllowedPeakViewKey('household:ledger'));
    assert.throws(() => assertAllowedPeakViewKey('teller_access_token'));
    assert.throws(() => assertAllowedPeakViewKey('ledger'));
  });
});
