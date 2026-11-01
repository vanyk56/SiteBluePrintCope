/* site-blueprint content script — runs in the page's MAIN world (injected by background.js with
 * chrome.scripting.executeScript after lib/inpage.js). It serializes the LIVE DOM of the user's own tab:
 *   prepare  → lazy images eager, step-by-step scroll (IntersectionObserver / infinite lists), wait for fonts and
 *              images, finish entrance animations, inline external SVG sprites (<use href="sprite.svg#id">)
 *   extract  → computed-style DOM tree, tokens, fonts, media, interactive elements (same extractor as the CLI)
 *   snapshot → SingleFile-style HTML (shadow DOM, same-origin iframes, CSSOM, canvas frames, form state)
 *   meta     → tracker report input, framework hydration state (__NEXT_DATA__, __NUXT__, Apollo, JSON-LD…)
 *   probe    → interactive state: tabs / category filters, accordions, hover menus, dialogs, <details>
 * Results stay in page memory and are pulled by the service worker in slices (no giant messages).
 * Nothing is sent anywhere from here; the page is restored after the capture (sprites, scroll, fixed elements). */
(() => {
  'use strict';
  const L = window.__sbLib;
  if (!L) throw new Error('site-blueprint: lib/inpage.js is not loaded');
  if (window.__sbCapture && window.__sbCapture.version === L.version) return;

  const store = new Map();
  const put = (k, v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); store.set(k, s); return s.length; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const DANGER_URL = /logout|log-out|signout|sign-out|delete|remove|unsubscribe|checkout|payment|\/pay\b|cart\/(add|clear)|basket/i;
  const NOISE_URL = /collect|analytics|beacon|pixel|track|telemetry|metrics|sentry|log(s|ging)?\b|hotjar|clarity|gtag|gtm\.js|\/ping\b|heartbeat|socket\.io|__nextjs|_next\/data|webpack|hot-update/i;
  const TEXTUAL = /json|graphql|text\/plain|text\/csv|x-ndjson|javascript|xml/i;
  let interactive = [];
  let fixedHidden = [];

  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return null; } }
  function canvasFrames(raw) {
    let n = 0;
    for (const [i, m] of (raw.media || []).entries()) {
      if (!m || m.type !== 'canvas' || m.w < 80 || m.h < 40 || n >= 4) continue;
      const el = document.querySelector('[data-sb-media="' + i + '"]');
      if (!el || typeof el.toDataURL !== 'function') continue;
      try {
        const d = el.toDataURL('image/png');
        if (d && d.length > 2000 && d.length < 6e6) { m.snapshotData = d; n++; }
      } catch (e) { /* tainted canvas (cross-origin images) */ }
    }
    return n;
  }
  // every file the CLI will want for this page; the service worker fetches them (browser cache + user's session)
  function assetList(raw) {
    const out = new Map();
    const add = (u, kind) => { if (!u || typeof u !== 'string' || u.startsWith('data:') || u.startsWith('blob:')) return; const a = abs(u); if (a && /^https?:/i.test(a) && !out.has(a)) out.set(a, kind); };
    for (const im of raw.images || []) add(im.src, 'images');
    for (const b of raw.bgImages || []) add(b.src, 'images');
    for (const m of raw.media || []) { add(m.poster, 'images'); if (m.type === 'video' || m.type === 'audio') add(m.src, 'media'); }
    const meta = raw.meta || {};
    for (const f of meta.favicons || []) add(f.href, 'icons');
    add(meta.ogImage, 'images');
    const used = new Set((raw.loadedFonts || []).map((f) => String(f.family).toLowerCase()));
    let fonts = 0;
    for (const f of raw.fontFaces || []) {
      if (used.size && !used.has(String(f.family).toLowerCase())) continue;
      const m = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(f.src || '');
      if (!m || m[1].startsWith('data:')) continue;
      try { add(new URL(m[1], f.base || location.href).href, 'fonts'); fonts++; } catch (e) {}
      if (fonts > 80) break;
    }
    return [...out].map(([url, kind]) => ({ url, kind }));
  }
  function sameOriginLinks(raw) {
    const out = []; const seen = new Set();
    for (const l of raw.links || []) {
      const a = abs(l.href); if (!a) continue;
      const u = new URL(a); u.hash = '';
      if (u.origin !== location.origin || seen.has(u.href)) continue;
      seen.add(u.href); out.push({ href: u.href, area: l.area || 'main' });
      if (out.length >= 400) break;
    }
    return out;
  }
  const b64 = (buf) => { const u8 = new Uint8Array(buf); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };

  const api = {
    version: L.version,
    metrics() {
      const de = document.documentElement;
      return { vw: window.innerWidth, vh: window.innerHeight, docH: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0), dpr: window.devicePixelRatio || 1, sx: window.scrollX, sy: window.scrollY, url: location.href, title: document.title, ready: document.readyState };
    },
    async prepare({ scroll = true, maxSteps = 90, budgetMs = 25000, waitMs = 10000 } = {}) {
      const t0 = Date.now();
      const lazy = L.forceLazyInPage();
      const steps = scroll ? await L.autoScrollInPage({ maxSteps, budgetMs }) : 0;
      await L.waitAssetsInPage(waitMs);
      const anims = await L.finishAnimationsInPage();
      let sprites = { files: 0 };
      try { sprites = await L.inlineSpritesInPage({}); } catch (e) {}
      return { lazy, steps, anims, sprites, ms: Date.now() - t0 };
    },
    // stylesheet texts; the ones the page cannot read (cross-origin without CORS) are fetched by the worker
    async css() {
      const list = await L.collectCssInPage({});
      put('css', list.filter((x) => x.text).map((x) => ({ url: x.url, text: x.text })));
      return list.map((x) => ({ url: x.url, bytes: (x.text || '').length, blocked: !x.text }));
    },
    provideCss(list) { window.__sbCss = (window.__sbCss || []).concat((list || []).filter((x) => x && x.href && x.text)); return (window.__sbCss || []).length; },
    extract({ maxNodes = 4000, html = true } = {}) {
      const raw = L.extractPage({ maxNodes, html });
      if (!raw || raw.error || !raw.tree) return { error: (raw && raw.error) || 'extractPage failed' };
      const frames = canvasFrames(raw);
      interactive = raw.interactive || [];
      const assets = assetList(raw);
      const links = sameOriginLinks(raw);
      const size = put('raw', raw);
      return { size, url: raw.url, title: (raw.meta && raw.meta.title) || document.title, docHeight: raw.docHeight, viewport: raw.viewport, nodes: raw.stats && raw.stats.nodes, truncated: !!(raw.stats && raw.stats.truncated), interactive: interactive.length, canvases: frames, links, assets };
    },
    snapshot({ maxBytes = 25e6, frameDepth = 2 } = {}) {
      const s = L.snapshotPage({ maxBytes, frameDepth });
      if (!s || !s.html) return { error: (s && s.error) || 'snapshot failed' };
      const resources = (s.resources || []).filter((r) => r && r.kind !== 'page' && /^https?:/i.test(r.url || '')).map((r) => ({ url: r.url, kind: r.kind }));
      return { size: put('snapshot', s), resources, stats: s.stats || null };
    },
    meta() {
      const t = L.scanTrackersInPage();
      const h = L.hydrationStateInPage({});
      return { trackers: put('trackers', t), hydration: put('hydration', h), blobs: h.blobs.length };
    },
    async probe(opts = {}) {
      const r = await L.probeStateInPage({ interactive, ...opts });
      put('state', r);
      return { tabGroups: r.tabGroups.length, expand: r.expand.length, dialogs: r.dialogs.length, dropdowns: r.dropdowns.length, details: r.details.length, clicks: r.clicks, blocked: r.blocked, ms: r.ms, error: r.error || null };
    },
    // --- full-page screenshot support (the worker scrolls + captureVisibleTab + stitches) ---
    async shotScroll(y, index) {
      if (index === 0) {
        // cookie / consent banners are hidden for the screenshot only — the user's consent choice is never clicked
        fixedHidden = [];
        for (const el of document.querySelectorAll('body *')) {
          const cs = getComputedStyle(el);
          if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
          const id = ((el.id || '') + ' ' + (el.getAttribute('class') || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
          const text = (el.innerText || '').slice(0, 400);
          if (/cookie|consent|gdpr|cmp|onetrust|usercentrics/.test(id) || /cookie|куки|consent|согласи[ея] на обработку|персональных данных/i.test(text) && text.length < 400) {
            fixedHidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]); el.style.setProperty('visibility', 'hidden', 'important');
          }
          if (fixedHidden.length > 20) break;
        }
      }
      if (index === 1) {
        // fixed / sticky headers would repeat on every screen: hide them after the first one
        for (const el of document.querySelectorAll('body *')) {
          if (fixedHidden.some((x) => x[0] === el)) continue;
          const p = getComputedStyle(el).position;
          if (p === 'fixed' || p === 'sticky') { fixedHidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]); el.style.setProperty('visibility', 'hidden', 'important'); }
          if (fixedHidden.length > 400) break;
        }
      }
      window.scrollTo({ top: y, left: 0, behavior: 'instant' });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await sleep(120);
      return window.scrollY;
    },
    shotRestore() {
      for (const [el, v, p] of fixedHidden) { if (v) el.style.setProperty('visibility', v, p); else el.style.removeProperty('visibility'); }
      fixedHidden = [];
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      return true;
    },
    // --- API: requests made before the hook was installed (Resource Timing) → re-requested here (GET only) ---
    apiCandidates(seen = []) {
      const have = new Set(seen); const out = [];
      for (const e of performance.getEntriesByType('resource')) {
        if (e.initiatorType !== 'fetch' && e.initiatorType !== 'xmlhttprequest') continue;
        const u = abs(e.name); if (!u || have.has(u)) continue;
        have.add(u);
        const x = new URL(u);
        if (x.origin !== location.origin || DANGER_URL.test(x.pathname) || NOISE_URL.test(x.pathname + x.search)) continue;
        if (typeof e.responseStatus === 'number' && e.responseStatus && (e.responseStatus < 200 || e.responseStatus >= 300)) continue;
        out.push(u);
        if (out.length >= 60) break;
      }
      return out;
    },
    async refetch(urls = [], { maxBytes = 2e6, timeoutMs = 8000 } = {}) {
      const out = [];
      for (const url of urls.slice(0, 60)) {
        try {
          const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeoutMs);
          const r = await fetch(url, { credentials: 'include', signal: ctl.signal, headers: { Accept: 'application/json, text/plain, */*' } });
          clearTimeout(tm);
          const ct = r.headers.get('content-type') || '';
          if (!r.ok || !TEXTUAL.test(ct)) continue;
          const body = await r.text();
          if (body.length > maxBytes) continue;
          out.push({ url, method: 'GET', status: r.status, contentType: ct, requestHeaders: {}, requestBody: null, body, encoding: 'utf8', resourceType: 'fetch', refetched: true, ts: Date.now() });
        } catch (e) {}
      }
      return out;
    },
    drainApi() { return window.__sbApi && typeof window.__sbApi.drain === 'function' ? window.__sbApi.drain() : []; },
    // --- assets the worker could not fetch itself (no host permission for a CDN): same request from the page ---
    async fetchAsset(url, { maxBytes = 8e6, timeoutMs = 15000 } = {}) {
      try {
        const same = new URL(url).origin === location.origin;
        const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeoutMs);
        const r = await fetch(url, { credentials: same ? 'include' : 'omit', mode: 'cors', cache: 'force-cache', signal: ctl.signal });
        clearTimeout(tm);
        if (!r.ok) return { ok: false, status: r.status };
        const buf = await r.arrayBuffer();
        if (buf.byteLength > maxBytes) return { ok: false, status: 413 };
        return { ok: true, status: r.status, contentType: r.headers.get('content-type') || '', b64: b64(buf) };
      } catch (e) { return { ok: false, status: 0, error: String(e && e.message || e).slice(0, 120) }; }
    },
    // --- results are pulled in slices ---
    size(k) { return store.has(k) ? store.get(k).length : -1; },
    slice(k, a, b) { const s = store.get(k); return s ? s.slice(a, b) : ''; },
    drop(k) { store.delete(k); return true; },
    finish() {
      try { L.restoreSpritesInPage(); } catch (e) {}
      store.clear(); interactive = [];
      return true;
    },
  };
  Object.defineProperty(window, '__sbCapture', { value: api, configurable: true, enumerable: false, writable: true });
})();
