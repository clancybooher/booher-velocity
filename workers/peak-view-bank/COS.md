# Peak View Bank MCP — CoS playbook

Live Worker: `https://peak-view-bank-mcp.clancybooher.workers.dev`  
Auth: `X-Sync-Secret: $SYNC_SECRET` (same secret as `peak-view-teller-sync`).  
Alt: `Authorization: Bearer $SYNC_SECRET`.

Deployed 2026-09-13 (content-only, secrets/mTLS kept):
- Worker version `74b2d923-e09b-4930-9423-372e53f51303`
- Deployment `7a538ed3-dd3f-4ae9-a1ea-5ebd6420be25`
- Bindings unchanged: `PEAK_VIEW_BANK_KV` `e3e93131d54841e1a1ee5e3d1442fc71`, `TELLER_MTLS` `6a100d45-6f1e-4a2c-b83b-bc250af9eccf`, secrets `SYNC_SECRET` + `TELLER_TOKEN`
- Public `/health` now includes `ledger_count` + `seen_ids_count`. Both are `0` until CoS runs the 35-day sync below.

This cloud agent does **not** have `SYNC_SECRET`. CoS does. Do not paste the secret into chat, git, or a PR.

Robinhood rule: outflows to Robinhood are **Robinhood Gold credit card payoffs** (business + personal). Not investments. Not transfers to invest.

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
  "accounts_checked": 0,
  "pulled_count": 0,
  "new_count": 0,
  "queued_count": 0,
  "accounts": [
    {
      "name": "Business Checking",
      "last_four": "1234",
      "type": "depository",
      "subtype": "checking",
      "status": "open",
      "has_transactions_link": true,
      "raw_count": 0,
      "normalized_count": 0,
      "pages": 1,
      "used_start_date": false,
      "sample_error": null
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

`queued` is only supplier **debits ≥ $50**. Amount on queued rows is absolute. `new_transactions` keep the signed Teller amount.

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
# expect pulled_count > 0, accounts[].raw_count populated,
# teller_query.start_date === false, no secrets in the body

curl -sS "$BASE/recent?limit=500" \
  -H "X-Sync-Secret: $SYNC_SECRET"
# expect count > 0

curl -sS "$BASE/health"
# expect ledger_count > 0
```

Teller list no longer sends `start_date`. That query param is what emptied every account on 2026-09-13 (`accounts_checked=5`, `new_count=0`, ledger 404). Velocity's working worker only sends `count` + optional `from_id`. We filter the 35-day window locally.

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
