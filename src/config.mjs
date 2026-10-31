import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log } from './log.mjs';

export const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  for (const p of [path.resolve(process.cwd(), '.env'), path.join(TOOL_DIR, '.env')]) {
    if (!fs.existsSync(p)) continue;
    try { process.loadEnvFile(p); }
    catch {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    }
  }
}

// OpenAI-compatible providers. Model defaults only where verified.
export const PROVIDERS = {
  river: { baseUrl: 'https://api.river.ai/v1', model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', vision: true, keyEnv: ['RIVER_API_KEY'] },
  zai: { baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3-flash', vision: true, temperature: 1, topP: 0.95, keyEnv: ['ZAI_API_KEY'] },
  'zai-coding': { baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.3-flash', vision: true, temperature: 1, topP: 0.95, keyEnv: ['ZAI_API_KEY'] },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: '', vision: true, keyEnv: ['ZHIPU_API_KEY'] },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', vision: true, keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: '', vision: false, keyEnv: ['DEEPSEEK_API_KEY'] },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: '', vision: true, keyEnv: ['OPENROUTER_API_KEY'] },
  openai: { baseUrl: 'https://api.openai.com/v1', model: '', vision: true, keyEnv: ['OPENAI_API_KEY'] },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: '', vision: true, noKey: true },
  custom: { baseUrl: '', model: '', vision: true },
};

export const DEFAULTS = {
  depth: 2, maxPages: 15, perTemplate: 2, out: 'output', concurrency: 2, delay: 300, timeout: 45000,
  viewport: '1440x900', mobileViewport: '390x844', mobile: true, hover: true, interactions: true,
  robots: true, subdomains: false, sitemap: true, cookies: true, headful: false, html: true,
  maxNodes: 4000, maxAssets: 400, maxAssetMb: 15, assets: true,
  llm: true, lang: 'ru', verbose: false, locale: '',
};
const BOOL = new Set(['mobile', 'hover', 'interactions', 'robots', 'subdomains', 'sitemap', 'cookies', 'headful', 'llm', 'verbose', 'help', 'assets', 'ignoreRobots', 'version', 'html']);
const NUM = new Set(['depth', 'maxPages', 'perTemplate', 'concurrency', 'delay', 'timeout', 'maxNodes', 'maxAssets', 'maxAssetMb', 'maxImages']);
const ALIASES = { d: 'depth', p: 'maxPages', o: 'out', m: 'model', h: 'help', v: 'verbose' };

export function parseArgs(argv) {
  const opts = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (/^-[a-z]$/i.test(a)) a = '--' + (ALIASES[a[1]] || a[1]);
    if (!a.startsWith('--')) { positional.push(a); continue; }
    let key = a.slice(2), val;
    const eq = key.indexOf('=');
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    key = key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (/^no[A-Z]/.test(key) && val === undefined) { opts[key[2].toLowerCase() + key.slice(3)] = false; continue; }
    if (val === undefined) {
      if (BOOL.has(key)) val = true;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) val = argv[++i];
      else val = true;
    }
    if (BOOL.has(key) && typeof val === 'string') val = !/^(0|false|no|off)$/i.test(val);
    if (NUM.has(key)) val = Number(val);
    opts[key] = val;
  }
  if (opts.ignoreRobots) opts.robots = false;
  return { opts, positional };
}

export function parseSize(s, fallback) {
  const m = /^(\d+)x(\d+)$/i.exec(String(s || ''));
  return m ? { width: +m[1], height: +m[2] } : fallback;
}

