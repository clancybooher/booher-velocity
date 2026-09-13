#!/usr/bin/env node
/**
 * Weekday-morning Peak View bank watch (1–2 day test).
 *
 * Quiet if nothing. One ping if pending_needs_job > 0 or a new supplier ≥ $50.
 *
 *   export SYNC_SECRET='...'
 *   node scripts/watch-morning.mjs
 *   node scripts/watch-morning.mjs --days 2
 *   node scripts/watch-morning.mjs --force   # run on a weekend
 */

import {
  BANK_BASE,
  EXPENSE_PING_MIN,
  formatWatchPing,
  isWeekdayBend,
  watchDecision,
  weekdayName,
} from './lib/cashflow.js';

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || !process.argv[i + 1]) return fallback;
  return process.argv[i + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

async function bankFetch(path, { method = 'GET', body, secret } = {}) {
  const headers = { 'X-Sync-Secret': secret };
  const opts = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BANK_BASE}${path}`, opts);
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${path}: ${json.error || res.statusText}`);
  }
  return json;
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(`Weekday morning bank watch

  export SYNC_SECRET='<same as peak-view-teller-sync>'
  node scripts/watch-morning.mjs            # first morning: --days 35
  node scripts/watch-morning.mjs --days 2   # second morning

Exit 0 = quiet. Exit 3 = ping Clancy once. Exit 2 = missing secret.
Weekend runs no-op unless --force.
`);
    return;
  }

  if (!isWeekdayBend() && !hasFlag('--force')) {
    console.log(`WATCH: weekend in Bend (${weekdayName()}). Skip. Use --force to run anyway.`);
    return;
  }

  const secret = process.env.SYNC_SECRET?.trim();
  if (!secret) {
    console.error('Missing SYNC_SECRET. CoS already has this in env. Do not put it on the command line.');
    process.exitCode = 2;
    return;
  }

  const days = Number(argValue('--days', 35));
  const sync = await bankFetch('/sync', { method: 'POST', body: { days }, secret });
  const pending = await bankFetch('/pending', { secret });
  const newSuppliers = (sync.queued || []).map((q) => ({
    date: q.date,
    vendor: q.vendor,
    amount: -Math.abs(Number(q.amount) || 0),
    type: 'debit',
    category: 'supplier',
  }));
  const decision = watchDecision({
    pendingCount: pending.count ?? 0,
    newSuppliers,
  });

  console.log(formatWatchPing(decision));
  console.log(`Ping floor: supplier debit ≥ $${EXPENSE_PING_MIN}. Robinhood = Gold card payoff.`);
  if (decision.ping) process.exitCode = 3;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
