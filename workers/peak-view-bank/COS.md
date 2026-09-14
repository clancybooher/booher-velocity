# Peak View Bank MCP — CoS playbook

Live Worker: `https://peak-view-bank-mcp.clancybooher.workers.dev`  
Auth: `X-Sync-Secret: $SYNC_SECRET` (same secret as `peak-view-teller-sync`).  
Alt: `Authorization: Bearer $SYNC_SECRET`.

Deployed 2026-09-13 (content-only, secrets/mTLS kept):
- Worker version `PENDING_AFTER_DEPLOY`
- Deployment `PENDING_AFTER_DEPLOY`
- Bindings unchanged: `PEAK_VIEW_BANK_KV` `e3e93131d54841e1a1ee5e3d1442fc71`, `TELLER_MTLS` `6a100d45-6f1e-4a2c-b83b-bc250af9eccf`, secrets `SYNC_SECRET` + `TELLER_TOKEN`
- Public `/health` includes `ledger_count` + `seen_ids_count`.

This cloud agent does **not** have `SYNC_SECRET`. CoS does. Do not paste the secret into chat, git, or a PR.

### Account filter (Peak View ledger / cashflow / pending)

Default is **business checking + savings only**. Personal Chase stays on the Velocity enrollment for household use.

| Include | last four | Why |
|---|---|---|
| BUS COMPLETE CHK | 7120 | Peak View business checking |
| CHASE BUS TOTAL SAV | 7736 | Peak View business savings |

| Exclude | last four | Why |
|---|---|---|
| Clancy and Naomi | 3340 | personal joint |
| Maples Place | 7915 | personal |
| Freedom Unlimited | 0185 | personal credit card |

Allowlist last fours win. Name match (`BUS` / `COMPLETE CHK` / `TOTAL SAV`) + depository type can add a future business account. Personal names / last fours never enter supplier pending or cashflow.

Robinhood rule: outflows to Robinhood are **Robinhood Gold credit card payoffs**. Not investments. Not transfers to invest. On Peak View this is whatever posts on the business accounts (still a card payoff).

Writes stay on `PEAK_VIEW_BANK_KV` only. Household Velocity ledger is untouched.

`GET /health` is public. It returns booleans, `last_sync_at`, `pending_needs_job`, `ledger_count`, and `seen_ids_count`. No tokens.

---

## 1. Curl shapes

```bash
BASE=https://peak-view-bank-mcp.clancybooher.workers.dev

# Public. Safe to paste.
curl -sS "$BASE/health"

# Pull Chase via the working Velocity enrollment. 35 days covers a month plus slack.
# Body days is 1–90. Worker default is 14 if you omit it.
curl -sS -X POST "$BASE/sync" \
  -H "content-type: application/json" \
  -H "X-Sync-Secret: $SYNC_SECRET" \
  -d '{"days":35}'

# Last-sync ledger rows. Cap is 500.
curl -sS "$BASE/recent?limit=500" \
  -H "X-Sync-Secret: $SYNC_SECRET"

# Supplier-only recent
curl -sS "$BASE/recent?limit=500&supplier_only=1" \
  -H "X-Sync-Secret: $SYNC_SECRET"

# Pending job tags. Default status=needs_job. Optional: ?status=needs_job&limit=50
curl -sS "$BASE/pending" \
  -H "X-Sync-Secret: $SYNC_SECRET"
```

Unauthenticated `/sync`, `/recent`, `/pending` return `401 {"ok":false,"error":"unauthorized"}`.

### Expected shapes (no live dollars here)

**POST /sync `{"days":35}`**

```json
{
  "ok": true,
  "enrollment_source": "velocity-teller-sync",
  "start_date": "YYYY-MM-DD",
  "accounts_checked": 5,
  "peak_view_accounts": 2,
  "pulled_count": 0,
  "new_count": 0,
  "queued_count": 0,
  "account_filter": {
    "mode": "business_depository",
    "allowlist_last_fours": ["7120", "7736"],
    "exclude_last_fours": ["3340", "7915", "0185"]
  },
  "accounts": [
    {
      "name": "BUS COMPLETE CHK",
      "last_four": "7120",
      "type": "depository",
      "subtype": "checking",
      "status": "open",
      "has_transactions_link": true,
      "raw_count": 0,
      "normalized_count": 0,
      "kept_count": 0,
      "pages": 1,
      "used_start_date": false,
      "sample_error": null,
      "sample_raw": null,
      "peak_view": true,
      "drop_reasons": { "missing_id": 0, "bad_amount": 0, "not_object": 0, "date_filter": 0 }
    }
  ],
  "teller_query": { "count": 250, "start_date": false, "filter": "local", "from_id": "page" },
  "queued": [
    {
      "teller_transaction_id": "txn_…",
      "date": "YYYY-MM-DD",
      "vendor": "HOME DEPOT #4012",
      "amount": 87.4,
      "status": "needs_job"
    }
  ],
  "new_transactions": [
    {
      "date": "YYYY-MM-DD",
      "vendor": "…",
      "amount": -87.4,
      "category": "supplier",
      "type": "debit",
      "supplier": "Home Depot"
    }
  ]
}
```

