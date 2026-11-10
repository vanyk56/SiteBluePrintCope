import fs from 'node:fs';
import { chromium } from 'playwright';
import { log } from './log.mjs';

// Trackers, ad networks, chat widgets and cookie-consent SDKs are blocked at network level (list: sanitize/trackers.mjs).
import { BLOCK_RE } from './sanitize/trackers.mjs';
import { installHooks } from './inpage/hooks.mjs';
export { BLOCK_RE };

const SYSTEM_BROWSERS = [
  '/usr/local/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** --proxy http://user:pass@host:3128 (or SB_PROXY) → Playwright proxy settings; null when not set / invalid */
export function proxySettings(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  let u; try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : 'http://' + v); } catch { return null; }
  if (!/^(https?|socks[45]?):$/.test(u.protocol) || !u.hostname) return null;
  const p = { server: `${u.protocol}//${u.host}`, bypass: process.env.NO_PROXY || process.env.no_proxy || undefined };
  if (u.username) { p.username = decodeURIComponent(u.username); p.password = decodeURIComponent(u.password || ''); }
  return p;
}

export async function launchBrowser(opts) {
  const base = { headless: !opts.headful };
  const rawProxy = opts.proxy || process.env.SB_PROXY;
  const proxy = proxySettings(rawProxy);
  if (rawProxy && !proxy) log.warn('Некорректный адрес прокси (--proxy / SB_PROXY) — игнорирую. Пример: http://user:pass@host:3128');
  if (proxy) { base.proxy = proxy; log.info(`Прокси браузера: ${proxy.server}`); }
  const explicit = opts.browserPath || process.env.BROWSER_PATH;
  if (explicit) return chromium.launch({ ...base, executablePath: explicit });
  if (opts.channel) return chromium.launch({ ...base, channel: opts.channel });
  try { return await chromium.launch(base); }
  catch (e) {
    if (!/Executable doesn't exist|executable|install/i.test(String(e.message))) throw e;
    for (const p of SYSTEM_BROWSERS) {
      if (fs.existsSync(p)) { log.warn(`Chromium от Playwright не установлен — использую ${p}`); return chromium.launch({ ...base, executablePath: p }); }
    }
    for (const channel of ['chrome', 'msedge']) {
      try { const b = await chromium.launch({ ...base, channel }); log.warn(`Использую установленный ${channel}`); return b; } catch {}
    }
    throw new Error('Браузер не найден. Выполни: npx playwright install chromium (или укажи BROWSER_PATH в .env)');
  }
}

export async function newContext(browser, { width, height, mobile, locale, hooks = null, blockTrackers = true, onBlocked = null, initHooks = true }) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: !!mobile,
    hasTouch: !!mobile,
    userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' : undefined,
    bypassCSP: true,
    ignoreHTTPSErrors: true,
    locale: locale || undefined,
  });
  // observation hooks (closed shadow roots, WebGL buffer, JS FontFace) — see inpage/hooks.mjs
  if (initHooks) await ctx.addInitScript(installHooks);
  // plugins may veto or decorate requests (website-scraper "beforeRequest" action); registered first so the
  // tracker block below (registered later = consulted first by Playwright) still wins
  if (hooks && hooks.has('beforeRequest')) {
    await ctx.route('**/*', async (route) => {
      const req = route.request();
      const r = await hooks.first('beforeRequest', { url: req.url(), method: req.method(), resourceType: req.resourceType(), headers: req.headers() });
      if (r && r.abort) return route.abort().catch(() => {});
      if (r && r.headers) return route.continue({ headers: { ...req.headers(), ...r.headers } }).catch(() => {});
      return route.fallback().catch(() => {});
    });
  }
  if (blockTrackers) await ctx.route(BLOCK_RE, (route) => { try { if (onBlocked) onBlocked(route.request().url()); } catch {} return route.abort().catch(() => {}); });
  return ctx;
}
