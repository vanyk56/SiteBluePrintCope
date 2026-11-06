// site-blueprint extension — service worker (MV3 module). Orchestrates a capture of the user's own tab
// ("Клонировать страницу") or a polite same-origin crawl in a separate window ("Клонировать сайт"):
//   inject lib/inpage.js + content.js + inject/api-hook.js (MAIN world) → prepare → CSS → extract → snapshot →
//   full-page screenshot (scroll + captureVisibleTab + stitch in OffscreenCanvas) → interactive probes →
//   API responses (hook + Resource Timing refetch, optional reload with the hook at document_start) →
//   assets (worker fetch, then page fetch) → ZIP (format v1) → download or POST to `site-blueprint listen`.
// No anti-bot evasion: the user's real browser, real session, robots.txt respected, 1 s between pages.
import { CapturePackager } from './lib/package.js';
import { Redactor } from './lib/redact.js';
import { idbPut, idbDel, idbKeys } from './lib/idb.js';

const VERSION = chrome.runtime.getManifest().version;
const LIMITS = {
  maxNodes: 4000, snapshotBytes: 25e6, shotScreens: 14, shotMaxHeight: 16000,
  maxAssets: 400, maxAssetBytes: 15 * 1048576, maxTotalAssetBytes: 250 * 1048576, pageFetchBytes: 8 * 1048576,
  maxPagesHard: 200, maxDepthHard: 5, perTemplate: 3, chunk: 4e6, zipDownloadLimit: 1900 * 1048576,
};
const SKIP_RE = /\/(logout|log-out|signout|sign-out|wp-admin|wp-login\.php|cart|checkout|basket|my-account|account\/(delete|close)|cdn-cgi|wp-json|xmlrpc\.php|unsubscribe)(\/|$)|[?&](replytocom|share|add-to-cart|action|print|delete|remove|logout)=/i;
const NON_HTML = /\.(pdf|zip|rar|7z|gz|tar|dmg|exe|msi|apk|png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mov|mp3|wav|ogg|woff2?|ttf|otf|css|js|mjs|json|xml|txt|csv|docx?|xlsx?|pptx?|rss|atom)$/i;
const TEXTUAL = /json|graphql|text\/plain|text\/csv|x-ndjson|xml/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 300);

// ---------------------------------------------------------------- network bookkeeping (webRequest)
// per tab: in-flight requests (network-idle detection), main document status/content-type, API calls seen
const net = new Map();
const netOf = (tabId) => { let n = net.get(tabId); if (!n) { n = { inflight: new Set(), last: Date.now(), main: null, api: new Map() }; net.set(tabId, n); } return n; };
const header = (list, name) => { const h = (list || []).find((x) => x.name.toLowerCase() === name); return h ? h.value || '' : ''; };
chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0) return;
  const n = netOf(d.tabId);
  if (d.type === 'main_frame') { n.inflight.clear(); n.main = null; n.api.clear(); }
  n.inflight.add(d.requestId); n.last = Date.now();
}, { urls: ['<all_urls>'] });
chrome.webRequest.onCompleted.addListener((d) => {
  if (d.tabId < 0) return;
  const n = netOf(d.tabId); n.inflight.delete(d.requestId); n.last = Date.now();
  const ct = header(d.responseHeaders, 'content-type');
  if (d.type === 'main_frame') n.main = { url: d.url, status: d.statusCode, contentType: ct };
  else if (d.type === 'xmlhttprequest' && n.api.size < 600) n.api.set(d.method + ' ' + d.url, { url: d.url, method: d.method, status: d.statusCode, contentType: ct });
}, { urls: ['<all_urls>'] }, ['responseHeaders']);
chrome.webRequest.onErrorOccurred.addListener((d) => { const n = net.get(d.tabId); if (n) { n.inflight.delete(d.requestId); n.last = Date.now(); } }, { urls: ['<all_urls>'] });
chrome.tabs.onRemoved.addListener((id) => net.delete(id));

