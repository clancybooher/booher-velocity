# Peak View Bank MCP

A **separate section from Velocity**. Four bank tools for Peak View CoS / the expense-tagger. No household budget UI, no personal P&L, no Teller Connect.

Worker name: `peak-view-bank-mcp`  
MCP: `POST /mcp`  
Schemas: [`mcp-tools.json`](./mcp-tools.json)

## Shared vs isolated

| Shared (read Chase) | Isolated (Peak View ops) |
|---|---|
| Working **Velocity** Teller enrollment already on `velocity-teller-sync` | `PEAK_VIEW_BANK_KV` only |
| Secret `TELLER_TOKEN` (same value as Velocity — do not print it) | Pending expenses `{ teller_transaction_id, date, vendor, amount, status: "needs_job" }` |
| mTLS cert **teller-velocity** (`6a100d45-6f1e-4a2c-b83b-bc250af9eccf`) | Peak View bank ledger + sync cursor (`peak_view_bank_ledger`, `peak_view_sync_cursor`) |
| Teller `GET /accounts` + `GET /accounts/:id/transactions` | Auth secret `SYNC_SECRET` for CoS / MCP |

This Worker **does not bind `VELOCITY_KV`**. It cannot write `household:ledger` or any other Money-is-Fun key.

Do **not** use Peak View’s brand-new Teller app (`app_q175` / `peak-view-teller` cert). Chase Connect on that app returns “unable to process”. Clancy does **not** need to link Chase again.

```
velocity-teller-sync          peak-view-bank-mcp
TELLER_TOKEN + mTLS    -->    Teller API (read)
                              --> PEAK_VIEW_BANK_KV
                                  pending_expense_tags
                                  peak_view_bank_ledger
                                  peak_view_sync_cursor

booher-velocity (Pages)       untouched
VELOCITY_KV household:*       never written
```

Existing Worker `peak-view-teller-sync` can keep serving `/health` / webhooks. CoS should prefer **this** MCP for sync + pending. Both can share `PEAK_VIEW_BANK_KV`; this Worker uses Peak View–prefixed ledger/cursor keys so it does not collide with Connect experiments.

## How CoS uses it

1. Deploy (below) and set `TELLER_TOKEN` + `SYNC_SECRET`.
2. Point the expense-tagger / Peak View CoS at:
   - MCP: `https://peak-view-bank-mcp.clancybooher.workers.dev/mcp`
   - or REST: `POST /sync`, `GET /pending`, `GET /recent`
3. Header: `X-Sync-Secret: <SYNC_SECRET>` (or `Authorization: Bearer <SYNC_SECRET>`).
4. Daily loop: `bank_sync` → `bank_list_pending` → tag each `needs_job` row onto a Jobber job (that tagging is CoS / expense-tagger, not this Worker).

CoS curls, a 30-day in/out template, the weekday-morning watch, and the Chase email draft live in [`COS.md`](./COS.md). Run `node scripts/cashflow-month.mjs` with `SYNC_SECRET` to fill dollar figures. Robinhood outflows are **Gold card payoffs**, not investments.

`GET /health` is public and returns booleans plus `ledger_count` / `seen_ids_count` (no tokens).

Teller pulls match `velocity-teller-sync`: `count` + `from_id` only. Do **not** send `start_date`. Lookback is applied after a resilient `normalizeTxn` (id aliases, amount shapes, date shapes; pending kept). Authorized `/sync` includes per-account `raw_count`, `normalized_count` (pre-filter), `kept_count` (post-filter), `drop_reasons`, and `sample_raw` when rows arrived but none normalized (field names + types only).

Peak View ledger / pending / cashflow use **business checking + savings only**: BUS COMPLETE CHK `7120` and CHASE BUS TOTAL SAV `7736`. Personal Clancy and Naomi `3340`, Maples Place `7915`, and Freedom Unlimited `0185` are listed on `/sync` with `peak_view: false` and are not ingested.

### Tools

| Tool | What it does |
|---|---|
| `bank_health` | Enrollment source, mTLS/token flags, pending count, isolation report |
| `bank_sync` | Pull business Chase via Velocity token; queue supplier debits ≥ $50 |
| `bank_list_pending` | Pending Peak View expenses (`status` default `needs_job`) |
| `bank_list_recent` | Last-sync Peak View rows (optional `supplier_only`) |

Supplier match list matches the existing Peak View teller-sync Worker (Home Depot, Lowe’s, Alpine, Andersen, QXO, Milgard, Therma-Tru, Sierra Pacific, Pella, Jeld-Wen, Codel, Deschutes, millwork, Shoots/DWD, glass).

## No household ledger writes — checklist

- [x] No `VELOCITY_KV` binding in `wrangler.toml`
- [x] No writes to `household:ledger`, `household:budgets`, `household:cards`, `household:goals`, `household:recurring`, `household:rules`
- [x] No writes to Velocity `ledger`, `teller_cursor`, `merchant_map`, `session:*`, `photo:*`, `auth:*`, `user:*`
- [x] Allowed Peak View keys only: `pending_expense_tags`, `peak_view_bank_ledger`, `peak_view_sync_cursor`
- [x] No `/connect` or `/enroll` (no second Teller Connect)
- [x] Does not call `velocity-teller-sync` HTTP (that Worker writes Velocity KV)
- [x] Household Pages app (`index.html`, `/api/transactions`) unchanged

## Deploy steps (CoS — wrangler secrets)

From `workers/peak-view-bank/`. Do this in a local terminal so tokens never land in chat or a PR.

```bash
# 1. Copy the working Velocity Chase token — same secret already on
#    velocity-teller-sync. Do not create a new Teller enrollment.
npx wrangler secret put TELLER_TOKEN

# 2. MCP / REST gate. Reuse peak-view-teller-sync SYNC_SECRET if CoS
#    already has that header, or mint a new one and give it only to CoS.
npx wrangler secret put SYNC_SECRET

# 3. Deploy. mTLS cert + PEAK_VIEW_BANK_KV are in wrangler.toml.
npx wrangler deploy
```

Smoke (no secrets in the output you paste anywhere):

```bash
curl -sS https://peak-view-bank-mcp.clancybooher.workers.dev/health
# expect enrollment_source=velocity-teller-sync, has_velocity_token=true

curl -sS -X POST https://peak-view-bank-mcp.clancybooher.workers.dev/mcp \
  -H "content-type: application/json" \
  -H "X-Sync-Secret: $SYNC_SECRET" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Optional: deploy this same folder as `peak-view-teller-sync` (`npx wrangler deploy --name peak-view-teller-sync`) if CoS already calls that URL. That **replaces** the broken Connect pages. Prefer the `peak-view-bank-mcp` name so Velocity and Peak View stay obviously separate.

## Local tests

```bash
cd workers/peak-view-bank && node --test
node scripts/cashflow-month.mjs --dry-run
node scripts/cashflow-month.mjs --fixture test/fixtures/month.json
```

No live Teller calls in `node --test`; Chase responses are mocked. The cashflow script talks to the live Worker only when `SYNC_SECRET` is set.
