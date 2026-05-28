// POST /api/sync  — delegates to the velocity-teller-sync Worker which has mTLS
// The Worker URL is stored in TELLER_WORKER_URL env var

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export async function onRequestPost(context) {
  const { env } = context;
  const workerUrl = env.TELLER_WORKER_URL || 'https://velocity-teller-sync.clancybooher.workers.dev';

  try {
    const res = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.SYNC_SECRET ? { 'X-Sync-Secret': env.SYNC_SECRET } : {}),
      },
    });
    const data = await res.json();
    return new Response(JSON.stringify(data), { headers: CORS });
  } catch (err) {
    console.error('Sync proxy error:', err);
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
