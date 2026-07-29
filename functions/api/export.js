// GET /api/export?scope=all|business|personal&year=YYYY
//
// Downloads the ledger as CSV for taxes/bookkeeping. Each row carries a direct
// link to the stored receipt photo so a return can be substantiated later.

const LEDGER_KEY = 'household:ledger';
const BUSINESS_CATEGORIES = [
  'Biz: Diesel', 'Biz: Advertising', 'Biz: Coffee Shop', 'Biz: Tesla',
  'Biz: Trailer', 'Biz: Bills & Subs',
];

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

  if (year) entries = entries.filter(e => (e.date || '').startsWith(year));
  if (scope === 'business') entries = entries.filter(e => BUSINESS_CATEGORIES.includes(e.category));
  if (scope === 'personal') entries = entries.filter(e => !BUSINESS_CATEGORIES.includes(e.category));

  entries.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  const origin = url.origin;
  const header = ['Date', 'Vendor', 'Amount', 'Category', 'Business', 'Paid With', 'Person', 'Notes', 'Receipt Photo', 'Logged At', 'ID'];
  const rows = entries.map(e => [
    e.date,
    e.vendor,
    Math.abs(e.amount).toFixed(2),
    e.category,
    BUSINESS_CATEGORIES.includes(e.category) ? 'YES' : 'no',
    e.card === 'business' ? 'business card' : (e.person === 'Bills' ? 'auto bill' : 'personal'),
    e.person,
    e.notes || '',
    e.photoId ? `${origin}/api/photo/${e.photoId}` : '',
    e.created_at || '',
    e.id,
  ]);

  const total = entries.reduce((s, e) => s + Math.abs(e.amount), 0);
  rows.push([]);
  rows.push(['', 'TOTAL', total.toFixed(2), '', '', '', '', '', '', '', '']);

  const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
  const label = `money-is-fun-${scope}${year ? '-' + year : ''}.csv`;

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${label}"`,
    },
  });
}
