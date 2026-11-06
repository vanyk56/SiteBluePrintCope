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
        if (!m || process.env[m[1]] !== undefined) continue;
        const q = /^(['"])(.*)\1$/.exec(m[2]);
        process.env[m[1]] = q ? q[2] : m[2].replace(/(^|\s+)#.*$/, ''); // unquoted: "value   # comment" → "value"
      }
    }
  }
}

// OpenAI-compatible providers. Model defaults only where verified (Z.ai GLM-5.3-Flash is multimodal).
export const PROVIDERS = {
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
  llm: true, lang: 'ru', verbose: false, locale: '', zip: true,
  // v2: API sniffer, snapshots, plugins, self-healing build + visual regression, extension server
  api: true, redact: true, maxMocks: 250, snapshot: true, blockTrackers: true, catalogTools: false,
  verify: true, visual: true, healIterations: 4, deps: 'shared', threshold: 0.1, minSimilarity: 0.85,
  port: 3005, host: '127.0.0.1', maxUploadMb: 300, offline: false, visualHeal: true,
};
const BOOL = new Set(['mobile', 'hover', 'interactions', 'robots', 'subdomains', 'sitemap', 'cookies', 'headful', 'llm', 'verbose', 'help', 'assets', 'ignoreRobots', 'version', 'html', 'zip', 'api', 'redact', 'snapshot', 'blockTrackers', 'verify', 'visual', 'visualHeal', 'build', 'catalogTools', 'strict', 'offline', 'keepIncoming', 'interactive']);
const NUM = new Set(['depth', 'maxPages', 'perTemplate', 'concurrency', 'delay', 'timeout', 'maxNodes', 'maxAssets', 'maxAssetMb', 'maxImages', 'maxMocks', 'healIterations', 'threshold', 'minSimilarity', 'failUnder', 'port', 'assetRetries', 'assetConcurrency', 'maxUploadMb']);
const ALIASES = { d: 'depth', p: 'maxPages', o: 'out', m: 'model', h: 'help', v: 'verbose', i: 'interactive' };

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
  const provider = String(opts.provider || env.LLM_PROVIDER || 'zai').toLowerCase();
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
site-blueprint 2 — сайт (URL или захват расширения) → дизайн-система → Next.js-проект → LLM → SITE_CLONE_BLUEPRINT.md → самопроверка

Команды:
  site-blueprint <url> [опции]           обойти сайт (Playwright) и собрать всё; npm start — спросит ссылку
  site-blueprint --from <папка>          пересобрать из прошлого запуска (без обхода)
  site-blueprint import <capture.zip>    захват из браузерного расширения (ZIP или распакованная папка)
  site-blueprint listen [--port 3005]    приёмник для расширения («Отправить в локальный CLI»), только 127.0.0.1
  site-blueprint heal <папка>            собрать project/ и исправить ошибки сборки (правила + LLM-патчи), без обхода
  site-blueprint verify <папка> --url http://localhost:3000   сверить запущенный клон с оригиналом
  site-blueprint pick <папка> [запрос]   извлечь отдельный React+Tailwind компонент (.tsx) по типу/имени/индексу
  site-blueprint mcp                     запустить MCP-сервер (stdio) для Cursor / Claude Code / Windsurf

Обход:
  -d, --depth <n>          глубина обхода ссылок (по умолч. 2)
  -p, --max-pages <n>      максимум страниц (15)
  --per-template <n>       сколько страниц одного шаблона брать, напр. /blog/* (2)
  --concurrency <n>        параллельных страниц (2)
  --viewport 1440x900      десктоп-вьюпорт; --mobile-viewport 390x844
  --no-mobile              без мобильного прохода
  --no-hover / --no-interactions   без пробы hover / вкладок / аккордеонов / модалок
  --no-assets              не скачивать картинки и шрифты
  --ignore-robots          игнорировать robots.txt (только для своих сайтов)
  --subdomains             разрешить поддомены
  --locale ru-RU           язык браузера
  --headful                показать окно браузера
  --browser-path <exe>     свой Chrome/Chromium (или BROWSER_PATH в .env); --channel chrome|msedge
  --delay <ms> (300), --timeout <ms> (45000), --max-nodes <n> (4000)
  --max-assets <n> (400), --max-asset-mb <n> (15), --asset-retries <n> (3)
  --no-sitemap / --no-cookies / --no-html
  --no-block-trackers      не блокировать трекеры при обходе (по умолч. блокируются; в клон они не попадают никогда)
  --plugin <file.mjs,…>    плагины-хуки: beforeStart, beforeRequest, afterResponse, beforeExtract, afterExtract,
                           generateFilename, onAssetSaved, onAssetError, beforeWrite, afterProject, afterFinish, error
                           (пример: examples/plugin-example.mjs); также SB_PLUGINS в .env

Захват данных:
  --no-api                 не записывать XHR/fetch-ответы и не создавать мок-API (app/api/[...route])
  --max-mocks <n>          лимит мок-ответов (250)
  --no-redact              не маскировать токены и персональные данные в моках (только для своих тестовых данных!)
  --no-snapshot            без автономных HTML-снимков snapshots/*.html
  --catalog-tools          добавить в каталог панель поиска/сортировки (её нет в оригинале — по умолчанию выкл.)

LLM (OpenAI-совместимый API, настраивается в .env):
  --provider zai|zai-coding|zhipu|gemini|deepseek|openrouter|openai|ollama|custom
                           любой другой сервис (в т.ч. River AI, vLLM, LM Studio, прокси) — custom + --base-url
  -m, --model <id>         напр. glm-5.3-flash
  --base-url <url>, --api-key <key>   обычно задаются в .env (LLM_BASE_URL, LLM_API_KEY)
  --vision on|off|auto     отправлять ли скриншоты в модель
  --max-images <n>         скриншотов на страницу (6)
  --no-llm                 без нейросети: детерминированный блюпринт, исправления сборки только правилами

Самопроверка после генерации (включена по умолчанию):
  --no-verify              не собирать project/
  --deps shared|local|skip node_modules: общие рядом с результатами (shared), в project/ (local), не ставить (skip)
  --heal-iterations <n>    итераций «next build → исправления» (4)
  --no-visual              без next start и визуальной регрессии (pixelmatch)
  --threshold <0..1>       чувствительность сравнения пикселей (0.1)
  --min-similarity <0..1>  порог сходства для отчёта (0.85)
  --strict                 код выхода 3, если сборка не прошла или сходство ниже порога

Расширение (listen / import):
  --port <n>               порт listen (3005)
  --token <строка>         общий секрет, расширение присылает его в X-SB-Token (или SB_LISTEN_TOKEN в .env)
  --max-upload-mb <n>      лимит размера захвата (300)
  --allow-origin <origin>  дополнительно разрешённый Origin (по умолч. только chrome-extension:// и moz-extension://)
  --keep-incoming          не удалять принятые ZIP из <out>/_incoming
  --offline                не докачивать ассеты, которых нет в захвате

Вывод:
  -o, --out <dir>          папка результатов (output)
  --lang ru|en             язык ответов LLM (ru)
  --no-zip                 не собирать архив <папка>.zip для ИИ-кодера
  -v, --verbose            подробный лог;  --version — версия

Сверка запущенного клона (verify):
  --url <адрес клона>      по умолч. http://localhost:3000
  --routes /,/pricing      только эти маршруты; --no-mobile — только десктоп
`;
