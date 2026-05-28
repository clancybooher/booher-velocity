# Booher Velocity — Setup Guide (v2)

No more Telegram. No more OpenClaw. Everything runs in the browser via Cloudflare + Gemini.

---

## How It Works Now

```
[iPhone camera]
      ↓
[Velocity web app (Cloudflare Pages)]
      ↓
[Cloudflare Worker → Gemini Flash 2.5 AI]
      ↓
[Google Apps Script → Google Sheets]
      ↓
[Budget updates live in the app]
```

The AI lives in your Cloudflare Pages Functions. No server to manage. No bots.

---

## Step 1: Google Apps Script (one-time setup)

This lets the app write receipts and budget changes directly to your Google Sheet.

1. Open your Google Sheet: https://docs.google.com/spreadsheets/d/1dMrEE6-efTiXw5wGG0Qzzfh8HpTgDV2pBpHA_6td7QA/edit
2. Click **Extensions → Apps Script**
3. Delete any existing code and paste the contents of `gas/Code.gs` from this repo
4. Click **Deploy → New deployment**
5. Set type: **Web app**
6. Execute as: **Me**
7. Who has access: **Anyone**
8. Click **Deploy** — copy the Web App URL (looks like `https://script.google.com/macros/s/ABC123.../exec`)
9. Save that URL — you'll need it in Step 3

---

## Step 2: Cloudflare Pages — push the repo

Your GitHub repo should be connected to Cloudflare Pages. If not:

1. Push this repo to GitHub (if not already there)
2. Go to **Cloudflare Dashboard → Pages → Create a project → Connect to Git**
3. Select the `booher-velocity` repo
4. Build settings:
   - Framework preset: **None**
   - Build command: *(leave blank)*
   - Build output directory: `/` (root)
5. Click **Save and Deploy**

Cloudflare will auto-detect the `functions/` directory and deploy the Workers.

---

## Step 3: Add Environment Variables in Cloudflare

Go to **Cloudflare Pages → Your Project → Settings → Environment Variables** and add:

| Variable | Value |
|---|---|
| `GEMINI_API_KEY` | Your Gemini API key from aistudio.google.com |
| `GAS_WEBHOOK_URL` | The Web App URL from Step 1 |
| `GEMINI_MODEL` | `gemini-2.5-flash` *(optional, this is the default)* |

After adding variables, click **Save** and trigger a new deployment (or just redeploy from the dashboard).

> **Security note:** These variables are stored server-side in Cloudflare. They never appear in your HTML or JavaScript. Never commit your API key to GitHub.

---

## Step 4: Add to iPhone Home Screen

1. Open the Cloudflare Pages URL in **Safari** on your iPhone
2. Tap the **Share button** (box with arrow up)
3. Tap **Add to Home Screen**
4. Name it **Velocity** → tap Add
5. Launch from your home screen — it opens full-screen with no browser chrome

---

## App Features

| Feature | How it works |
|---|---|
| **Snap Receipt** | Photo → Gemini Flash 2.5 Vision → parses vendor/amount/date/category → saves to Google Sheet |
| **AI Chat** | Ask budget questions → Gemini reads your live budget data → answers instantly |
| **Transactions** | Reads directly from Google Sheet (real-time) |
| **Budget Settings** | Update envelope amounts → saves to Google Sheet via Apps Script |
| **Recategorize** | Tap any transaction → change category → updates Google Sheet |
| **Back Button** | ← Home button on Transactions and Budget screens |

---

## Troubleshooting

**Receipt upload shows "Gemini API error"**
- Check that `GEMINI_API_KEY` is set in Cloudflare env vars
- Make sure you redeployed after adding the variable
- Test your key at aistudio.google.com

**"GAS_WEBHOOK_URL not configured"**
- Complete Step 1 (Google Apps Script setup)
- Paste the Web App URL into Cloudflare env vars as `GAS_WEBHOOK_URL`

**Budget/transactions not loading**
- The Google Sheet must be set to share as "Anyone with the link can view" (for the CSV read to work)
- Check the Sheet name tabs: must be named `Transactions` and `Budget`

**Chat says "couldn't connect"**
- This means the `/api/chat` Cloudflare Function isn't running
- Make sure you're accessing the Cloudflare Pages URL (not just opening index.html locally)
- Check Cloudflare Pages → Functions tab for errors

---

## File Reference

| File | Purpose |
|---|---|
| `index.html` | Main PWA (all screens: Home, Chat, Transactions, Budget) |
| `manifest.json` | PWA install metadata |
| `sw.js` | Service worker (offline cache) |
| `functions/api/receipt.js` | Cloudflare Worker: image → Gemini → Sheets |
| `functions/api/chat.js` | Cloudflare Worker: question → Gemini → answer |
| `functions/api/sheets.js` | Cloudflare Worker: budget/recategorize → GAS |
| `gas/Code.gs` | Google Apps Script: handles all Sheet writes |
