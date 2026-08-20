// POST /api/receipt — multipart { image, person? }
// Gemini reads the photo (receipt OR just a picture of what was bought),
// the photo is stored in KV, and a DRAFT entry comes back for the user to
// confirm. Nothing hits the ledger until the client saves it via
// POST /api/transactions.

import { readRules, readCardMap, vendorKey, tidyVendor } from './rules.js';
import {
  TAX_CATEGORIES,
  LEGACY_BIZ_CATEGORIES,
  LEGACY_TO_TAX,
  BUSINESS_CATEGORIES,
  isBusinessCategory,
  normalizeTaxCategory,
} from './transactions.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Re-export for any consumer that imported from receipt.js
export { BUSINESS_CATEGORIES, TAX_CATEGORIES };

// Personal household categories (unchanged)
export const PERSONAL_CATEGORIES = [
  'Groceries', 'Dates', 'Clancy Fun', 'Naomi Fun', 'Dog Food',
  'House & Projects', 'Rent', 'Subscriptions', 'Everything Else',
];

// Full set Gemini may return — personal + tax codes + legacy Biz:* (compat)
export const CATEGORIES = [
  ...PERSONAL_CATEGORIES,
  ...TAX_CATEGORIES,
  ...LEGACY_BIZ_CATEGORIES,
];

