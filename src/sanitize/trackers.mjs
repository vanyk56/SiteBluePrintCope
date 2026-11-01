// Tracker, ad, call-tracking and chat-widget catalogue (pipeline of the AI Website Cloner Template:
// nothing of this may end up in the clone). Used for: request blocking during the crawl, DOM/HTML cleanup,
// API-sniffer filtering and the "what was removed" report in the blueprint.
//   hosts  — substrings of URL host+path;  inline — signatures inside inline <script>;  id — counter id extraction.
export const TRACKERS = [
  { id: 'gtm', name: 'Google Tag Manager', hosts: ['googletagmanager.com'], inline: [/googletagmanager\.com\/(gtm|ns)\.|['"]gtm\.start['"]/, /dataLayer[\s\S]{0,400}\bGTM-[A-Z0-9]{4,}|\bGTM-[A-Z0-9]{4,}[\s\S]{0,400}dataLayer/], idRe: /\bGTM-[A-Z0-9]{4,10}\b/g },
  { id: 'ga', name: 'Google Analytics', hosts: ['google-analytics.com', 'analytics.google.com', 'ssl.google-analytics.com'], inline: [/\bgtag\s*\(\s*['"](config|js)['"]|GoogleAnalyticsObject|\bga\(\s*['"]create|googletagmanager\.com\/gtag\/js\?id=(G|UA)-/], idRe: /\b(G-[A-Z0-9]{6,12}|UA-\d{4,10}-\d{1,4})\b/g },
  { id: 'gads', name: 'Google Ads / DoubleClick', hosts: ['doubleclick.net', 'googleadservices.com', 'googlesyndication.com', 'adservice.google.', 'pagead2.'], inline: [/adsbygoogle|googletag\.cmd/], idRe: /\bAW-\d{6,12}\b/g },
  { id: 'ym', name: 'Яндекс.Метрика', hosts: ['mc.yandex.ru', 'mc.yandex.com', 'mc.yandex.by', 'mc.yandex.kz', 'mc.webvisor.org', 'mc.webvisor.com', 'yandex.ru/metrika', 'metrika.yandex'], inline: [/\bym\s*\(\s*\d{5,}|mc\.yandex\.|Ya\.Metrika|yandex_metrika_callbacks/], idRe: /(?:\bym\s*\(\s*|metrika\/tag\.js\?id=|watch\/)(\d{5,12})/g },
  { id: 'yads', name: 'Яндекс.Директ / РСЯ', hosts: ['an.yandex.ru', 'yandex.ru/ads', 'yastatic.net/partner-code', 'adfox.ru', 'ads.adfox.ru'], inline: [/yaContextCb|Ya\.Context|adfox/i] },
  { id: 'fb', name: 'Facebook (Meta) Pixel', hosts: ['connect.facebook.net', 'facebook.com/tr', 'facebook.net/signals'], inline: [/\bfbq\s*\(\s*['"]init|fbevents\.js/], idRe: /fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d{6,20})/g },
  { id: 'vk', name: 'VK Pixel / VK Реклама', hosts: ['vk.com/rtrg', 'vk.ru/rtrg', 'vk.com/js/api/openapi', 'top-fwz1.mail.ru', 'ad.mail.ru', 'vk-ads', 'privacy-cs.mail.ru'], inline: [/VK\.Retargeting|vk\.com\/rtrg|_tmr\.push|top-fwz1\.mail\.ru|var _tmr/], idRe: /(?:VK\.Retargeting\.Init\(\s*['"]|rtrg\?p=|id:\s*['"]?)(VK-RTRG-[\w-]+|\d{6,10})/g },
  { id: 'mailru', name: 'Top.Mail.Ru', hosts: ['top.mail.ru', 'top-fwz1.mail.ru/counter'], inline: [/top\.mail\.ru\/counter/] },
  { id: 'roistat', name: 'Roistat', hosts: ['cloud.roistat.com', 'roistat.com', 'roistat.net'], inline: [/roistat/i], idRe: /roistat[^'"]*['"]([a-f0-9]{16,40})['"]/gi },
  { id: 'calltouch', name: 'Calltouch', hosts: ['calltouch.ru', 'mod.calltouch'], inline: [/calltouch|ct\(\s*['"]modules/i] },
  { id: 'comagic', name: 'CoMagic / UIS', hosts: ['comagic.ru', 'uiscom.ru', 'app.comagic', 'app.uiscom'], inline: [/comagic|Comagic|uiscom/] },
  { id: 'callibri', name: 'Callibri', hosts: ['callibri.ru'], inline: [/callibri/i] },
  { id: 'envybox', name: 'Envybox', hosts: ['envybox.io', 'cdn.envybox'], inline: [/envybox/i] },
  { id: 'mango', name: 'Mango Office (коллтрекинг)', hosts: ['mango-office.ru', 'widgets.mango-office'], inline: [/mango-office|MangoObject/] },
  { id: 'liveinternet', name: 'LiveInternet', hosts: ['counter.yadro.ru', 'liveinternet.ru/click'], inline: [/counter\.yadro\.ru|liveinternet/] },
  { id: 'rambler', name: 'Rambler Top100', hosts: ['counter.rambler.ru', 'top100.ru', 'st.top100.ru'], inline: [/top100Counter|counter\.rambler/] },
  { id: 'hotjar', name: 'Hotjar', hosts: ['hotjar.com', 'hotjar.io'], inline: [/hotjar|_hjSettings/], idRe: /hjid\s*:\s*(\d{5,10})/g },
  { id: 'clarity', name: 'Microsoft Clarity', hosts: ['clarity.ms'], inline: [/clarity\.ms\/tag|\(c\[a\]\.q=c\[a\]\.q\|\|\[\]\)/], idRe: /clarity\.ms\/tag\/(\w{6,14})/g },
  { id: 'tiktok', name: 'TikTok Pixel', hosts: ['analytics.tiktok.com'], inline: [/ttq\.load|analytics\.tiktok\.com/], idRe: /ttq\.load\(\s*['"](\w{10,30})/g },
  { id: 'linkedin', name: 'LinkedIn Insight', hosts: ['snap.licdn.com', 'px.ads.linkedin.com', 'ads.linkedin.com'], inline: [/_linkedin_partner_id|snap\.licdn\.com/] },
  { id: 'twitter', name: 'X/Twitter Pixel', hosts: ['static.ads-twitter.com', 'analytics.twitter.com', 't.co/i/adsct'], inline: [/twq\(\s*['"](init|config)/] },
  { id: 'pinterest', name: 'Pinterest Tag', hosts: ['ct.pinterest.com', 's.pinimg.com/ct'], inline: [/pintrk\(/] },
  { id: 'snap', name: 'Snap Pixel', hosts: ['sc-static.net/scevent', 'tr.snapchat.com'], inline: [/snaptr\(/] },
  { id: 'segment', name: 'Segment', hosts: ['cdn.segment.com', 'api.segment.io', 'segment.io'], inline: [/analytics\.load\(|cdn\.segment\.com/] },
  { id: 'mixpanel', name: 'Mixpanel', hosts: ['mixpanel.com', 'mxpnl.com'], inline: [/mixpanel\.init/] },
  { id: 'amplitude', name: 'Amplitude', hosts: ['amplitude.com', 'cdn.amplitude.com'], inline: [/amplitude\.(getInstance|init)/] },
  { id: 'heap', name: 'Heap', hosts: ['heapanalytics.com', 'heap.io', 'heap-api.com'], inline: [/heap\.load\(/] },
  { id: 'fullstory', name: 'FullStory', hosts: ['fullstory.com', 'fs.com/s/fs.js'], inline: [/_fs_org|fullstory/] },
  { id: 'posthog', name: 'PostHog', hosts: ['posthog.com', 'i.posthog.com'], inline: [/posthog\.init/] },
  { id: 'matomo', name: 'Matomo / Piwik', hosts: ['matomo.', 'piwik.', '/matomo.js', '/piwik.js'], inline: [/_paq\.push|matomo\.js|piwik\.js/] },
  { id: 'plausible', name: 'Plausible', hosts: ['plausible.io/js', 'plausible.io/api/event'], inline: [/plausible\(/] },
  { id: 'cfinsights', name: 'Cloudflare Web Analytics', hosts: ['static.cloudflareinsights.com', 'cloudflareinsights.com/cdn-cgi/rum'], inline: [/cloudflareinsights|data-cf-beacon/] },
  { id: 'hubspot', name: 'HubSpot', hosts: ['js.hs-scripts.com', 'js.hs-analytics.net', 'js.hsforms.net', 'track.hubspot.com', 'js.hs-banner.com'], inline: [/_hsq\.push|hs-scripts\.com/] },
  { id: 'newrelic', name: 'New Relic', hosts: ['js-agent.newrelic.com', 'nr-data.net', 'bam.nr-data.net'], inline: [/NREUM|newrelic/] },
  { id: 'sentry', name: 'Sentry', hosts: ['browser.sentry-cdn.com', 'sentry.io/api', 'ingest.sentry.io', 'js.sentry-cdn.com'], inline: [/Sentry\.init\(/] },
  { id: 'datadog', name: 'Datadog RUM', hosts: ['datadoghq-browser-agent', 'browser-intake-datadoghq'], inline: [/DD_RUM/] },
  { id: 'bugsnag', name: 'Bugsnag', hosts: ['bugsnag.com', 'd2wy8f7a9ursnm.cloudfront.net'], inline: [/Bugsnag\.start/] },
  { id: 'criteo', name: 'Criteo', hosts: ['criteo.com', 'criteo.net'], inline: [/criteo_q/] },
  { id: 'taboola', name: 'Taboola / Outbrain', hosts: ['taboola.com', 'outbrain.com'], inline: [/_tfa\.push|obApi\(/] },
  { id: 'comscore', name: 'Comscore / Quantcast', hosts: ['scorecardresearch.com', 'quantserve.com', 'quantcount.com'], inline: [/_comscore|_qevents/] },
  // chat / callback widgets: they inject their own UI, cookies and network traffic into the clone
  { id: 'jivo', name: 'JivoSite (чат)', hosts: ['jivosite.com', 'code.jivo.ru', 'jivo.ru'], inline: [/jivo_api|jivosite|code\.jivo/], widget: true },
  { id: 'carrotquest', name: 'Carrot quest (чат)', hosts: ['carrotquest.io', 'cdn.carrotquest'], inline: [/carrotquest/], widget: true },
  { id: 'bitrix24', name: 'Битрикс24 (виджет/CRM-форма)', hosts: ['bitrix24.ru/b', 'bitrix24.com/b', 'cdn-ru.bitrix24.ru', 'cdn.bitrix24.'], inline: [/bitrix24\.(ru|com)\/b\d+\/crm|b24form|BX\.SiteButton/], widget: true },
  { id: 'intercom', name: 'Intercom (чат)', hosts: ['intercom.io', 'intercomcdn.com', 'widget.intercom.io'], inline: [/intercomSettings|Intercom\(/], widget: true },
  { id: 'crisp', name: 'Crisp (чат)', hosts: ['crisp.chat', 'client.crisp.chat'], inline: [/\$crisp|CRISP_WEBSITE_ID/], widget: true },
  { id: 'tawk', name: 'Tawk.to (чат)', hosts: ['tawk.to', 'embed.tawk.to'], inline: [/Tawk_API/], widget: true },
  { id: 'livechat', name: 'LiveChat / Drift / Zendesk', hosts: ['livechatinc.com', 'js.driftt.com', 'zdassets.com', 'zopim.com', 'livetex.ru', 'talk-me.ru', 'redhelper.ru'], inline: [/__lc\.license|drift\.load|zESettings|LiveTex|TalkMe/], widget: true },
  { id: 'yawidget', name: 'Яндекс-виджеты (отзывы/чат)', hosts: ['yastatic.net/s3/chat', 'yandex.ru/chat'], inline: [/Ya\.ChatWidget/], widget: true },
];

// cookie-consent SDKs and similar overlays that would cover the page during the crawl
export const CONSENT_HOSTS = ['cdn.cookielaw.org', 'onetrust.com', 'cookiebot.com', 'consent.cookiebot.com', 'usercentrics.eu', 'cookieyes.com', 'termly.io', 'iubenda.com', 'trustarc.com', 'consentmanager.net', 'cookie-script.com', 'quantcast.mgr.consensu.org'];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BY_HOST = TRACKERS.flatMap((t) => t.hosts.map((h) => [h.toLowerCase(), t]));
export const BLOCK_HOSTS = [...BY_HOST.map(([h]) => h), ...CONSENT_HOSTS];
export const BLOCK_RE = new RegExp(BLOCK_HOSTS.map(esc).join('|'), 'i');

// tracker of a URL (host + path match) or null
export function trackerOf(url) {
  if (!url) return null;
  let s = String(url).toLowerCase();
  try { const u = new URL(url); s = (u.host + u.pathname + (u.search || '')).toLowerCase(); } catch {}
  for (const [h, t] of BY_HOST) if (s.includes(h)) return t;
  return null;
}
export const isTrackerUrl = (url) => !!trackerOf(url) || CONSENT_HOSTS.some((h) => String(url).toLowerCase().includes(h));

// trackers referenced by an inline script / HTML snippet, with counter ids (GTM-XXXX, ym 12345, fbq init …)
export function scanText(text) {
  const out = new Map();
  const src = String(text || '');
  if (!src) return [];
  for (const t of TRACKERS) {
    const hit = t.inline.some((re) => re.test(src)) || t.hosts.some((h) => src.toLowerCase().includes(h));
    if (!hit) continue;
    const ids = new Set();
    if (t.idRe) for (const m of src.matchAll(t.idRe)) ids.add(m[1] || m[0]);
    out.set(t.id, { id: t.id, name: t.name, ids: [...ids].slice(0, 6), widget: !!t.widget });
  }
  return [...out.values()];
}

// merge per-page detections: [{ id, name, ids, pages }]
export function mergeTrackers(lists) {
  const by = new Map();
  for (const { page, items } of lists) for (const it of items || []) {
    const cur = by.get(it.id) || { id: it.id, name: it.name, ids: new Set(), pages: new Set(), widget: !!it.widget };
    for (const x of it.ids || []) cur.ids.add(x);
    if (page) cur.pages.add(page);
    by.set(it.id, cur);
  }
  return [...by.values()].map((x) => ({ ...x, ids: [...x.ids], pages: [...x.pages] })).sort((a, b) => a.name.localeCompare(b.name));
}
