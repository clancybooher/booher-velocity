/**
 * Peak View Chase cashflow buckets.
 *
 * Robinhood outflows are Robinhood Gold credit card payoffs
 * (business + personal). Not investments. Not transfers to invest.
 */

import { matchSupplier } from '../../src/lib.js';

export const BANK_BASE = 'https://peak-view-bank-mcp.clancybooher.workers.dev';
export const EXPENSE_PING_MIN = 50;
export const DEFAULT_WINDOW_DAYS = 30;
export const SYNC_LOOKBACK_DAYS = 35;

const ROBINHOOD_RE =
  /robin\s*hood|\brh[\s-]*gold\b|gold[\s-]*card[\s-]*pay|payment\s+to\s+robin/i;

const OWNER_DRAW_RE =
  /owner'?s?\s*draw|owner\s*dist|draw\s+to\s+owner|zelle[^a-z0-9]{0,20}clancy|clancy[^a-z0-9]{0,20}zelle|clancy\s*booher|transfer\s+to\s+(personal|booher|clancy)|booher\s+personal/i;

export function haystack(txn) {
  return [txn.vendor, txn.supplier, txn.description, txn.counterparty]
    .filter(Boolean)
    .join(' ');
}

export function signedAmount(txn) {
  const n = Number(txn.amount);
  if (!Number.isFinite(n)) return 0;
  if (txn.type === 'debit' && n > 0) return -n;
  if (txn.type === 'credit' && n < 0) return Math.abs(n);
  return n;
}

export function isCredit(txn) {
  return signedAmount(txn) > 0;
}

export function absAmount(txn) {
  return Math.abs(signedAmount(txn));
}

export function isRobinhoodGold(txn) {
  return ROBINHOOD_RE.test(haystack(txn));
}

export function isOwnerDraw(txn) {
  return OWNER_DRAW_RE.test(haystack(txn));
}

export function supplierName(txn) {
  if (txn.supplier) return txn.supplier;
  return matchSupplier(haystack(txn));
}

/**
 * Bucket a normalized or public Peak View row.
 * Debit priority: robinhood_gold, owner_draw, supplier, other_out.
 * Credit priority: robinhood_gold, supplier (refund), income.
 */
export function bucketTxn(txn) {
  const credit = isCredit(txn);
  if (isRobinhoodGold(txn)) {
    return credit ? 'robinhood_gold_in' : 'robinhood_gold';
  }
  if (!credit && isOwnerDraw(txn)) return 'owner_draw';
  const supplier = supplierName(txn);
  if (supplier) return credit ? 'supplier_refund' : 'supplier';
  return credit ? 'income' : 'other_out';
}

export function txnKey(txn) {
  return [txn.date || '', txn.vendor || '', signedAmount(txn).toFixed(2), txn.type || ''].join('|');
}

export function mergeTxns(...lists) {
  const out = new Map();
  for (const list of lists) {
    for (const txn of list || []) {
      if (!txn || txn.date == null) continue;
      out.set(txnKey(txn), txn);
    }
  }
  return [...out.values()];
}

