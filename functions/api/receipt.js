// POST /api/receipt — multipart { image, person? }
// Gemini reads the photo (receipt OR just a picture of what was bought),
// the photo is stored in KV, and a DRAFT entry comes back for the user to
// confirm. Nothing hits the ledger until the client saves it via
// POST /api/transactions.

import { readRules, vendorKey } from './rules.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const BUSINESS_CATEGORIES = [
  'Biz: Diesel', 'Biz: Advertising', 'Biz: Coffee Shop', 'Biz: Tesla',
  'Biz: Trailer', 'Biz: Bills & Subs',
];

export const CATEGORIES = [
  'Groceries', 'Dates', 'Clancy Fun', 'Naomi Fun', 'Dog Food',
  'House & Projects', 'Rent', 'Subscriptions', 'Everything Else',
  'Biz: Diesel', 'Biz: Advertising', 'Biz: Coffee Shop', 'Biz: Tesla',
  'Biz: Trailer', 'Biz: Bills & Subs',
];

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }), { status: 503, headers: JSON_HEADERS });
  }

  try {
    const formData = await request.formData();
    const imageFile = formData.get('image');
    const person = formData.get('person') === 'Naomi' ? 'Naomi' : 'Clancy';
    if (!imageFile) {
      return new Response(JSON.stringify({ error: 'No image provided' }), { status: 400, headers: JSON_HEADERS });
    }

    const imageBuffer = await imageFile.arrayBuffer();
    const bytes = new Uint8Array(imageBuffer);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.slice(i, i + chunk));
    }
    const base64Image = btoa(binary);
    const mimeType = imageFile.type || 'image/jpeg';

    const model = env.GEMINI_MODEL || 'gemini-2.5-flash';

    // Feed back what we've learned from past corrections
    const rules = await readRules(env);
    const ruleLines = Object.values(rules)
      .slice(-40)
      .map(r => `  * "${r.vendor}" → ${r.category}${r.business ? ' (business)' : ''}`)
      .join('\n');
    const learned = ruleLines
      ? `\n- LEARNED PREFERENCES — these override the hints above; this household has corrected you before:\n${ruleLines}\n`
      : '';

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                text: `You are the expense parser for a family budget app. The image is either a store receipt OR a photo of an item that was purchased.

Return ONLY a JSON object — no markdown, no code blocks. Format:
{"vendor": "Store Name", "amount": 12.34, "date": "YYYY-MM-DD", "category": "Category Name", "note": "what was bought"}

Rules:
- If it's a RECEIPT: vendor = merchant name properly capitalized, amount = final total paid, date = purchase date (YYYY-MM-DD).
- If it's a PHOTO OF AN ITEM (no receipt visible): describe the item briefly in note, set vendor to the brand/store if identifiable else "Unknown", and set amount to the price if visible on a tag, else 0.
- If the date is not visible, use today's date.
- amount must be a decimal number, not a string.
- category: pick exactly one from:
  ${CATEGORIES.join(' | ')}
- Category hints for this family (${person} is the one submitting this expense):
  * Grocery stores (food) → Groceries
  * Restaurant/coffee/dessert for two people → Dates
  * A solo treat, hobby, or personal purchase → "${person} Fun"
  * Pet or dog supplies → Dog Food
  * Hardware store, home improvement, furniture → House & Projects
  * Diesel or gas station fuel → Biz: Diesel (they run a window & door business with a work truck)
  * Google/Facebook/online ads → Biz: Advertising
  * Anything that doesn't clearly fit → Everything Else
- They run Peak View Windows and Doors, a window & door installation business in Bend, OR.
  Treat a purchase as BUSINESS when it's plainly for that trade: fuel for the work truck,
  lumber/hardware/tools/jobsite materials, online advertising, trailer or vehicle costs,
  business insurance/bonding/phone/internet, or coffee bought while working.
  Treat it as PERSONAL when it's household groceries, a meal out together, clothing,
  personal care, pet supplies, or hobby/leisure items.
  If it is genuinely ambiguous, choose personal.${learned}
- note: very short (1 line max), or empty string.`
              },
              { inlineData: { mimeType, data: base64Image } }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
          }
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return new Response(JSON.stringify({ error: 'AI error', detail: errText }), { status: 502, headers: JSON_HEADERS });
    }

    const geminiData = await geminiRes.json();
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return new Response(JSON.stringify({ error: 'No response from AI' }), { status: 502, headers: JSON_HEADERS });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) { try { parsed = JSON.parse(match[0]); } catch { parsed = null; } }
    }

    if (!parsed) {
      return new Response(JSON.stringify({ error: 'Could not read that photo', raw: text }), { status: 422, headers: JSON_HEADERS });
    }

    // Store the photo so it stays attached to the expense
    const photoId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    await env.VELOCITY_KV.put(`photo:${photoId}`, JSON.stringify({ mime: mimeType, data: base64Image }));

    const today = new Date().toISOString().split('T')[0];
    const vendor = String(parsed.vendor || 'Unknown').trim() || 'Unknown';
    let category = CATEGORIES.includes(parsed.category) ? parsed.category : 'Everything Else';

    // An exact learned rule for this vendor always wins over the model's guess
    const rule = rules[vendorKey(vendor)];
    let learnedHit = false;
    if (rule && CATEGORIES.includes(rule.category)) {
      category = rule.category;
      learnedHit = true;
    }

    const draft = {
      vendor,
      amount: Math.abs(parseFloat(parsed.amount) || 0),
      date: parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : today,
      category,
      business: BUSINESS_CATEGORIES.includes(category),
      note: String(parsed.note || '').trim(),
    };

    return new Response(JSON.stringify({ ok: true, draft, photoId, learnedHit }), { headers: JSON_HEADERS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
}
