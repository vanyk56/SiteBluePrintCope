// HTML sanitizer for saved snapshots and DOM dumps (defense in depth: the in-page serializer already
// works on the live DOM; this pass also covers HTML that arrives from the browser extension).
// Removes: all scripts (+ hydration payloads of foreign frameworks), noscript pixels, tracker iframes/images,
// preload/prefetch hints of foreign JS chunks, <base>, meta refresh/CSP, inline event handlers, javascript: URLs,
// cloak attributes that keep content hidden until a framework boots (x-cloak, v-cloak) and router markers.
import { trackerOf, scanText, mergeTrackers } from './trackers.mjs';

// hydration payloads / client routers of other frameworks: they cause 404s of missing chunks and hydration errors
export const ROUTER_SIGNS = [
  { id: 'next', name: 'Next.js (__NEXT_DATA__ / RSC payload)', re: /__NEXT_DATA__|self\.__next_f|__next_s|\/_next\/static\//i },
  { id: 'nuxt', name: 'Nuxt (__NUXT__)', re: /window\.__NUXT__|__NUXT_DATA__|\/_nuxt\//i },
  { id: 'gatsby', name: 'Gatsby', re: /___gatsby|window\.___loader|page-data\.json/i },
  { id: 'remix', name: 'Remix / React Router', re: /__remixContext|__reactRouterContext|window\.__staticRouterHydrationData/i },
  { id: 'sveltekit', name: 'SvelteKit', re: /__sveltekit_|data-sveltekit/i },
  { id: 'astro', name: 'Astro islands', re: /astro-island|astro:load/i },
  { id: 'angular', name: 'Angular', re: /ng-version|ngh=|ng-state/i },
  { id: 'apollo', name: 'Apollo/Redux state', re: /__APOLLO_STATE__|__INITIAL_STATE__|__PRELOADED_STATE__|__REDUX_STATE__/i },
  { id: 'turbo', name: 'Hotwire Turbo / Barba / Swup / pjax', re: /data-turbo|barba\.init|new Swup|data-barba|pjax/i },
  { id: 'tilda', name: 'Tilda runtime', re: /tilda-scripts|t_onReady|tildacdn\.com\/js/i },
  { id: 'sw', name: 'Service Worker', re: /serviceWorker\.register/i },
];

const ATTR_DROP = /^(on[a-z]+|nonce|integrity|data-reactroot|data-reactid|data-react-helmet|data-rh|data-n-head|data-hid|data-server-rendered|ng-version|ngh|data-turbo-track|data-turbolinks-track|x-cloak|v-cloak|data-sb-id|data-sb-ov|data-sb-media)$/i;
const LINK_DROP = /\brel\s*=\s*["']?(?:[^"'>]*\s)?(preload|prefetch|modulepreload|dns-prefetch|preconnect|serviceworker|manifest|prerender)\b/i;

function attrValue(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
}

export function detectRouters(text) {
  const s = String(text || ''); return ROUTER_SIGNS.filter((r) => r.re.test(s)).map(({ id, name }) => ({ id, name }));
}

export function sanitizeHtml(html, { keepWidgets = false } = {}) {
  const report = { scripts: 0, noscript: 0, iframes: 0, pixels: 0, preloads: 0, handlers: 0, jsLinks: 0, cloaks: 0, trackers: [], routers: [] };
  const found = [];
  let s = String(html || '');
  report.routers = detectRouters(s);
  // <script> — scan for trackers first, then drop (JSON-LD structured data is kept: it is content, not code)
  s = s.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (m, attrs, body) => {
    const type = attrValue(m, 'type').toLowerCase();
    if (type === 'application/ld+json') return m;
    const src = attrValue(m, 'src');
    const t = src ? trackerOf(src) : null;
    if (t) found.push({ id: t.id, name: t.name, ids: [], widget: !!t.widget });
    found.push(...scanText(body + ' ' + src));
    report.scripts++;
    return '';
  });
  s = s.replace(/<noscript\b[^>]*>([\s\S]*?)<\/noscript\s*>/gi, (m, body) => { found.push(...scanText(body)); report.noscript++; return ''; });
  s = s.replace(/<iframe\b[^>]*?(?:\/>|>[\s\S]*?<\/iframe\s*>)/gi, (m) => {
    const t = trackerOf(attrValue(m, 'src'));
    if (t && (!t.widget || !keepWidgets)) { found.push({ id: t.id, name: t.name, ids: [], widget: !!t.widget }); report.iframes++; return ''; }
    return m;
  });
  s = s.replace(/<img\b[^>]*>/gi, (m) => {
    const t = trackerOf(attrValue(m, 'src'));
    if (t) { found.push({ id: t.id, name: t.name, ids: [], widget: false }); report.pixels++; return ''; }
    return m;
  });
  s = s.replace(/<link\b[^>]*>/gi, (m) => {
    if (LINK_DROP.test(m) || trackerOf(attrValue(m, 'href'))) { report.preloads++; return ''; }
    return m;
  });
  s = s.replace(/<base\b[^>]*>/gi, '');
  s = s.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?(refresh|content-security-policy)["']?[^>]*>/gi, '');
  s = s.replace(/<(next-route-announcer|nextjs-portal)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  // attributes inside start tags
  s = s.replace(/<([a-zA-Z][\w:-]*)(\s[^<>]*?)?(\/?)>/g, (m, tag, attrs, selfClose) => {
    if (!attrs) return m;
    let a = attrs.replace(/\s([^\s=/>]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g, (am, name, val) => {
      if (ATTR_DROP.test(name)) { if (/^on/i.test(name)) report.handlers++; if (/cloak$/i.test(name)) report.cloaks++; return ''; }
      if (/^(href|src|action|formaction|xlink:href)$/i.test(name) && val && /^\s*=\s*["']?\s*javascript:/i.test(val)) { report.jsLinks++; return ` ${name}="#"`; }
      return am;
    });
    return `<${tag}${a}${selfClose}>`;
  });
  report.trackers = mergeTrackers([{ items: found }]).map(({ pages, ...t }) => t);
  return { html: s, report };
}
