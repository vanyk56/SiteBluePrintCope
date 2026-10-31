import fs from 'node:fs';
import { chromium } from 'playwright';
import { log } from './log.mjs';

// Trackers, ad networks, chat widgets and cookie-consent SDKs — blocked at network level.
const BLOCK_HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'analytics.google.com', 'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'connect.facebook.net', 'facebook.com/tr', 'mc.yandex.ru', 'mc.yandex.com', 'mc.webvisor', 'top-fwz1.mail.ru', 'vk.com/rtrg', 'an.yandex.ru', 'adfox.ru',
  'hotjar.com', 'clarity.ms', 'segment.io', 'cdn.segment.com', 'mixpanel.com', 'amplitude.com', 'fullstory.com', 'heapanalytics.com', 'heap.io',
  'intercom.io', 'intercomcdn.com', 'crisp.chat', 'tawk.to', 'jivosite.com', 'code.jivo.ru', 'livechatinc.com', 'js.driftt.com', 'zdassets.com', 'carrotquest',
  'snap.licdn.com', 'ads.linkedin.com', 'analytics.tiktok.com', 'static.ads-twitter.com', 'criteo.', 'taboola.com', 'outbrain.com', 'quantserve.com', 'scorecardresearch.com',
  'cdn.cookielaw.org', 'onetrust.com', 'cookiebot.com', 'usercentrics.eu', 'cookieyes.com', 'termly.io', 'iubenda.com', 'trustarc.com', 'consentmanager.net',
  'js-agent.newrelic.com', 'nr-data.net', 'browser.sentry-cdn.com', 'sentry.io/api', 'bugsnag.com', 'datadoghq-browser-agent', 'js.hs-analytics.net', 'js.hs-scripts.com',
  'plausible.io/js', 'posthog.com', 'matomo.', 'piwik.', 'yandex.ru/metrika', 'roistat', 'calltouch', 'comagic',
];
export const BLOCK_RE = new RegExp(BLOCK_HOSTS.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

const SYSTEM_BROWSERS = [
  '/usr/local/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

export async function launchBrowser(opts) {
  const base = { headless: !opts.headful };
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

export async function newContext(browser, { width, height, mobile, locale }) {
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
  await ctx.route(BLOCK_RE, (route) => route.abort().catch(() => {}));
  return ctx;
}
