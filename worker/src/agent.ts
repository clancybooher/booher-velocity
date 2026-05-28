import type { Env } from './index';
import { SYSTEM_PROMPT } from './system-prompt';
import { TOOL_DECLARATIONS } from './tools-schema';
import { executeTool } from './tools';

// ── Types ────────────────────────────────────────────────────────────────────

interface TextPart     { text: string }
interface InlineData   { inlineData: { mimeType: string; data: string } }
interface FunctionCall { functionCall: { name: string; args: Record<string, unknown> } }
interface FunctionResp { functionResponse: { name: string; response: unknown } }
type Part = TextPart | InlineData | FunctionCall | FunctionResp;

interface Content { role: 'user' | 'model'; parts: Part[] }

interface GeminiResponse {
  candidates: Array<{
    content: Content;
    finishReason: string;
  }>;
}

// ── Conversation history ─────────────────────────────────────────────────────

const CONV_TTL = 60 * 60 * 24; // 24h

async function loadHistory(env: Env, chatId: number): Promise<Content[]> {
  const raw = await env.VELOCITY_KV.get(`conv:${chatId}`);
  return raw ? JSON.parse(raw) : [];
}

async function saveHistory(env: Env, chatId: number, history: Content[]): Promise<void> {
  // Strip inlineData from stored history (images are too large for KV)
  const clean = history.map(c => ({
    ...c,
    parts: c.parts.map(p => ('inlineData' in p ? { text: '[photo]' } as TextPart : p)),
  }));
  // Keep last 30 turns to stay within token limits
  const trimmed = clean.slice(-30);
  await env.VELOCITY_KV.put(`conv:${chatId}`, JSON.stringify(trimmed), { expirationTtl: CONV_TTL });
}

// ── Gemini call ──────────────────────────────────────────────────────────────

async function callGemini(env: Env, contents: Content[]): Promise<Content> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${err}`);
  }

  const data = await resp.json() as GeminiResponse;
  if (!data.candidates?.length) throw new Error('Gemini returned no candidates');
  return data.candidates[0].content;
}

// ── Agent loop ───────────────────────────────────────────────────────────────

export async function runAgent(env: Env, chatId: number, userParts: Part[]): Promise<string> {
  const history = await loadHistory(env, chatId);
  const userTurn: Content = { role: 'user', parts: userParts };
  const contents: Content[] = [...history, userTurn];

  let responseText = '';
  const MAX_ROUNDS = 8;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const modelContent = await callGemini(env, contents);
    contents.push(modelContent);

    const funcCalls = modelContent.parts.filter(
      (p): p is FunctionCall => 'functionCall' in p
    );
    const textParts = modelContent.parts.filter(
      (p): p is TextPart => 'text' in p
    );

    if (funcCalls.length === 0) {
      // Final text response
      responseText = textParts.map(p => p.text).join('').trim();
      break;
    }

    // Execute all function calls in parallel
    const funcResponses = await Promise.all(
      funcCalls.map(async fc => {
        let result: unknown;
        try {
          result = await executeTool(env, fc.functionCall.name, fc.functionCall.args);
        } catch (e) {
          result = { error: String(e) };
        }
        return {
          functionResponse: { name: fc.functionCall.name, response: result },
        } as FunctionResp;
      })
    );

    // Feed results back as a user turn
    contents.push({ role: 'user', parts: funcResponses });
  }

  if (!responseText) responseText = 'Sorry, something went wrong. Please try again.';

  // Save updated history (user turn + all model/function turns)
  const newHistory: Content[] = [...history, userTurn, ...contents.slice(history.length + 1)];
  await saveHistory(env, chatId, newHistory);

  return responseText;
}

// ── Telegram helpers ─────────────────────────────────────────────────────────

async function telegramGet(env: Env, method: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const resp = await fetch(url.toString());
  return resp.json();
}

export async function sendTelegram(env: Env, chatId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

async function downloadTelegramPhoto(env: Env, fileId: string): Promise<{ mimeType: string; data: string }> {
  const fileInfo = await telegramGet(env, 'getFile', { file_id: fileId }) as {
    result: { file_path: string };
  };
  const filePath = fileInfo.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;

  const resp = await fetch(fileUrl);
  const buffer = await resp.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  const mimeType = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  return { mimeType, data: base64 };
}

// ── Telegram update handler ──────────────────────────────────────────────────

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  photo?: Array<{ file_id: string; width: number; height: number }>;
  caption?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export async function handleTelegramUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const parts: Part[] = [];

  if (msg.photo?.length) {
    // Use the largest photo (last in array)
    const largest = msg.photo[msg.photo.length - 1];
    try {
      const imageData = await downloadTelegramPhoto(env, largest.file_id);
      parts.push({ inlineData: imageData });
    } catch (e) {
      await sendTelegram(env, chatId, `⚠️ Couldn't download the photo. Error: ${String(e)}`);
      return;
    }
    // Caption becomes text context (or a prompt to process as receipt)
    parts.push({ text: msg.caption ?? 'Please process this receipt.' });
  } else if (msg.text) {
    parts.push({ text: msg.text });
  } else {
    return; // Ignore non-text, non-photo messages
  }

  try {
    const reply = await runAgent(env, chatId, parts);
    await sendTelegram(env, chatId, reply);
  } catch (e) {
    console.error('Agent error:', e);
    await sendTelegram(env, chatId, `⚠️ Something went wrong: ${String(e)}`);
  }
}
