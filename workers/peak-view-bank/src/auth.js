import { secretsEqual } from './lib.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function extractSyncSecret(request) {
  const header = request.headers.get('X-Sync-Secret') || '';
  if (header) return header;
  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.match(/^Bearer\s+(\S+)/i);
  return bearer ? bearer[1] : '';
}

export async function requireSyncSecret(request, env) {
  const expected = env.SYNC_SECRET;
  if (!expected) return json({ ok: false, error: 'SYNC_SECRET is not configured' }, 503);
  const given = extractSyncSecret(request);
  if (!(await secretsEqual(given, expected))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  return null;
}