async function waitIdle(tabId, { quietMs = 800, timeoutMs = 10000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const n = net.get(tabId);
    if (!n || (n.inflight.size <= 1 && Date.now() - n.last >= quietMs)) return true; // ≤ 1: long-polling / SSE
    await sleep(200);
  }
  return false;
}
function waitComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let done = false; let t = null;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(t); chrome.tabs.onUpdated.removeListener(onUpd); resolve(ok); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(true); };
    chrome.tabs.onUpdated.addListener(onUpd);
    t = setTimeout(() => finish(false), timeoutMs);
  });
}
async function navigate(tabId, url) {
  const p = waitComplete(tabId);
  await chrome.tabs.update(tabId, { url });
  const ok = await p;
  await waitIdle(tabId, { quietMs: 900, timeoutMs: 8000 });
  return ok;
}
async function reloadAndWait(tabId) {
  const p = waitComplete(tabId);
  await chrome.tabs.reload(tabId, { bypassCache: false });
  const ok = await p;
  await waitIdle(tabId, { quietMs: 1000, timeoutMs: 10000 });
  return ok;
}

// ---------------------------------------------------------------- page scripting helpers
async function exec(tabId, func, args = []) {
  const res = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  const r = res && res[0];
  if (!r) throw new Error('страница не ответила (executeScript)');
  if (r.error) throw new Error(typeof r.error === 'string' ? r.error : r.error.message || 'ошибка скрипта на странице');
  return r.result;
}
const call = (tabId, method, ...args) => exec(tabId, (m, a) => {
  const c = window.__sbCapture; if (!c) throw new Error('site-blueprint: content script is not loaded');
  return c[m](...a);
}, [method, args]);
async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['inject/api-hook.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['lib/inpage.js', 'content.js'] });
}
async function pull(tabId, key) {
  const n = await call(tabId, 'size', key);
  if (n < 0) return null;
  let s = '';
  for (let i = 0; i < n; i += LIMITS.chunk) s += await call(tabId, 'slice', key, i, i + LIMITS.chunk);
  await call(tabId, 'drop', key);
  return s;
}
const HOOK_ID = 'sb-api-hook';
async function registerHook(origin) {
  const u = new URL(origin);
  await unregisterHook();
  await chrome.scripting.registerContentScripts([{ id: HOOK_ID, matches: [`${u.protocol}//${u.hostname}/*`], js: ['lib/hooks.js', 'inject/api-hook.js'], runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: false }]);
}
async function unregisterHook() { try { await chrome.scripting.unregisterContentScripts({ ids: [HOOK_ID] }); } catch (e) {} }
const hasOrigins = (origins) => chrome.permissions.contains({ origins }).catch(() => false);

// ---------------------------------------------------------------- full-page screenshot
let lastShot = 0;
async function captureVisible(windowId) {
  const wait = 600 - (Date.now() - lastShot); // Chrome allows 2 captureVisibleTab calls per second
  if (wait > 0) await sleep(wait);
  lastShot = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}
async function fullPageShot(tabId, windowId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) await chrome.tabs.update(tabId, { active: true });
  const m = await call(tabId, 'metrics');
  const vw = Math.max(1, m.vw); const vh = Math.max(200, m.vh);
  const height = Math.max(1, Math.min(m.docH, LIMITS.shotMaxHeight, LIMITS.shotScreens * vh));
  const screens = Math.max(1, Math.ceil(height / vh));
  const canvas = new OffscreenCanvas(vw, height); const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, vw, height);
  try {
    for (let i = 0; i < screens; i++) {
      const y = await call(tabId, 'shotScroll', i * vh, i);
      const t = await chrome.tabs.get(tabId);
      if (!t.active) throw new Error('вкладку переключили во время скриншота');
      const url = await captureVisible(windowId);
      const bmp = await createImageBitmap(await (await fetch(url)).blob());
      const scale = vw / bmp.width;
      g.drawImage(bmp, 0, y, vw, bmp.height * scale);
      bmp.close();
    }
  } finally { await call(tabId, 'shotRestore').catch(() => {}); }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), info: { width: vw, height, screens, dpr: m.dpr, truncated: m.docH > height + 2 } };
}