`queued` is only supplier **debits ≥ $50** on Peak View business accounts. Amount on queued rows is absolute. `new_transactions` keep the signed Teller amount.

`normalized_count` is successful `normalizeTxn` rows **before** the local 35-day filter. `kept_count` is after the date filter (what can land on the ledger). If `raw_count > 0` and `normalized_count === 0`, `sample_raw` is one sanitized shape: field names + amount/date types only. No vendor, description, dollars, or full ids.

**GET /recent**

```json
{
  "ok": true,
  "count": 0,
  "items": [
    {
      "date": "YYYY-MM-DD",
      "vendor": "…",
      "amount": -87.4,
      "category": "supplier",
      "type": "debit",
      "supplier": "Home Depot",
      "queued": true
    }
  ]
}
```

**GET /pending**

```json
{
  "ok": true,
  "status": "needs_job",
  "count": 0,
  "items": [
    {
      "teller_transaction_id": "txn_…",
      "date": "YYYY-MM-DD",
      "vendor": "…",
      "amount": 87.4,
      "status": "needs_job"
    }
  ]
}
```

MCP equivalents (same secret):

```bash
# tools/call bank_sync
curl -sS -X POST "$BASE/mcp" \
  -H "content-type: application/json" \
  -H "X-Sync-Secret: $SYNC_SECRET" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bank_sync","arguments":{"days":35}}}'

# bank_list_recent  /  bank_list_pending
curl -sS -X POST "$BASE/mcp" \
  -H "content-type: application/json" \
  -H "X-Sync-Secret: $SYNC_SECRET" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"bank_list_recent","arguments":{"limit":500}}}'
```

---

## 2. Last ~30 days in vs out

CoS fill (this is the step this agent cannot do):

```bash
export SYNC_SECRET='<peak-view-teller-sync SYNC_SECRET>'
cd workers/peak-view-bank
node scripts/cashflow-month.mjs --days 35 --window 30
```

The script `POST`s `/sync` with `{"days":35}`, then `GET /recent` and `GET /pending`, merges rows, and prints:

1. A plain-English summary
2. An email body ready to send
3. A watch decision

Dry run (placeholders, no secret):

```bash
node scripts/cashflow-month.mjs --dry-run
```

### Totals

| Figure | Meaning |
|---|---|
| Money in | All credits / deposits |
| Money out | All debits |
| Net | in minus out |

### Buckets

| Bucket | Rule |
|---|---|
| Suppliers | Home Depot, Lowe’s, Alpine, Andersen, QXO, Milgard, Therma-Tru, Sierra Pacific, Pella, Jeld-Wen, Codel, Deschutes, millwork, Shoots/DWD, glass |
| Robinhood Gold payoffs | Vendor/description matches Robinhood / RH Gold. **Card payoff. Not investing.** |
| Owner draws | Owner draw, Zelle/transfer to Clancy or Booher personal |
| Income | Credits that are not supplier refunds and not Robinhood |
| Other out | Remaining debits. Script lists Other ≥ $200 for recode |

Supplier refunds are credits and sit in their own line. They count in Money in, not Income.

### Template (replace $0.00 after the fill step)

```
Peak View Chase, START through END

Money in:  TOTAL_IN
Money out: TOTAL_OUT
Net:       NET

Buckets (outflows unless noted)
  Suppliers (HD / QXO / glass / millwork / the usual): SUPPLIERS
  Supplier refunds (in): SUPPLIER_REFUNDS
  Robinhood Gold card payoffs (business + personal, not investing): ROBINHOOD
  Owner draws: OWNER_DRAWS
  Income (deposits / credits that are not refunds): INCOME
  Other out: OTHER_OUT

Pending supplier tags (needs_job): PENDING_COUNT
```

---

## 3. Two-day weekday-morning watch (CoS prompt)

Copy this into the CoS morning loop. Bend time. Weekdays only.

