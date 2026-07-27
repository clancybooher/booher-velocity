// GET /api/photo/:id — serve a stored receipt/item photo

export async function onRequestGet({ env, params }) {
  const raw = await env.VELOCITY_KV.get(`photo:${params.id}`);
  if (!raw) return new Response('Not found', { status: 404 });

  const { mime, data } = JSON.parse(raw);
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'Content-Type': mime || 'image/jpeg',
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}
