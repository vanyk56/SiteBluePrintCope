// Minimal OpenAI-compatible Chat Completions client (Z.ai GLM, Gemini, DeepSeek, OpenRouter, OpenAI, Ollama…).
import { sleep } from '../util.mjs';
import { log } from '../log.mjs';

export class LLMError extends Error { constructor(msg, extra = {}) { super(msg); Object.assign(this, extra); } }

const textOnly = (messages) => messages.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n') } : m));
const hasImages = (messages) => messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
const IMAGE_ERR = /image|vision|multimodal|multi-modal|image_url|content type|unsupported content|does not support|not support.*(image|input)|invalid.*content/i;

function extractText(data) {
  const ch = data && data.choices && data.choices[0];
  if (!ch) return { text: '', finish: '' };
  const msg = ch.message || {};
  let text = '';
  if (typeof msg.content === 'string') text = msg.content;
  else if (Array.isArray(msg.content)) text = msg.content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
  text = text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
  return { text: text.trim(), finish: ch.finish_reason || '', reasoning: msg.reasoning_content || msg.reasoning || '' };
}

export async function chat(llm, messages, { maxTokens, temperature, label = 'LLM', attempts = 4 } = {}) {
  const url = llm.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  let msgs = llm.vision ? messages : textOnly(messages);
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const body = { model: llm.model, messages: msgs, stream: false, max_tokens: maxTokens || llm.maxTokens };
    const temp = temperature ?? llm.temperature; if (temp !== undefined && temp !== null) body.temperature = temp;
    if (llm.topP !== undefined && llm.topP !== null && !Number.isNaN(llm.topP)) body.top_p = llm.topP;
    if (llm.reasoningEffort) body.reasoning_effort = llm.reasoningEffort;
    Object.assign(body, llm.extraBody || {});
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), llm.timeoutMs || 600000);
    const t0 = Date.now();
    try {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (llm.apiKey) headers.Authorization = `Bearer ${llm.apiKey}`;
      if (llm.provider === 'openrouter') { headers['HTTP-Referer'] = 'https://github.com/site-blueprint'; headers['X-Title'] = 'site-blueprint'; }
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
      const raw = await res.text();
      let data = null; try { data = JSON.parse(raw); } catch {}
      if (!res.ok) {
        const msg = (data && (data.error?.message || data.message || data.msg)) || raw.slice(0, 400) || res.statusText;
        if (res.status === 400 && hasImages(msgs) && IMAGE_ERR.test(String(msg))) {
          log.warn(`${label}: модель не приняла изображения (${String(msg).slice(0, 160)}) — повторяю без скриншотов`);
          llm.vision = false; msgs = textOnly(msgs); attempt--; continue;
        }
        if (res.status === 401 || res.status === 403) throw new LLMError(`доступ запрещён (HTTP ${res.status}): ${String(msg).slice(0, 300)} — проверь LLM_API_KEY / LLM_BASE_URL`, { fatal: true, status: res.status });
        if (res.status === 404) throw new LLMError(`HTTP 404: ${String(msg).slice(0, 300)} — проверь LLM_BASE_URL и имя модели LLM_MODEL`, { fatal: true, status: 404 });
        if (res.status === 429 || res.status >= 500) {
          const ra = Number(res.headers.get('retry-after')); const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 90000) : Math.min(60000, 2500 * 2 ** (attempt - 1));
          lastErr = new LLMError(`HTTP ${res.status}: ${String(msg).slice(0, 300)}`, { status: res.status });
          if (attempt < attempts) { log.warn(`${label}: ${lastErr.message} — повтор через ${Math.round(wait / 1000)} с`); await sleep(wait); continue; }
          throw lastErr;
        }
        throw new LLMError(`HTTP ${res.status}: ${String(msg).slice(0, 400)}`, { status: res.status, fatal: res.status === 400 });
      }
      if (!data) throw new LLMError('ответ не JSON: ' + raw.slice(0, 200));
      const { text, finish, reasoning } = extractText(data);
      if (!text) {
        lastErr = new LLMError(`пустой ответ модели${finish ? ` (finish_reason=${finish})` : ''}${reasoning ? ' — модель потратила токены на рассуждения, увеличь LLM_MAX_TOKENS' : ''}`);
        if (attempt < attempts) { await sleep(1500); continue; }
        throw lastErr;
      }
      return { text, finish, usage: data.usage || {}, ms: Date.now() - t0, model: data.model || llm.model };
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e.name === 'AbortError' ? new LLMError(`таймаут ${Math.round((llm.timeoutMs || 0) / 1000)} с (LLM_TIMEOUT_MS)`) : e;
      if (attempt < attempts && !(e instanceof LLMError && e.status === 400)) { const wait = Math.min(30000, 2000 * 2 ** (attempt - 1)); log.warn(`${label}: ${lastErr.message} — повтор через ${Math.round(wait / 1000)} с`); await sleep(wait); continue; }
      throw lastErr;
    } finally { clearTimeout(timer); }
  }
  throw lastErr || new LLMError('неизвестная ошибка');
}
