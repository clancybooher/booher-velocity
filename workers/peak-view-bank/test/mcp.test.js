import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpMessage } from '../src/mcp.js';
import { TOOL_SCHEMAS, bankHealth, bankSync, bankListPending } from '../src/tools.js';
import { persistIngest } from '../src/kv.js';
import { CURSOR_KEY, LEDGER_KEY, PENDING_KEY } from '../src/lib.js';
import { mockEnv } from './helpers.js';
import worker from '../src/index.js';

describe('MCP tool schemas', () => {
  it('exposes the four bank tools', () => {
    assert.deepEqual(
      TOOL_SCHEMAS.map((t) => t.name),
      ['bank_health', 'bank_sync', 'bank_list_pending', 'bank_list_recent'],
    );
  });

  it('lists tools over JSON-RPC', async () => {
    const res = await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      mockEnv(),
    );
    assert.equal(res.result.tools.length, 4);
  });

  it('initialize names Peak View Bank, not Velocity', async () => {
    const res = await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      mockEnv(),
    );
    assert.equal(res.result.serverInfo.name, 'peak-view-bank-mcp');
    assert.match(res.result.instructions, /household Velocity ledger/i);
  });
});

describe('bridge + tools', () => {
  it('bank_health reports Velocity enrollment and isolation', async () => {
    const health = await bankHealth(mockEnv());
    assert.equal(health.ok, true);
    assert.equal(health.enrollment_source, 'velocity-teller-sync');
    assert.equal(health.uses_peak_view_connect, false);
    assert.equal(health.isolation.binds_velocity_kv, false);
    assert.equal(health.isolation.writes_household_ledger, false);
  });

  it('bank_sync queues Home Depot ≥ $50 into Peak View pending only', async () => {
    const env = mockEnv({
      txns: [
        { id: 'txn_hd', date: '2026-09-11', amount: '-210.55', description: 'HOME DEPOT #4012' },
        { id: 'txn_coffee', date: '2026-09-11', amount: '-80.00', description: 'STARBUCKS' },
        { id: 'txn_tiny', date: '2026-09-11', amount: '-9.00', description: "LOWE'S" },
      ],
    });
    const out = await bankSync(env, { days: 7 });
    assert.equal(out.ok, true);
    assert.equal(out.queued_count, 1);
    assert.deepEqual(out.queued[0], {
      teller_transaction_id: 'txn_hd',
      date: '2026-09-11',
      vendor: 'HOME DEPOT #4012',
      amount: 210.55,
      status: 'needs_job',
    });

    const pending = await bankListPending(env);
    assert.equal(pending.items.length, 1);

    const keys = [...env.PEAK_VIEW_BANK_KV.store.keys()].sort();
    assert.deepEqual(keys, [CURSOR_KEY, LEDGER_KEY, PENDING_KEY].sort());
    assert.equal(env.VELOCITY_KV, undefined);
  });

  it('persistIngest refuses household keys', async () => {
    const env = mockEnv();
    const put = env.PEAK_VIEW_BANK_KV.put.bind(env.PEAK_VIEW_BANK_KV);
    env.PEAK_VIEW_BANK_KV.put = async (key, value) => {
      if (key === 'household:ledger') throw new Error('test leaked household write');
      return put(key, value);
    };
    await persistIngest(env, [
      {
        id: 'txn_hd',
        date: '2026-09-11',
        vendor: 'HOME DEPOT',
        amount: -60,
        category: 'supplier',
        type: 'debit',
        supplier: 'Home Depot',
      },
    ]);
    assert.equal(env.PEAK_VIEW_BANK_KV.store.has('household:ledger'), false);
  });
});

describe('HTTP auth', () => {
  it('rejects /mcp without the sync secret', async () => {
    const res = await worker.fetch(
      new Request('https://peak-view-bank-mcp.example/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      mockEnv(),
    );
    assert.equal(res.status, 401);
  });

  it('accepts X-Sync-Secret and returns tools', async () => {
    const res = await worker.fetch(
      new Request('https://peak-view-bank-mcp.example/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Sync-Secret': 'sync-secret',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      mockEnv(),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.tools.length, 4);
  });
});
