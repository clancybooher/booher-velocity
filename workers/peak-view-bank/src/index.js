/**
 * Peak View Bank MCP
 *
 * Separate from the household Velocity app. Reads Chase through the
 * working velocity-teller-sync enrollment (TELLER_TOKEN + teller-velocity
 * mTLS). Writes only PEAK_VIEW_BANK_KV pending/ledger/cursor keys.
 *
 * No Teller Connect. Do not use Peak View app_q175.
 */

import { requireSyncSecret } from './auth.js';
import { handleMcpRequest, mcpServerInfo } from './mcp.js';
import { TOOL_SCHEMAS, bankHealth, bankListPending, bankListRecent, bankSync, runTool } from './tools.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type,X-Sync-Secret,Authorization',
          },
        });
      }

      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        return json(await bankHealth(env));
      }

      if (request.method === 'GET' && url.pathname === '/mcp/tools') {
        return json({
          ok: true,
          server: mcpServerInfo(),
          tools: TOOL_SCHEMAS,
        });
      }

      if (url.pathname === '/mcp') {
        const denied = await requireSyncSecret(request, env);
        if (denied) return denied;
        if (request.method === 'GET') {
          return json({
            ok: true,
            server: mcpServerInfo(),
            tools: TOOL_SCHEMAS.map((t) => t.name),
            auth: 'X-Sync-Secret or Authorization: Bearer <SYNC_SECRET>',
          });
        }
        if (request.method === 'POST') return handleMcpRequest(request, env);
        return json({ ok: false, error: 'method_not_allowed' }, 405);
      }

      const denied = await requireSyncSecret(request, env);
      if (denied) return denied;

      if (request.method === 'POST' && url.pathname === '/sync') {
        return json(await bankSync(env, await readJson(request)));
      }
      if (request.method === 'GET' && url.pathname === '/pending') {
        return json(
          await bankListPending(env, {
            status: url.searchParams.get('status') || undefined,
            limit: url.searchParams.get('limit') || undefined,
          }),
        );
      }
      if (request.method === 'GET' && url.pathname === '/recent') {
        return json(
          await bankListRecent(env, {
            limit: url.searchParams.get('limit') || undefined,
            supplier_only: url.searchParams.get('supplier_only') === '1',
          }),
        );
      }
      if (request.method === 'POST' && url.pathname === '/tools') {
        const body = await readJson(request);
        return json(await runTool(body.name, env, body.arguments || {}));
      }

      return json({ ok: false, error: 'not_found' }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'error';
      const status = message.startsWith('teller_http_') ? 502 : 500;
      return json({ ok: false, error: message }, status);
    }
  },
};