export function resolveLLM(opts) {
  const env = process.env;
  const provider = String(opts.provider || env.LLM_PROVIDER || 'river').toLowerCase();
  const preset = PROVIDERS[provider] || PROVIDERS.custom;
  const apiKey = opts.apiKey || env.LLM_API_KEY || (preset.keyEnv || []).map((k) => env[k]).find(Boolean) || '';
  const baseUrl = String(opts.baseUrl || env.LLM_BASE_URL || preset.baseUrl || '').replace(/\/+$/, '');
  const model = String(opts.model || env.LLM_MODEL || preset.model || '');
  const visionRaw = String(opts.vision ?? env.LLM_VISION ?? 'auto').toLowerCase();
  const vision = visionRaw === 'auto' ? preset.vision !== false : !/^(0|false|no|off)$/.test(visionRaw);
  const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  let extraBody = {};
  if (env.LLM_EXTRA_BODY) { try { extraBody = JSON.parse(env.LLM_EXTRA_BODY); } catch { log.warn('LLM_EXTRA_BODY — не валидный JSON, игнорирую'); } }
  const cfg = {
    provider, baseUrl, apiKey, model, vision,
    temperature: num(env.LLM_TEMPERATURE, preset.temperature ?? 0.4),
    topP: env.LLM_TOP_P !== undefined ? Number(env.LLM_TOP_P) : preset.topP,
    maxTokens: num(env.LLM_MAX_TOKENS, 16000),
    timeoutMs: num(env.LLM_TIMEOUT_MS, 600000),
    concurrency: Math.max(1, num(env.LLM_CONCURRENCY, 1)),
    maxImages: num(opts.maxImages ?? env.LLM_MAX_IMAGES, 6),
    reasoningEffort: env.LLM_REASONING_EFFORT || '',
    extraBody,
  };
  const problems = [];
  if (opts.llm === false) problems.push('LLM отключена флагом --no-llm');
  else {
    if (!cfg.baseUrl) problems.push('не задан LLM_BASE_URL');
    if (!cfg.model) problems.push(`не задан LLM_MODEL (у провайдера "${provider}" нет модели по умолчанию)`);
    if (!cfg.apiKey && !preset.noKey) problems.push('не задан LLM_API_KEY');
  }
  cfg.enabled = problems.length === 0;
  cfg.problems = problems;
  return cfg;
}

export const HELP = `
site-blueprint — URL → Playwright → дизайн-система → LLM → SITE_CLONE_BLUEPRINT.md

Использование:
  node bin/site-blueprint.mjs <url> [опции]
  npm start                       (спросит ссылку)

Обход:
  -d, --depth <n>          глубина обхода ссылок (по умолч. 2)
  -p, --max-pages <n>      максимум страниц (15)
  --per-template <n>       сколько страниц одного шаблона брать, напр. /blog/* (2)
  --concurrency <n>        параллельных страниц (2)
  --viewport 1440x900      десктоп-вьюпорт; --mobile-viewport 390x844
  --no-mobile              без мобильного прохода
  --no-hover / --no-interactions   без пробы hover / вкладок / аккордеонов
  --no-assets              не скачивать картинки и шрифты
  --ignore-robots          игнорировать robots.txt (только для своих сайтов)
  --subdomains             разрешить поддомены
  --locale ru-RU           язык браузера
  --headful                показать окно браузера
  --delay <ms> (300), --timeout <ms> (45000), --max-nodes <n> (4000)
  --max-assets <n> (400), --max-asset-mb <n> (15)
  --no-sitemap / --no-cookies / --no-html

LLM (OpenAI-совместимый API, настраивается в .env):
  --provider river|zai|zai-coding|zhipu|gemini|deepseek|openrouter|openai|ollama|custom
  -m, --model <id>         напр. deepseek-ai/DeepSeek-V4.1-Flash-1017 или glm-5.3-flash
  --base-url <url>, --api-key <key>   обычно задаются в .env (LLM_BASE_URL, LLM_API_KEY)
  --vision on|off|auto     отправлять ли скриншоты в модель
  --max-images <n>         скриншотов на страницу (6)
  --no-llm                 только детерминированный блюпринт, без нейросети

Вывод:
  -o, --out <dir>          папка результатов (output)
  --lang ru|en             язык ответов LLM (ru)
  --from <dir>             пересобрать блюпринт из уже собранных данных (без обхода)
  -v, --verbose            подробный лог
`;
