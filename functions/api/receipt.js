export async function onRequestPost(context) {
  const { request, env } = context;

  const CORS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }), { status: 503, headers: CORS });
  }

  try {
    const formData = await request.formData();
    const imageFile = formData.get('image');
    if (!imageFile) {
      return new Response(JSON.stringify({ error: 'No image provided' }), { status: 400, headers: CORS });
    }

    // Convert image to base64
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

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                text: `You are a receipt parser for a personal budget app. Extract data from this receipt image.

Return ONLY a JSON object — no markdown, no code blocks, no explanation. Just raw JSON.

Format:
{"vendor": "Store Name", "amount": 12.34, "date": "YYYY-MM-DD", "category": "Category Name", "note": "optional brief note"}

Rules:
- vendor: the store or merchant name, properly capitalized
- amount: the final total paid as a decimal number (not a string)
- date: the purchase date in YYYY-MM-DD format; if not visible, use today's date
- category: pick exactly one from this list:
  Groceries | Dining Out & Coffee | Utilities & Bills | Transportation & Gas | Entertainment & Date Nights | Home & Maintenance | Health & Personal Care | Travel & Vacations | Savings & Investments | Gifts & Giving | Miscellaneous
- note: a very short note about what was purchased (1 line max), or empty string if nothing notable`
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
      return new Response(JSON.stringify({ error: 'Gemini API error', detail: errText }), { status: 502, headers: CORS });
    }

    const geminiData = await geminiRes.json();
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      return new Response(JSON.stringify({ error: 'No response from AI' }), { status: 502, headers: CORS });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
      }
    }

    if (!parsed || !parsed.vendor) {
      return new Response(JSON.stringify({ error: 'Could not parse receipt', raw: text }), { status: 422, headers: CORS });
    }

    const today = new Date().toISOString().split('T')[0];
    const result = {
      vendor: String(parsed.vendor || 'Unknown').trim(),
      amount: Math.abs(parseFloat(parsed.amount) || 0),
      date: parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : today,
      category: parsed.category || 'Miscellaneous',
      note: String(parsed.note || '').trim(),
    };

    // Write to Cloudflare KV (primary storage)
    if (env.VELOCITY_KV) {
      try {
        const raw     = await env.VELOCITY_KV.get('ledger');
        const entries = raw ? JSON.parse(raw) : [];
        entries.push({
          id:         crypto.randomUUID().replace(/-/g, '').slice(0, 12),
          type:       'receipt',
          date:       result.date,
          vendor:     result.vendor,
          amount:     -result.amount,
          category:   result.category,
          notes:      result.note,
          created_at: new Date().toISOString(),
        });
        await env.VELOCITY_KV.put('ledger', JSON.stringify(entries));
      } catch (e) {
        console.error('KV write failed:', e.message);
      }
    }

    return new Response(JSON.stringify({ ok: true, ...result }), { headers: CORS });

  } catch (err) {
    console.error('Receipt error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}
