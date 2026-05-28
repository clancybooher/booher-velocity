// POST /api/sync  — pull new bank transactions for this user via the teller Worker
const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export async function onRequestPost(context) {
  const { env, data } = context;
  const workerUrl = env.TELLER_WORKER_URL || 'https://velocity-teller-sync.clancybooher.workers.dev';

  try {
    const res  = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.SYNC_SECRET ? { 'X-Sync-Secret': env.SYNC_SECRET } : {}),
      },
      body: JSON.stringify({ userId: data.userId }),
    });
    const result = await res.json();
    return new Response(JSON.stringify(result), { headers: CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
  });
}
