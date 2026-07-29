# Money is Fun

Dead-simple expense tracker for Clancy & Naomi (formerly "Velocity"; repo name
kept). Snap a receipt (or a photo of the thing you bought), the AI reads it,
you tap Save. One shared ledger, each expense tagged Clancy or Naomi, with
player cards, awards, and logging streaks to keep it fun.

**Live app:** deployed on Cloudflare Pages from this repo (push to `main` deploys).

## How it works

```
iPhone camera → Pages Function → Gemini vision → confirm card → shared ledger (Cloudflare KV)
```

- **No accounts** — one shared 4-digit PIN (created on first launch, sessions last a year)
- **Storage** — everything lives in Cloudflare KV (`VELOCITY_KV`): ledger, budgets, photos, PIN, sessions
- **AI** — Gemini reads receipts/item photos server-side; only env var needed is `GEMINI_API_KEY`
  (optional `GEMINI_MODEL`, defaults to `gemini-2.5-flash`)

## Files

| File | Purpose |
|---|---|
| `index.html` | The whole app: PIN lock, Home, History, snap/confirm/edit sheets |
| `functions/api/_middleware.js` | Session gate for all `/api/*` |
| `functions/api/auth/pin.js` | Create/verify PIN, sessions, logout |
| `functions/api/receipt.js` | Photo → Gemini → draft entry + stored photo |
| `functions/api/transactions.js` | Shared ledger CRUD |
| `functions/api/budgets.js` | Optional monthly budget per category |
| `functions/api/photo/[id].js` | Serves stored photos |
| `sw.js`, `manifest.json` | PWA install + offline shell |

## Local dev

```
npx wrangler pages dev .
```

Uses local KV simulation. Receipt parsing needs `GEMINI_API_KEY` in `.dev.vars`.

## Reset the PIN

Forgot the PIN? Delete the key and the app will ask you to create a new one:

```
npx wrangler kv key delete auth:pin --namespace-id 8377d67f2e2a40d799ea0b8594aa8652 --remote
```

(Old May-2026 data from the bank-sync experiment is backed up in `.backup/`, not committed.)
