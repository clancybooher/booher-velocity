// Proxies writes to Google Sheets via a Google Apps Script web app.
// GAS_WEBHOOK_URL is set in Cloudflare Pages environment variables.
export async function onRequestPost(context) {
  const { request, env } = context;

  const CORS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.GAS_WEBHOOK_URL) {
    return new Response(JSON.stringify({ error: 'GAS_WEBHOOK_URL not configured — see SETUP.md' }), { status: 503, headers: CORS });
  }

  try {
    const body = await request.json();

    // Validate action
    const allowed = ['update_budget', 'recategorize'];
    if (!allowed.includes(body.action)) {
      return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: CORS });
    }

    const gasRes = await fetch(env.GAS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!gasRes.ok) {
      const errText = await gasRes.text();
      return new Response(JSON.stringify({ error: 'GAS error', detail: errText }), { status: 502, headers: CORS });
    }

    const data = await gasRes.json();
    return new Response(JSON.stringify(data), { headers: CORS });

  } catch (err) {
    console.error('Sheets proxy error:', err);
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
