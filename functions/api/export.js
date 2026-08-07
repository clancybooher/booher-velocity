// GET /api/export?scope=all|business|personal&year=YYYY
//
// Downloads the ledger as CSV for taxes/bookkeeping. Each row carries a direct
// link to the stored receipt photo so a return can be substantiated later.

import {
  isBusinessCategory,
  normalizeTaxCategory,
} from './transactions.js';

const LEDGER_KEY = 'household:ledger';

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const scope = url.searchParams.get('scope') || 'all';
  const year = url.searchParams.get('year') || '';

  const raw = await env.VELOCITY_KV.get(LEDGER_KEY);
  let entries = raw ? JSON.parse(raw) : [];

  if (year) entries = entries.filter(e => (e.date || '').startsWith(year) || e.taxYear === year);
  if (scope === 'business') {
    entries = entries.filter(e =>
      e.card === 'business' || isBusinessCategory(e.category) || e.taxCategory,
    );
  }
  if (scope === 'personal') {
    entries = entries.filter(e =>
      e.card !== 'business' && !isBusinessCategory(e.category) && !e.taxCategory,
    );
  }

  entries.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  const origin = url.origin;
  const header = [
    'Date', 'Vendor', 'Amount', 'Category', 'Tax Category', 'Business', 'Deductible',
    'Job ID', 'Client ID', 'Paid With', 'Person', 'Notes', 'Receipt Photo',
    'Drive Receipt', 'Logged At', 'ID',
  ];
  const rows = entries.map(e => [
    e.date,
    e.vendor,
    Math.abs(e.amount).toFixed(2),
    e.category,
    e.taxCategory || normalizeTaxCategory(e.category) || '',
    (e.card === 'business' || isBusinessCategory(e.category) || e.taxCategory) ? 'YES' : 'no',
    e.deductible === false ? 'no' : (e.deductible || isBusinessCategory(e.category) || e.taxCategory ? 'YES' : 'no'),
    e.jobId || '',
    e.clientId || '',
    e.card === 'business' ? 'business card' : (e.person === 'Bills' ? 'auto bill' : 'personal'),
    e.person,
    e.notes || '',
    e.photoId ? `${origin}/api/photo/${e.photoId}` : '',
    e.receiptDriveId ? `https://drive.google.com/file/d/${e.receiptDriveId}/view` : '',
    e.created_at || '',
    e.id,
  ]);

  const total = entries.reduce((s, e) => s + Math.abs(e.amount), 0);
  rows.push([]);
  rows.push(['', 'TOTAL', total.toFixed(2), '', '', '', '', '', '', '', '', '', '', '', '', '']);

  const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
  const label = `money-is-fun-${scope}${year ? '-' + year : ''}.csv`;

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${label}"`,
    },
  });
}
