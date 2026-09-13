import { SERVICE } from './lib.js';
import { TOOL_SCHEMAS, runTool } from './tools.js';

const PROTOCOL = '2024-11-05';

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}

export function mcpServerInfo() {
  return {
    name: SERVICE,
    version: '1.0.0',
    title: 'Peak View Bank MCP',
  };
}

export async function handleMcpMessage(message, env) {
  if (!message || message.jsonrpc !== '2.0') {
    return rpcError(message?.id ?? null, -32600, 'Invalid Request');
  }

  const { id, method, params } = message;
  if (id === undefined && typeof method === 'string' && method.startsWith('notifications/')) {
    return null;
  }

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: mcpServerInfo(),
        instructions:
          'Peak View bank tools. Shared: Velocity Teller Chase enrollment. Isolated: Peak View pending expenses only — never the household Velocity ledger.',
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOL_SCHEMAS });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      if (!name) return rpcError(id, -32602, 'name is required');
      try {
        const result = await runTool(name, env, args);
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : 'tool_error';
        return ok(id, {
          content: [{ type: 'text', text }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(id ?? null, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcpRequest(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, 'Parse error'), 400);
  }

  if (Array.isArray(body)) {
    const results = [];
    for (const msg of body) {
      const out = await handleMcpMessage(msg, env);
      if (out) results.push(out);
    }
    return jsonResponse(results);
  }

  const out = await handleMcpMessage(body, env);
  if (!out) return new Response(null, { status: 204 });
  return jsonResponse(out);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