const TAX_HINTS = `
Peak View business categories — pick the one Clancy would say out loud:
  ON A JOB
  * materials — Home Depot / Lowe's / lumber / foam / caulk / flashing / windows / doors (job materials)
  * disposal — dump, transfer station, dumpster, haul-away
  * permits_fees — building permits, licenses
  * subcontractors — other trades paid on a job
  TRUCK
  * vehicle_fuel — diesel, gas, Costco gas, Tesla charging for work
  * vehicle_maint — Tesla payment, trailer payment, tires, service
  * tools_equipment — Harbor Freight and tool suppliers
  SHOP
  * ads_marketing — Google / Facebook ads, website, signs
  * meals — coffee or lunch while working (Starbucks, Dutch Bros, Chipotle on a job)
  * office_software — phone, Starlink, Jobber, software, business bills
  OTHER (only if none of the above)
  * insurance, travel, rent_storage, professional, training, misc_business

Prefer materials / disposal / vehicle_fuel / vehicle_maint / tools_equipment / ads_marketing / meals / office_software.
`;

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
      .map(r => {
        const tax = r.taxCategory ? ` tax=${r.taxCategory}` : '';
        return `  * "${r.vendor}" → ${r.category}${r.business || r.card === 'business' ? ' (business card)' : ' (personal card)'}${tax}`;
      })
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
                text: `You are the expense parser for a family budget app that also tracks a small contractor business (Peak View Windows and Doors, Bend OR). The image is either a store receipt OR a photo of an item that was purchased. Today is ${new Date().toISOString().slice(0, 10)}.

Work through the receipt carefully before answering. Read the printed characters that are actually there — never infer, complete, or guess a number from context.

Return ONLY a JSON object — no markdown, no code blocks. Format:
{"vendor": "Store Name", "amount": 12.34, "date": "YYYY-MM-DD", "category": "Category Name", "taxCategory": "materials|null", "note": "what was bought", "amountConfidence": "high|low", "dateConfidence": "high|low", "cardLast4": "1234 or null"}

READING THE AMOUNT — this is the field people notice when it's wrong:
- Report the FINAL AMOUNT CHARGED: the grand total after discounts and tax.
- Receipt columns are often misaligned, so a label and the number printed beside it may belong to DIFFERENT rows. Verify by cross-checking: the total should also appear near the payment line (e.g. "AMOUNT: $271.43", "EFT/Debit 271.43", "Visa 15.99"). When the payment line and the row you read from disagree, TRUST THE PAYMENT LINE.
- Warehouse stores (Costco/Sam's) print "SUBTOTAL / TAX / **** TOTAL" with values offset; the largest value in that block is normally the total, and it repeats at the tender line. A "SUBTOTAL" of 0.00 means you are misreading the alignment.
- Ignore "INSTANT SAVINGS", "you saved", coupon, member-savings, and change-due lines — those are not the amount paid.
- If the total is obscured, cut off, or you cannot confirm it against a payment line, set amountConfidence to "low".

READING THE DATE — do NOT skip this:
- The purchase date is frequently NOT at the top. On Costco and many stores it appears at the BOTTOM, on or just above the barcode line, as MM/DD/YYYY followed by a time (e.g. "07/28/2026 15:07"). Look there before concluding there is no date.
- Also check near the payment/authorization block.
- US format is MM/DD/YYYY. Two-digit years are 20YY.
- Only use a date you can actually read on the receipt. If you cannot find one, use today's date (${new Date().toISOString().slice(0, 10)}) and set dateConfidence to "low" — do NOT guess a year, and never output a year before ${new Date().getFullYear() - 1} unless it is plainly printed.
- If it's a PHOTO OF AN ITEM (no receipt visible): describe the item briefly in note, set vendor to the brand/store if identifiable else "Unknown", and set amount to the price if visible on a tag, else 0, with amountConfidence "low".
- amount must be a decimal number, not a string.
- category: pick exactly one from:
  ${CATEGORIES.join(' | ')}
- taxCategory: when the expense is BUSINESS, set taxCategory to one of: ${TAX_CATEGORIES.join(' | ')}.
  When PERSONAL, set taxCategory to null.
${TAX_HINTS}
- Category hints for this family (${person} is the one submitting this expense):
  * Grocery stores (food) → Groceries (personal)
  * Restaurant/coffee/dessert for two people → Dates (personal)
  * A solo treat, hobby, or personal purchase → "${person} Fun"
  * Pet or dog supplies → Dog Food
  * Diesel / gas / Tesla charging for work → vehicle_fuel
  * Tesla payment, trailer payment, tires → vehicle_maint
  * Google/Facebook ads → ads_marketing
  * Home Depot, Lowe's, lumber, foam, caulk, windows, doors → materials
  * Harbor Freight / tool suppliers → tools_equipment
  * Dump / transfer station → disposal
  * Coffee or lunch while working → meals
  * Phone, Starlink, Jobber, software → office_software
  * Anything that doesn't clearly fit personal → Everything Else; business catch-all → office_software if it looks like a bill, else misc_business
- They run Peak View Windows and Doors, a window & door installation business in Bend, OR.
  HOUSEHOLD RULE — apply this first, it overrides your own judgment:
  * Hardware, home improvement, building supply, tool, or lumber stores are ALWAYS business.
    This explicitly includes Home Depot, Lowe's, Ace Hardware, Harbor Freight, lumber yards,
    and window/door/glass suppliers — even when the items look like household goods.
  * If the purchase is NOT food or drink, default to BUSINESS with the best tax code.
  * Food and drink is personal by default: grocery stores, restaurants, and takeout.
    The exceptions that stay business are fuel and coffee bought while working (meals / vehicle_fuel).
  * Personal also covers clothing, personal care, pet supplies, and hobby/leisure items
    bought somewhere that is clearly not a trade supplier.
  * For business expenses prefer snake_case tax codes as the category value (e.g. "materials"
    not "Biz: …"). Legacy Biz:* labels still work if you must.${learned}
- cardLast4: last 4 digits of the card on the payment line if printed (Visa 1234, ****5678). Null if cash, not shown, or a photo of an item.
- note: very short (1 line max), or empty string.`
              },
              { inlineData: { mimeType, data: base64Image } }
            ]
          }],
          generationConfig: {
            temperature: 0,
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
    const vendor = tidyVendor(parsed.vendor);
    let category = CATEGORIES.includes(parsed.category) ? parsed.category : 'Everything Else';

    // Normalize: if model returned a tax code as category, keep it
    if (TAX_CATEGORIES.includes(parsed.category)) {
      category = parsed.category;
    } else if (LEGACY_TO_TAX[parsed.category]) {
      category = parsed.category; // keep legacy label for phone UI if needed
    }

    // An exact learned rule for this vendor always wins over the model's guess
    const rule = rules[vendorKey(vendor)];
    let learnedHit = false;
    if (rule && (CATEGORIES.includes(rule.category) || TAX_CATEGORIES.includes(rule.category))) {
      category = rule.category;
      learnedHit = true;
    }

    // taxCategory: rule > explicit parse > derive from category
    let taxCategory = null;
    if (learnedHit && rule.taxCategory && TAX_CATEGORIES.includes(rule.taxCategory)) {
      taxCategory = rule.taxCategory;
    } else if (parsed.taxCategory && TAX_CATEGORIES.includes(parsed.taxCategory)) {
      taxCategory = parsed.taxCategory;
    } else {
      taxCategory = normalizeTaxCategory(category);
    }

    // Misread receipt dates silently corrupt every total in the app, so flag
    // anything implausible instead of trusting it.
    let date = parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : today;
    let dateWarning = null;
    const dayMs = 86400000;
    const drift = Math.round((Date.parse(date) - Date.parse(today)) / dayMs);
    if (!Number.isFinite(drift)) {
      date = today;
    } else if (drift > 1) {
      dateWarning = 'That date is in the future';
      date = today;
    } else if (drift < -45) {
      dateWarning = `That receipt reads ${date}`;
    } else if (parsed.dateConfidence === 'low') {
      dateWarning = "I couldn't find a date — using today";
      date = today;
    }

    const amountWarning = parsed.amountConfidence === 'low'
      ? "Double-check the amount — I wasn't sure I read the total right"
      : null;

    const business = isBusinessCategory(category) || !!taxCategory;
    const cardLast4 = String(parsed.cardLast4 || '').replace(/\D/g, '').slice(-4);
    const cardMap = await readCardMap(env);
    let card = 'personal';
    if (cardLast4.length === 4 && cardMap[cardLast4]) {
      card = cardMap[cardLast4];
    } else if (rule && (rule.card === 'business' || rule.card === 'personal')) {
      card = rule.card;
    } else if (business || (rule && rule.business)) {
      card = 'business';
    }

    const draft = {
      vendor,
      amount: Math.abs(parseFloat(parsed.amount) || 0),
      date,
      category,
      taxCategory,
      business: card === 'business' || business,
      card,
      cardLast4: cardLast4.length === 4 ? cardLast4 : null,
      person,
      deductible: card === 'business' || business,
      note: String(parsed.note || '').trim(),
    };

    return new Response(JSON.stringify({ ok: true, draft, photoId, learnedHit, dateWarning, amountWarning }), { headers: JSON_HEADERS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
}