```
Peak View bank watch. 1–2 weekday mornings. Quiet if nothing.

Auth: X-Sync-Secret = SYNC_SECRET (same as peak-view-teller-sync).
Base: https://peak-view-bank-mcp.clancybooher.workers.dev
Writes: PEAK_VIEW_BANK_KV only. Do not touch Velocity household ledger.

Morning 1 (weekday):
  POST /sync  body {"days":35}
  GET /pending
  GET /recent?limit=500
  Run: node workers/peak-view-bank/scripts/cashflow-month.mjs
  Fill the Chase in/out email if Clancy still needs last-month numbers.

Morning 2 (next weekday):
  POST /sync  body {"days":2}
  GET /pending

Ping Clancy once, and only once that morning, if either is true:
  - pending.count > 0  (pending_needs_job)
  - /sync queued a new supplier debit ≥ $50
One message. Vendor, amount, date. Then stop.

Stay quiet if neither is true. Do not send "all clear". Do not ping twice.

Robinhood outflows = Robinhood Gold credit card payoffs (business + personal).
Never describe those as investments or transfers to invest.

If SYNC_SECRET is missing, stop. Do not guess. Do not log the secret.
```

Script form of the same rule:

```bash
# Morning 1
node scripts/watch-morning.mjs --days 35
# Morning 2
node scripts/watch-morning.mjs --days 2
```

Exit `0` = quiet. Exit `3` = ping once. Weekend no-ops unless `--force`.

Public hint without the secret: `GET /health` → `pending_needs_job`, `ledger_count`, `seen_ids_count`.

### After a Worker deploy (CoS — this agent has no SYNC_SECRET)

```bash
BASE=https://peak-view-bank-mcp.clancybooher.workers.dev
curl -sS "$BASE/health"
# expect ledger_count and seen_ids_count fields

curl -sS -X POST "$BASE/sync" \
  -H "content-type: application/json" \
  -H "X-Sync-Secret: $SYNC_SECRET" \
  -d '{"days":35}'
# expect teller_query.start_date === false
# expect accounts with last_four 7120 and 7736: peak_view true, raw_count > 0
# expect personal 3340 / 7915 / 0185: peak_view false, skip_reason=personal_excluded
# expect pulled_count > 0 and ledger rows only from 7120 / 7736
# if a peak_view account still has normalized_count===0 && raw_count>0,
# read accounts[].sample_raw (keys + types only) and drop_reasons

curl -sS "$BASE/recent?limit=500" \
  -H "X-Sync-Secret: $SYNC_SECRET"
# expect count > 0, account_last_four in 7120|7736 only

curl -sS "$BASE/health"
# expect ledger_count > 0
```

Teller list still does **not** send `start_date`. Velocity's working worker only sends `count` + optional `from_id`. We filter the lookback locally after `normalizeTxn`.

2026-09-13 live evidence after the start_date fix: Teller returned rows (`raw_count` 250/250/250/250/23) but `normalized_count` was 0 on every account. Two bugs stacked:

1. `normalizeTxn` required `txn.id` + `Number.parseFloat(String(txn.amount))` and treated the raw Teller date as already `YYYY-MM-DD`. Velocity's worker reads `t.id` / `t.amount` / `t.date` the same way, but live Chase payloads also show `transaction_id`, dollar/`(87.40)` amounts, and `MM/DD/YYYY` or timestamps. Those failed normalize **or** the local date compare (`"09/13/2026" < "2026-08-09"`), and `normalized_count` was counted *after* the date filter so both looked like a normalize wipe.
2. Peak View was ingesting every open account, including personal Clancy and Naomi / Maples Place / Freedom Unlimited. Ledger and cashflow are now business 7120 + 7736 only.

---

## 4. Email Clancy sends himself

To: `clancybooher@gmail.com` or `clancy@peakvieworegon.com`  
Subject: `Last month Chase - in and out`

CoS: run `cashflow-month.mjs` with `SYNC_SECRET`, then replace every `$0.00` / `PENDING_COUNT` before this goes out.

```
Last 30 days on Peak View Chase (START to END). CoS: fill the dollar figures from cashflow-month.mjs before I send this.

Money in: TOTAL_IN
Money out: TOTAL_OUT
Net: NET

How the out split:
- Suppliers (Home Depot, QXO, glass, millwork, the usual): SUPPLIERS
- Robinhood Gold card payoffs (business + personal). This is paying the Gold cards, not investing: ROBINHOOD
- Owner draws: OWNER_DRAWS
- Other: OTHER_OUT

Income (job / customer deposits, not refunds): INCOME
Supplier refunds: SUPPLIER_REFUNDS

Supplier hits waiting on a Jobber job tag: PENDING_COUNT

Source: peak-view-bank-mcp, Velocity Chase enrollment. Writes stay in PEAK_VIEW_BANK_KV.
```

Do not deploy from this playbook. Do not commit secrets.