export function isoDateDaysAgo(days, now = new Date()) {
  const d = new Date(now.getTime() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

export function inWindow(txn, startDate, endDate) {
  const day = String(txn.date || '').slice(0, 10);
  if (!day) return false;
  if (startDate && day < startDate) return false;
  if (endDate && day > endDate) return false;
  return true;
}

export function cents(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function emptyTotals() {
  return {
    in: 0,
    out: 0,
    income: 0,
    supplier: 0,
    supplier_refund: 0,
    robinhood_gold: 0,
    robinhood_gold_in: 0,
    owner_draw: 0,
    other_out: 0,
  };
}

export function summarize(txns, opts = {}) {
  const now = opts.now || new Date();
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const endDate = opts.endDate || now.toISOString().slice(0, 10);
  const startDate = opts.startDate || isoDateDaysAgo(windowDays - 1, new Date(`${endDate}T12:00:00Z`));
  const rows = (txns || []).filter((t) => inWindow(t, startDate, endDate));
  const totals = emptyTotals();
  const buckets = {
    income: [],
    supplier: [],
    supplier_refund: [],
    robinhood_gold: [],
    robinhood_gold_in: [],
    owner_draw: [],
    other_out: [],
  };

  for (const txn of rows) {
    const bucket = bucketTxn(txn);
    const abs = absAmount(txn);
    if (isCredit(txn)) totals.in = cents(totals.in + abs);
    else totals.out = cents(totals.out + abs);
    if (totals[bucket] != null) totals[bucket] = cents(totals[bucket] + abs);
    if (buckets[bucket]) buckets[bucket].push(txn);
  }

  const review = buckets.other_out
    .filter((t) => absAmount(t) >= (opts.reviewMin ?? 200))
    .sort((a, b) => absAmount(b) - absAmount(a));

  return {
    startDate,
    endDate,
    count: rows.length,
    totals,
    buckets,
    review,
    net: cents(totals.in - totals.out),
  };
}

export function formatUsd(n) {
  const value = Number(n) || 0;
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function lineItem(txn) {
  return `${txn.date}  ${txn.vendor || 'Unknown'}  ${formatUsd(absAmount(txn))}`;
}

export function formatPlainSummary(summary, extra = {}) {
  const t = summary.totals;
  const pending = extra.pendingCount ?? 'PENDING_COUNT';
  const lines = [
    `Peak View Chase, ${summary.startDate} through ${summary.endDate}`,
    '',
    `Money in:  ${formatUsd(t.in)}`,
    `Money out: ${formatUsd(t.out)}`,
    `Net:       ${formatUsd(summary.net)}`,
    '',
    'Buckets (outflows unless noted)',
    `  Suppliers (HD / QXO / glass / millwork / the usual): ${formatUsd(t.supplier)}`,
    `  Supplier refunds (in): ${formatUsd(t.supplier_refund)}`,
    `  Robinhood Gold card payoffs (business + personal, not investing): ${formatUsd(t.robinhood_gold)}`,
    `  Owner draws: ${formatUsd(t.owner_draw)}`,
    `  Income (deposits / credits that are not refunds): ${formatUsd(t.income)}`,
    `  Other out: ${formatUsd(t.other_out)}`,
    '',
    `Pending supplier tags (needs_job): ${pending}`,
  ];

  if (extra.newSuppliers?.length) {
    lines.push('New supplier hits of $50 or more:');
    for (const row of extra.newSuppliers) lines.push(`  ${lineItem(row)}`);
  }

  if (summary.review.length) {
    lines.push('');
    lines.push('Other out ≥ $200 (CoS: recode if a draw / card / supplier):');
    for (const row of summary.review) lines.push(`  ${lineItem(row)}`);
  }

  if (t.robinhood_gold > 0) {
    lines.push('');
    lines.push('Robinhood lines are Gold card payoffs. Do not call them investments.');
  }

  return lines.join('\n');
}

/**
 * Short Bend-voice email. No em dashes. No "just". No filler.
 */
export function formatEmailBody(summary, extra = {}) {
  const t = summary.totals;
  const pending = extra.pendingCount ?? 'PENDING_COUNT';
  const filled = extra.filled === true;
  const header = filled
    ? `Last 30 days on Peak View Chase (${summary.startDate} to ${summary.endDate}).`
    : `Last 30 days on Peak View Chase (${summary.startDate} to ${summary.endDate}). CoS: fill the dollar figures from cashflow-month.mjs before I send this.`;

  const lines = [
    header,
    '',
    `Money in: ${formatUsd(t.in)}`,
    `Money out: ${formatUsd(t.out)}`,
    `Net: ${formatUsd(summary.net)}`,
    '',
    'How the out split:',
    `- Suppliers (Home Depot, QXO, glass, millwork, the usual): ${formatUsd(t.supplier)}`,
    `- Robinhood Gold card payoffs (business + personal). This is paying the Gold cards, not investing: ${formatUsd(t.robinhood_gold)}`,
    `- Owner draws: ${formatUsd(t.owner_draw)}`,
    `- Other: ${formatUsd(t.other_out)}`,
    '',
    `Income (job / customer deposits, not refunds): ${formatUsd(t.income)}`,
    `Supplier refunds: ${formatUsd(t.supplier_refund)}`,
    '',
    `Supplier hits waiting on a Jobber job tag: ${pending}`,
  ];

  if (extra.newSuppliers?.length) {
    lines.push('New supplier of $50 or more:');
    for (const row of extra.newSuppliers) lines.push(`- ${lineItem(row)}`);
  }

  if (summary.review.length) {
    lines.push('');
    lines.push('Other out ≥ $200. Check these before we recode:');
    for (const row of summary.review) lines.push(`- ${lineItem(row)}`);
  }

  lines.push('');
  lines.push(
    'Source: peak-view-bank-mcp, Velocity Chase enrollment. Writes stay in PEAK_VIEW_BANK_KV.',
  );
  return lines.join('\n');
}

export function placeholderSummary(opts = {}) {
  const now = opts.now || new Date();
  const endDate = opts.endDate || now.toISOString().slice(0, 10);
  const startDate = opts.startDate || isoDateDaysAgo((opts.windowDays ?? DEFAULT_WINDOW_DAYS) - 1, new Date(`${endDate}T12:00:00Z`));
  return {
    startDate,
    endDate,
    count: 0,
    totals: emptyTotals(),
    buckets: {
      income: [],
      supplier: [],
      supplier_refund: [],
      robinhood_gold: [],
      robinhood_gold_in: [],
      owner_draw: [],
      other_out: [],
    },
    review: [],
    net: 0,
    placeholder: true,
  };
}

export function watchDecision({ pendingCount = 0, newSuppliers = [] }) {
  const hits = (newSuppliers || []).filter((t) => absAmount(t) >= EXPENSE_PING_MIN);
  const ping = pendingCount > 0 || hits.length > 0;
  return {
    ping,
    pendingCount,
    newSuppliers: hits,
    reason: ping
      ? pendingCount > 0 && hits.length
        ? 'pending_needs_job and new supplier ≥ $50'
        : pendingCount > 0
          ? 'pending_needs_job > 0'
          : 'new supplier ≥ $50'
      : 'quiet',
  };
}

export function formatWatchPing(decision) {
  if (!decision.ping) {
    return 'WATCH: quiet. Nothing for Clancy.';
  }
  const lines = [
    'WATCH: ping Clancy once.',
    `Reason: ${decision.reason}`,
    `pending_needs_job: ${decision.pendingCount}`,
  ];
  if (decision.newSuppliers.length) {
    lines.push('New supplier ≥ $50:');
    for (const row of decision.newSuppliers) lines.push(`  ${lineItem(row)}`);
  }
  lines.push('Robinhood outflows stay classified as Gold card payoffs, not investing.');
  return lines.join('\n');
}

export function weekdayName(date = new Date(), timeZone = 'America/Los_Angeles') {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(date);
}

export function isWeekdayBend(date = new Date()) {
  const name = weekdayName(date);
  return name !== 'Saturday' && name !== 'Sunday';
}