// ---------------------------------------------------------------- assets / CSS
const b64ToBytes = (s) => { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };
async function fetchInWorker(url, { credentials = 'omit', maxBytes = LIMITS.maxAssetBytes, timeoutMs = 20000 } = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { credentials, signal: ctl.signal, cache: 'force-cache', redirect: 'follow' });
    if (!r.ok) return { ok: false, status: r.status };
    if (+(r.headers.get('content-length') || 0) > maxBytes) return { ok: false, status: 413 };
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > maxBytes) return { ok: false, status: 413 };
    return { ok: true, status: r.status, contentType: r.headers.get('content-type') || '', bytes };
  } catch (e) { return { ok: false, status: 0, error: errMsg(e) }; } finally { clearTimeout(t); }
}
async function fetchAssets(job, pk, tabId, list, pageOrigin, slug) {
  const uniq = new Map(); for (const a of list) if (a && a.url && !uniq.has(a.url)) uniq.set(a.url, a);
  const todo = [...uniq.values()].filter((a) => !pk.hasAsset(a.url) && !job.assetFailed.has(a.url)).slice(0, Math.max(0, LIMITS.maxAssets - pk.assets.length));
  let i = 0; let got = 0;
  const worker = async () => {
    while (i < todo.length) {
      const a = todo[i++];
      if (job.cancelled || pk.assetBytes > LIMITS.maxTotalAssetBytes) return;
      const same = new URL(a.url).origin === pageOrigin;
      let r = await fetchInWorker(a.url, { credentials: same ? 'include' : 'omit' });
      if (!r.ok && r.status === 0) { // CORS / no host permission → the same request from the page itself
        const p = await call(tabId, 'fetchAsset', a.url, { maxBytes: LIMITS.pageFetchBytes }).catch(() => null);
        if (p && p.ok) r = { ok: true, contentType: p.contentType, bytes: b64ToBytes(p.b64) };
      }
      if (r.ok && r.bytes.length && !/^text\/html/i.test(r.contentType)) { if (await pk.addAsset({ url: a.url, contentType: r.contentType, bytes: r.bytes, page: slug, kind: a.kind })) got++; }
      else job.assetFailed.add(a.url);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { requested: todo.length, saved: got };
}

// ---------------------------------------------------------------- API entries
const redactor = new Redactor({ enabled: true });
function cleanApi(entries, slug, seen) {
  const out = [];
  for (const e of entries || []) {
    if (!e || !e.url || !/^https?:/i.test(e.url)) continue;
    const key = (e.method || 'GET') + ' ' + e.url + ' ' + (e.requestBody || '');
    if (seen.has(key)) continue;
    seen.add(key);
    let body = e.body == null ? '' : String(e.body);
    if (/json|graphql/i.test(e.contentType || '') || /^\s*[[{]/.test(body)) { try { body = JSON.stringify(redactor.json(JSON.parse(body))); } catch (x) { body = redactor.text(body); } }
    else body = redactor.text(body);
    let reqBody = e.requestBody == null ? null : String(e.requestBody);
    if (reqBody) { try { reqBody = JSON.stringify(redactor.json(JSON.parse(reqBody))); } catch (x) { reqBody = redactor.text(reqBody); } }
    out.push({ url: redactor.url(e.url), method: String(e.method || 'GET').toUpperCase(), status: +e.status || 200, contentType: e.contentType || '', requestHeaders: redactor.headers(e.requestHeaders || {}), requestBody: reqBody, body, encoding: 'utf8', resourceType: e.resourceType || 'fetch', page: slug, refetched: !!e.refetched, ts: e.ts || Date.now() });
  }
  return out;
}

// ---------------------------------------------------------------- one page
const slugOf = (u) => { try { const x = new URL(u); const p = decodeURIComponent(x.pathname).replace(/^\/+|\/+$/g, ''); return (p ? p.replace(/\//g, '__') : 'index') + (x.search ? '_q' + Math.abs([...x.search].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)).toString(36).slice(0, 6) : ''); } catch (e) { return 'page'; } };
async function capturePage(job, pk, tabId, windowId, { depth = 0, from = null, o }) {
  const t0 = Date.now(); const warnings = [];
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url; const origin = new URL(url).origin;
  const step = (s) => setStage(job, s, url);
  step('Подключение к странице');
  await inject(tabId);
  step('Подготовка: lazy-load, прокрутка, шрифты, анимации');
  await call(tabId, 'prepare', { scroll: true });
  step('Стили');
  const cssMeta = await call(tabId, 'css');
  const extraCss = [];
  for (const c of cssMeta.filter((x) => x.blocked).slice(0, 40)) {
    const r = await fetchInWorker(c.url, { maxBytes: 6e6 });
    if (r.ok) { const text = new TextDecoder().decode(r.bytes); extraCss.push({ href: c.url, text }); }
    else warnings.push('CSS недоступен: ' + c.url.slice(0, 160));
  }
  if (extraCss.length) await call(tabId, 'provideCss', extraCss);
  step('DOM со стилями');
  const ex = await call(tabId, 'extract', { maxNodes: LIMITS.maxNodes, html: true });
  if (!ex || ex.error) throw new Error('не удалось извлечь DOM: ' + ((ex && ex.error) || '?'));
  if (ex.truncated) warnings.push(`страница большая: взято ${ex.nodes} узлов`);
  step('Автономный HTML-снимок');
  const sn = await call(tabId, 'snapshot', { maxBytes: LIMITS.snapshotBytes }).catch((e) => ({ error: errMsg(e) }));
  if (sn && sn.error) warnings.push('снимок: ' + sn.error);
  await call(tabId, 'meta').catch(() => null);
  step('Скриншот всей страницы');
  let shot = null;
  try { shot = await fullPageShot(tabId, windowId); }
  catch (e) { warnings.push('скриншот: ' + errMsg(e)); }
  let state = null;
  if (o.state) {
    step('Интерактивный стейт: вкладки, фильтры, аккордеоны, модалки');
    state = await call(tabId, 'probe', { budgetMs: 20000 }).catch((e) => { warnings.push('стейт: ' + errMsg(e)); return null; });
  }
  step('Данные страницы');
  const slugBase = slugOf(ex.url || url);
  const raw = await pull(tabId, 'raw');
  const snapshot = sn && !sn.error ? await pull(tabId, 'snapshot') : null;
  const stateJson = state ? await pull(tabId, 'state') : null;
  const trackers = await pull(tabId, 'trackers');
  const hydration = await pull(tabId, 'hydration');
  const cssJson = await pull(tabId, 'css');
  // the slug inside the ZIP is only a file name; the CLI recomputes its own slugs
  const pageSlug = pk.uniqueSlug(slugBase); pk.slugs.delete(pageSlug);
  if (o.api) {
    step('API-ответы');
    const got = await call(tabId, 'drainApi').catch(() => []);
    const seenUrls = [...job.apiSeen].map((k) => k.split(' ')[1]);
    const candidates = await call(tabId, 'apiCandidates', [...seenUrls, ...(got || []).map((e) => e.url)]).catch(() => []);
    const fromNet = [...((net.get(tabId) || {}).api || new Map()).values()].filter((x) => x.method === 'GET' && x.status >= 200 && x.status < 300 && TEXTUAL.test(x.contentType) && new URL(x.url).origin === origin).map((x) => x.url);
    const want = [...new Set([...candidates, ...fromNet])].filter((u) => !(got || []).some((e) => e.url === u)).slice(0, 60);
    const refetched = want.length ? await call(tabId, 'refetch', want).catch(() => []) : [];
    pk.addApi(cleanApi([...(got || []), ...refetched], pageSlug, job.apiSeen));
    const posts = [...((net.get(tabId) || {}).api || new Map()).values()].filter((x) => x.method !== 'GET').length;
    if (posts && !o.reload) warnings.push(`${posts} не-GET запрос(ов) до начала захвата: их тела доступны только с перезагрузкой (разреши доступ к сайту)`);
  }
  step('Картинки, шрифты, медиа');
  const assets = [...(ex.assets || []), ...((sn && sn.resources) || []).filter((r) => /^(images|fonts|icons|media)$/.test(r.kind))];
  const as = await fetchAssets(job, pk, tabId, assets, origin, pageSlug);
  for (const c of JSON.parse(cssJson || '[]')) await pk.addCss({ url: c.url, text: c.text, page: pageSlug });
  for (const c of extraCss) await pk.addCss({ url: c.href, text: c.text, page: pageSlug });
  await call(tabId, 'finish').catch(() => {});
  const rec = await pk.addPage({
    slug: pageSlug, url, finalUrl: ex.url || url, title: ex.title || tab.title || '', depth, from, raw, snapshot,
    screenshot: shot ? shot.bytes : null, screenshotInfo: shot ? shot.info : null, state: stateJson, trackers, hydration, ms: Date.now() - t0, warnings,
  });
  job.warnings.push(...warnings.map((w) => `${rec.slug}: ${w}`));
  log(job, `✓ ${rec.slug}: ${ex.nodes} узлов, ассетов ${as.saved}/${as.requested}${shot ? ', скриншот ' + shot.info.width + '×' + shot.info.height : ''}${state ? `, стейт: вкладки ${state.tabGroups}, модалки ${state.dialogs}, раскрытия ${state.expand}` : ''}`);
  return { slug: rec.slug, links: ex.links || [] };
}

// ---------------------------------------------------------------- robots.txt (site crawl)
async function loadRobots(origin) {
  let text = ''; let status = 0;
  try { const r = await fetch(origin + '/robots.txt', { credentials: 'omit', redirect: 'follow' }); status = r.status; if (r.ok) text = (await r.text()).slice(0, 500000); } catch (e) {}
  const groups = []; let cur = null; let agentLine = false;
  for (const line0 of text.split(/\r?\n/)) {
    const line = line0.replace(/#.*/, '').trim(); if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line); if (!m) continue;
    const k = m[1].toLowerCase(); const v = m[2].trim();
    if (k === 'user-agent') { if (!cur || !agentLine) { cur = { agents: [], rules: [], delay: 0 }; groups.push(cur); } cur.agents.push(v.toLowerCase()); agentLine = true; continue; }
    agentLine = false; if (!cur) continue;
    if ((k === 'allow' || k === 'disallow') && v) cur.rules.push({ allow: k === 'allow', path: v });
    else if (k === 'crawl-delay') cur.delay = parseFloat(v) || 0;
  }
  const g = groups.find((x) => x.agents.some((a) => a.includes('site-blueprint'))) || groups.find((x) => x.agents.includes('*'));
  const toRe = (p) => { const end = p.endsWith('$'); const body = (end ? p.slice(0, -1) : p).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'); return new RegExp('^' + body + (end ? '$' : '')); };
  const rules = g ? g.rules.map((r) => ({ ...r, re: toRe(r.path) })) : [];
  return {
    status, delay: g ? g.delay : 0, rules: rules.length,
    allowed(u) {
      let x; try { x = new URL(u); } catch (e) { return false; }
      const p = x.pathname + x.search; let best = null;
      for (const r of rules) if (r.re.test(p) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
      return !best || best.allow;
    },
  };
}
function normalizeUrl(u) { try { const x = new URL(u); x.hash = ''; if (/^https?:$/.test(x.protocol)) return x.href; } catch (e) {} return null; }
function templateKey(u) {
  const x = new URL(u); const segs = x.pathname.split('/').filter(Boolean);
  return segs.length <= 1 ? x.pathname : segs[0] + '/*' + segs.length;
}

// ---------------------------------------------------------------- jobs
let job = null;
const pub = (j) => j && ({ id: j.id, mode: j.mode, status: j.status, stage: j.stage, url: j.url, pages: j.pages, log: j.log.slice(-14), warnings: j.warnings.slice(-20), result: j.result, error: j.error, startedAt: j.startedAt, finishedAt: j.finishedAt });
let saveTimer = null;
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(() => chrome.storage.session.set({ job: pub(job) }).catch(() => {}), 150); }
function setStage(j, stage, url) { j.stage = stage; if (url) j.url = url; persist(); if (j.cancelled) throw new Error('отменено'); }
function log(j, line) { j.log.push(line); if (j.log.length > 200) j.log.shift(); persist(); }

async function startJob({ mode, tabId, options }) {
  if (job && job.status === 'running') throw new Error('уже идёт захват — дождись окончания или отмени');
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:\/\//i.test(tab.url || '') || /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/.test(tab.url)) throw new Error('эту страницу нельзя захватить (нужен обычный http/https-сайт)');
  const o = {
    api: options.api !== false, state: options.state !== false, delivery: options.delivery === 'cli' ? 'cli' : 'zip',
    maxPages: Math.max(1, Math.min(LIMITS.maxPagesHard, +options.maxPages || 10)), depth: Math.max(1, Math.min(LIMITS.maxDepthHard, +options.depth || 2)),
    robots: options.robots !== false, port: Math.max(1, Math.min(65535, +options.port || 3005)), token: String(options.token || ''), delayMs: Math.max(1000, +options.delayMs || 1000),
    reload: !!options.reload,
  };
  job = { id: Date.now().toString(36), mode: mode === 'site' ? 'site' : 'page', status: 'running', stage: 'Старт', url: tab.url, pages: { done: 0, total: mode === 'site' ? o.maxPages : 1 }, log: [], warnings: [], result: null, error: null, startedAt: Date.now(), finishedAt: null, cancelled: false, apiSeen: new Set(), assetFailed: new Set() };
  const j = job;
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  (async () => {
    const origin = new URL(tab.url).origin;
    const pk = new CapturePackager({ mode: j.mode, origin, start: normalizeUrl(tab.url), extension: { name: 'site-blueprint', version: VERSION }, userAgent: navigator.userAgent, options: { api: o.api, state: o.state, robots: o.robots, maxPages: o.maxPages, depth: o.depth, reload: o.reload } });
    try {
      if (j.mode === 'page') await runPage(j, pk, tab, o);
      else await runSite(j, pk, tab, o);
      setStage(j, 'Упаковка ZIP');
      const skipped = j.skipped || [];
      const { blob, manifest } = await pk.finish({ warnings: j.warnings.slice(0, 200), skipped });
      const host = new URL(origin).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]+/gi, '-');
      const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
      const filename = `site-blueprint/${host}-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}-${j.mode}.zip`;
      log(j, `ZIP: ${(blob.size / 1048576).toFixed(1)} МБ, страниц ${manifest.counts.pages}, ассетов ${manifest.counts.assets}, API ${manifest.counts.api}`);
      if (o.delivery === 'cli') {
        try { j.result = await sendToCli(j, blob, filename, o); }
        catch (e) { log(j, '⚠ CLI недоступен (' + errMsg(e) + ') — сохраняю ZIP'); j.result = await downloadZip(j, blob, filename); j.result.cliError = errMsg(e); }
      } else j.result = await downloadZip(j, blob, filename);
      j.status = 'done'; j.stage = 'Готово';
    } catch (e) {
      j.status = j.cancelled ? 'cancelled' : 'error'; j.error = errMsg(e); j.stage = j.cancelled ? 'Отменено' : 'Ошибка';
    } finally {
      clearInterval(keepAlive); j.finishedAt = Date.now(); await unregisterHook(); persist();
    }
  })();
  persist();
  return pub(j);
}

async function runPage(j, pk, tab, o) {
  const r = await capturePage(j, pk, tab.id, tab.windowId, { depth: 0, o });
  j.pages.done = 1;
  // second pass: reload with the hook installed at document_start → requests made while the page loads (POST/GraphQL)
  const u = new URL(tab.url);
  if (o.api && o.reload && (await hasOrigins([`${u.protocol}//${u.hostname}/*`]))) {
    setStage(j, 'Перезагрузка вкладки для полного захвата API');
    await registerHook(u.origin);
    try {
      await reloadAndWait(tab.id);
      await inject(tab.id);
      await call(tab.id, 'prepare', { scroll: true, budgetMs: 15000 });
      await waitIdle(tab.id, { quietMs: 1200, timeoutMs: 10000 });
      const got = await call(tab.id, 'drainApi');
      const add = cleanApi(got, r.slug, j.apiSeen);
      pk.addApi(add);
      log(j, `API после перезагрузки: +${add.length}`);
      await call(tab.id, 'finish').catch(() => {});
    } catch (e) { j.warnings.push('перезагрузка для API: ' + errMsg(e)); }
    finally { await unregisterHook(); }
  }
}

async function runSite(j, pk, srcTab, o) {
  const origin = new URL(srcTab.url).origin;
  if (!(await hasOrigins(['<all_urls>']))) throw new Error('для обхода сайта нужно разрешение «доступ к сайтам» (скриншоты страниц в отдельном окне)');
  const robots = o.robots ? await loadRobots(origin) : null;
  const start = normalizeUrl(srcTab.url);
  if (robots && !robots.allowed(start)) throw new Error('robots.txt запрещает обход этой страницы. Если это твой сайт — сними галочку «Учитывать robots.txt»');
  if (robots) log(j, `robots.txt: ${robots.status === 200 ? robots.rules + ' правил' + (robots.delay ? ', crawl-delay ' + robots.delay + ' с' : '') : 'нет (' + robots.status + ')'}`);
  const delay = Math.max(o.delayMs, robots && robots.delay ? Math.min(10, robots.delay) * 1000 : 0);
  if (o.api) await registerHook(origin);
  const src = await chrome.windows.get(srcTab.windowId);
  // same size as the user's window → the same viewport/breakpoints as the page the crawl started from
  let win;
  try { win = await chrome.windows.create({ url: 'about:blank', focused: true, type: 'normal', width: src.width, height: src.height }); }
  catch (e) { win = await chrome.windows.create({ url: 'about:blank', focused: true, type: 'normal' }); }
  const tabId = win.tabs[0].id;
  j.skipped = [];
  const queue = []; const seen = new Set(); const finals = new Set(); const tpl = new Map(); let order = 0;
  const enqueue = (u, depth, prio, from) => {
    const url = normalizeUrl(u); if (!url || seen.has(url)) return;
    seen.add(url);
    const x = new URL(url);
    if (x.origin !== origin || NON_HTML.test(x.pathname) || SKIP_RE.test(url)) return;
    if (robots && !robots.allowed(url)) { j.skipped.push({ url, reason: 'robots.txt' }); return; }
    queue.push({ url, depth, prio, from, order: order++ });
  };
  enqueue(start, 0, -1, null);
  try {
    while (queue.length && pk.pages.length < o.maxPages) {
      if (j.cancelled) throw new Error('отменено');
      queue.sort((a, b) => a.depth - b.depth || a.prio - b.prio || a.order - b.order);
      const it = queue.shift();
      const key = templateKey(it.url);
      if (it.depth > 0 && (tpl.get(key) || 0) >= LIMITS.perTemplate) { j.skipped.push({ url: it.url, reason: 'шаблон ' + key }); continue; }
      tpl.set(key, (tpl.get(key) || 0) + 1);
      setStage(j, `Страница ${pk.pages.length + 1}/${o.maxPages}: загрузка`, it.url);
      const ok = await navigate(tabId, it.url);
      const tab = await chrome.tabs.get(tabId);
      const finalUrl = normalizeUrl(tab.url);
      const main = (net.get(tabId) || {}).main;
      if (!ok) { j.skipped.push({ url: it.url, reason: 'таймаут загрузки' }); continue; }
      if (!finalUrl || new URL(finalUrl).origin !== origin) { j.skipped.push({ url: it.url, reason: 'редирект на другой сайт' }); continue; }
      if (main && main.contentType && !/html|xml/i.test(main.contentType)) { j.skipped.push({ url: it.url, reason: 'не HTML: ' + main.contentType }); continue; }
      if (main && main.status >= 400 && it.depth > 0) { j.skipped.push({ url: it.url, reason: 'HTTP ' + main.status }); continue; }
      if (finals.has(finalUrl)) { j.skipped.push({ url: it.url, reason: 'дубль после редиректа' }); continue; }
      finals.add(finalUrl);
      try {
        const r = await capturePage(j, pk, tabId, win.id, { depth: it.depth, from: it.from, o });
        j.pages.done = pk.pages.length;
        if (it.depth < o.depth) for (const l of r.links) enqueue(l.href, it.depth + 1, l.area === 'header' || l.area === 'nav' ? 0 : l.area === 'footer' ? 2 : 1, r.slug);
      } catch (e) {
        if (j.cancelled) throw e;
        if (it.depth === 0) throw e;
        j.skipped.push({ url: it.url, reason: errMsg(e) }); log(j, '⚠ ' + it.url + ': ' + errMsg(e));
      }
      if (queue.length && pk.pages.length < o.maxPages) await sleep(delay);
    }
  } finally {
    await chrome.windows.remove(win.id).catch(() => {});
    await unregisterHook();
  }
  if (!pk.pages.length) throw new Error('ни одна страница не захвачена');
}

// ---------------------------------------------------------------- delivery
const downloads = new Map(); // capture id → resolve
async function downloadZip(j, blob, filename) {
  if (blob.size > LIMITS.zipDownloadLimit) throw new Error('ZIP больше 1.9 ГБ — уменьши число страниц');
  setStage(j, 'Сохранение ZIP');
  const id = 'cap-' + j.id;
  await idbPut(id, { blob, filename, createdAt: Date.now() });
  const done = new Promise((resolve) => { downloads.set(id, resolve); setTimeout(() => resolve({ ok: false, error: 'таймаут сохранения' }), 10 * 60000); });
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('download.html?id=' + encodeURIComponent(id)), active: false });
  const r = await done;
  downloads.delete(id);
  chrome.tabs.remove(tab.id).catch(() => {});
  if (!r.ok) { await idbDel(id).catch(() => {}); throw new Error('ZIP не сохранён: ' + (r.error || '?')); }
  log(j, '✓ ZIP сохранён: ' + (r.file || filename));
  return { kind: 'zip', filename: r.file || filename, bytes: blob.size, hint: 'node bin/site-blueprint.mjs import "' + (r.file || filename) + '"' };
}
async function cliFetch(o, path, init = {}) {
  const headers = { 'X-SB-Client': 'site-blueprint-extension/' + VERSION, ...(o.token ? { 'X-SB-Token': o.token } : {}), ...(init.headers || {}) };
  const r = await fetch(`http://127.0.0.1:${o.port}${path}`, { ...init, headers, credentials: 'omit' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 202) throw new Error(data.error || 'HTTP ' + r.status);
  return data;
}
async function sendToCli(j, blob, filename, o) {
  setStage(j, `Отправка в CLI (127.0.0.1:${o.port})`);
  const accepted = await cliFetch(o, '/capture', { method: 'POST', body: blob, headers: { 'Content-Type': 'application/zip', 'X-SB-Filename': filename.split('/').pop() } });
  log(j, `CLI принял захват: задача ${accepted.id}`);
  const t0 = Date.now();
  for (;;) {
    await sleep(2000);
    let s;
    try { s = await cliFetch(o, '/jobs/' + accepted.id); } catch (e) { if (Date.now() - t0 > 60000) throw e; continue; }
    j.stage = s.status === 'queued' ? `CLI: в очереди (${s.position})` : s.stage === 'import' ? 'CLI: импорт захвата' : s.stage === 'pipeline' ? 'CLI: анализ, проект, LLM, сборка…' : 'CLI: ' + s.status;
    persist();
    if (s.status === 'done' || s.status === 'failed' || s.status === 'error') {
      if (s.status === 'error') throw Object.assign(new Error('CLI: ' + (s.error || 'ошибка')), { cli: true });
      log(j, (s.status === 'done' ? '✓ ' : '⚠ ') + 'CLI: ' + (s.outDir || ''));
      return { kind: 'cli', cliJob: s.id, status: s.status, outDir: s.outDir, project: s.project, blueprint: s.blueprint, error: s.error || null, bytes: blob.size };
    }
    if (Date.now() - t0 > 60 * 60000) return { kind: 'cli', cliJob: accepted.id, status: 'running', note: 'CLI ещё работает — смотри его консоль', bytes: blob.size };
  }
}

// ---------------------------------------------------------------- messages from popup / download page
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || sender.id !== chrome.runtime.id) return false;
  if (msg.type === 'sb:start') { startJob(msg).then((j) => sendResponse({ ok: true, job: j }), (e) => sendResponse({ ok: false, error: errMsg(e) })); return true; }
  if (msg.type === 'sb:pick') {
    (async () => {
      await inject(msg.tabId);
      await call(msg.tabId, 'startPicker');
    })().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: errMsg(e) }));
    return true;
  }
  if (msg.type === 'sb:status') { if (job) sendResponse({ ok: true, job: pub(job) }); else chrome.storage.session.get('job').then((s) => sendResponse({ ok: true, job: s.job && s.job.status === 'running' ? { ...s.job, status: 'error', error: 'работа расширения была прервана браузером — запусти захват ещё раз' } : s.job || null })); return true; }
  if (msg.type === 'sb:cancel') { if (job && job.status === 'running') job.cancelled = true; sendResponse({ ok: true }); return false; }
  if (msg.type === 'sb:downloaded') { const r = downloads.get(msg.id); if (r) r(msg); sendResponse({ ok: true }); return false; }
  return false;
});
// leftovers of interrupted downloads
chrome.runtime.onStartup.addListener(async () => { for (const k of await idbKeys().catch(() => [])) await idbDel(k).catch(() => {}); });
