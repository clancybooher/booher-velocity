#!/usr/bin/env node
/**
 * One-month Peak View Chase cashflow for CoS.
 *
 * Needs SYNC_SECRET in the environment (same value as peak-view-teller-sync).
 * Never prints the secret.
 *
 *   export SYNC_SECRET='...'
 *   node scripts/cashflow-month.mjs
 *   node scripts/cashflow-month.mjs --dry-run
 *   node scripts/cashflow-month.mjs --fixture path/to/recent.json
 */

import { readFile } from 'node:fs/promises';
import {
  BANK_BASE,
  SYNC_LOOKBACK_DAYS,
  DEFAULT_WINDOW_DAYS,
  formatEmailBody,
  formatPlainSummary,
  formatUsd,
  mergeTxns,
  placeholderSummary,
  summarize,
  watchDecision,
  formatWatchPing,
} from './lib/cashflow.js';

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || !process.argv[i + 1]) return fallback;
  return process.argv[i + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.new_transactions)) return payload.new_transactions;
  if (Array.isArray(payload?.queued)) {
    return payload.queued.map((q) => ({
      date: q.date,
      vendor: q.vendor,
      amount: -Math.abs(Number(q.amount) || 0),
      type: 'debit',
      category: 'supplier',
    }));
  }
  return [];
}

async function bankFetch(path, { method = 'GET', body, secret } = {}) {
  const headers = { 'X-Sync-Secret': secret };
  const opts = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BANK_BASE}${path}`, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, error: 'non_json', raw: text.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${path}: ${json.error || res.statusText}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function printUsage() {
  console.log(`Peak View Chase cashflow (CoS)

Usage:
  export SYNC_SECRET='<same as peak-view-teller-sync>'
  node scripts/cashflow-month.mjs
  node scripts/cashflow-month.mjs --dry-run
  node scripts/cashflow-month.mjs --fixture fixtures/month.json

Flags:
  --days N          Sync lookback (default ${SYNC_LOOKBACK_DAYS}, max 90)
  --window N        Summary window in days (default ${DEFAULT_WINDOW_DAYS})
  --limit N         GET /recent limit (default 500)
  --dry-run         Print the template with $0 placeholders. No network.
  --fixture FILE    Build the summary from a saved JSON file. No secret needed.
  --json            Also print machine JSON after the email.

Auth:
  Header X-Sync-Secret. Do not put the secret on the command line.
  CoS already has this in env. This script will not print it.

Robinhood:
  Outflows matching Robinhood are Gold card payoffs, not investments.
`);
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    printUsage();
    return;
  }

  const days = Number(argValue('--days', SYNC_LOOKBACK_DAYS));
  const windowDays = Number(argValue('--window', DEFAULT_WINDOW_DAYS));
  const limit = Number(argValue('--limit', 500));
  const dryRun = hasFlag('--dry-run');
  const fixture = argValue('--fixture', '');
  const asJson = hasFlag('--json');

  if (dryRun) {
    const summary = placeholderSummary({ windowDays });
    console.log('# CoS fill step');
    console.log('This cloud agent does not have SYNC_SECRET. Run with the secret to replace $0.00:');
    console.log('');
    console.log(`  export SYNC_SECRET='<peak-view-teller-sync SYNC_SECRET>'`);
    console.log('  cd workers/peak-view-bank');
    console.log(`  node scripts/cashflow-month.mjs --days ${days} --window ${windowDays}`);
    console.log('');
    console.log('--- plain summary ---');
    console.log(formatPlainSummary(summary, { pendingCount: 'PENDING_COUNT' }));
    console.log('');
    console.log('--- email body (subject: Last month Chase - in and out) ---');
    console.log(formatEmailBody(summary, { pendingCount: 'PENDING_COUNT', filled: false }));
    return;
  }

  let sync = null;
  let recent = { items: [] };
  let pending = { count: 0, items: [] };
  let source = 'live';

  if (fixture) {
    source = `fixture:${fixture}`;
    const payload = await readJsonFile(fixture);
    recent = { items: asList(payload.recent || payload) };
    pending = payload.pending || { count: (payload.pending_items || []).length, items: payload.pending_items || [] };
    sync = payload.sync || { new_transactions: asList(payload.new_transactions), queued: payload.queued || [] };
  } else {
    const secret = process.env.SYNC_SECRET?.trim();
    if (!secret) {
      console.error('Missing SYNC_SECRET.');
      console.error('CoS: export the same SYNC_SECRET used for peak-view-teller-sync, then rerun.');
      console.error('Or: node scripts/cashflow-month.mjs --dry-run');
      process.exitCode = 2;
      return;
    }
    sync = await bankFetch('/sync', { method: 'POST', body: { days }, secret });
    recent = await bankFetch(`/recent?limit=${encodeURIComponent(String(limit))}`, { secret });
    pending = await bankFetch('/pending', { secret });
  }

  const txns = mergeTxns(asList(sync?.new_transactions), asList(recent));
  const summary = summarize(txns, { windowDays });
  const newSuppliers = (sync?.queued || []).map((q) => ({
    date: q.date,
    vendor: q.vendor,
    amount: -Math.abs(Number(q.amount) || 0),
    type: 'debit',
    category: 'supplier',
  }));
  const extra = {
    pendingCount: pending.count ?? pending.items?.length ?? 0,
    newSuppliers,
    filled: source !== 'dry',
  };

  console.log(`# source ${source}  sync_days=${days}  recent_count=${recent.count ?? recent.items?.length ?? 0}`);
  console.log('');
  console.log('--- plain summary ---');
  console.log(formatPlainSummary(summary, extra));
  console.log('');
  console.log('--- email body (subject: Last month Chase - in and out) ---');
  console.log(formatEmailBody(summary, extra));
  console.log('');
  const decision = watchDecision({
    pendingCount: extra.pendingCount,
    newSuppliers,
  });
  console.log('--- watch ---');
  console.log(formatWatchPing(decision));

  if (asJson) {
    console.log('');
    console.log('--- json ---');
    console.log(
      JSON.stringify(
        {
          window: { start: summary.startDate, end: summary.endDate },
          totals: summary.totals,
          net: summary.net,
          net_formatted: formatUsd(summary.net),
          pending_needs_job: extra.pendingCount,
          watch: decision,
          robinhood_rule: 'Gold card payoffs, not investments',
        },
        null,
        2,
      ),
    );
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
