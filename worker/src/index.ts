import { handleTelegramUpdate, sendTelegram } from './agent';
import { runHourlySync } from './tools';

export interface Env {
  // KV namespace
  VELOCITY_KV: KVNamespace;
  // mTLS bound certificate for Teller API outbound requests
  TELLER_MTLS: Fetcher;
  // Secrets
  GEMINI_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELLER_ACCESS_TOKEN: string;
  GOOGLE_SHEETS_ID: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  WEBHOOK_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (request.method === 'GET') {
      return new Response('Booher Velocity — OK', { status: 200 });
    }

    // Telegram webhook
    if (request.method === 'POST' && url.pathname === '/webhook') {
      // Verify Telegram secret token
      const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }

      const update = await request.json();

      // Respond to Telegram immediately, process in background
      ctx.waitUntil(handleTelegramUpdate(update, env));
      return new Response('OK', { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await runHourlySync(env);
          const chatId = parseInt(env.TELEGRAM_CHAT_ID, 10);
          if (result.new_transactions > 0) {
            await sendTelegram(env, chatId, result.message);
          }
          console.log('Hourly sync:', result.message);
        } catch (e) {
          console.error('Hourly sync error:', e);
        }
      })()
    );
  },
};
