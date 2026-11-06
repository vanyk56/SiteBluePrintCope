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
      const sc = scroll ? await L.autoScrollInPage({ maxSteps, budgetMs }) : null;
      await L.waitAssetsInPage(waitMs);
      const anims = await L.finishAnimationsInPage();
      let sprites = { files: 0 };
      try { sprites = await L.inlineSpritesInPage({}); } catch (e) {}
      return { lazy, steps: sc ? sc.steps : 0, revealed: sc ? sc.restored : 0, anims, sprites, ms: Date.now() - t0 };
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
        // reveal effects triggered while the worker scrolls finish instantly (no half-faded strips in the stitched image)
        L.freezeMotionInPage();
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
      L.unfreezeMotionInPage();
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
    // --- Component Picker: interactive hover overlay → click → React + Tailwind JSX in clipboard ---
    startPicker() {
      const old = document.getElementById('__sb-picker-root');
      if (old) old.remove();
      const root = document.createElement('div');
      root.id = '__sb-picker-root';
      root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483645;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;';
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;border:2px solid #06b6d4;background:rgba(6,182,212,0.10);border-radius:6px;pointer-events:none;transition:all 50ms ease-out;display:none;box-shadow:0 0 0 1px rgba(0,0,0,0.35),0 8px 24px rgba(6,182,212,0.22);';
      const badge = document.createElement('div');
      badge.style.cssText = 'position:fixed;background:#09090b;color:#f4f4f5;font-size:11px;font-weight:600;padding:4px 8px;border-radius:5px;border:1px solid #06b6d4;pointer-events:none;white-space:nowrap;display:none;box-shadow:0 4px 12px rgba(0,0,0,0.5);';
      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#09090b;color:#f4f4f5;font-size:12px;padding:7px 14px;border-radius:999px;border:1px solid #27272a;box-shadow:0 10px 25px rgba(0,0,0,0.5);pointer-events:none;';
      banner.textContent = '🎯 Наведи и кликни на блок для копирования JSX · ↑/↓ родитель/дочерний · Esc отмена';
      root.append(box, badge, banner);
      (document.body || document.documentElement).appendChild(root);

      let current = null;
      const history = [];

      const rgbToHex = (c) => {
        if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return '';
        const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,/\s]+([\d.]+))?\)/.exec(c);
        if (!m) return '';
        const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
        if (a < 0.04) return '';
        const hex = (n) => Number(n).toString(16).padStart(2, '0');
        return '#' + hex(m[1]) + hex(m[2]) + hex(m[3]);
      };

      const elToTw = (el) => {
        const cs = getComputedStyle(el);
        const cls = [];
        const d = cs.display;
        if (d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid') cls.push(d);
        if (d.includes('flex')) {
          if (cs.flexDirection === 'column') cls.push('flex-col');
          if (cs.flexWrap === 'wrap') cls.push('flex-wrap');
          if (cs.justifyContent === 'center') cls.push('justify-center');
          else if (cs.justifyContent === 'space-between') cls.push('justify-between');
          else if (cs.justifyContent === 'flex-end' || cs.justifyContent === 'end') cls.push('justify-end');
          if (cs.alignItems === 'center') cls.push('items-center');
          else if (cs.alignItems === 'flex-start' || cs.alignItems === 'start') cls.push('items-start');
        }
        if (d.includes('grid') && cs.gridTemplateColumns && cs.gridTemplateColumns !== 'none') {
          const tracks = cs.gridTemplateColumns.trim().split(/\s+/).filter(Boolean);
          if (tracks.length >= 2 && tracks.length <= 6) {
            const px = tracks.map((t) => parseFloat(t));
            if (px.every((n) => !Number.isNaN(n)) && Math.max(...px) - Math.min(...px) <= 6) cls.push('grid-cols-' + tracks.length);
            else cls.push('grid-cols-[' + tracks.join('_') + ']');
          }
        }
        if (cs.position === 'relative' || cs.position === 'absolute' || cs.position === 'sticky') cls.push(cs.position);
        const g = Math.round(parseFloat(cs.gap) || 0);
        if (g > 0) cls.push(g % 4 === 0 && g <= 64 ? 'gap-' + (g / 4) : 'gap-[' + g + 'px]');
        const pt = Math.round(parseFloat(cs.paddingTop) || 0), pr = Math.round(parseFloat(cs.paddingRight) || 0), pb = Math.round(parseFloat(cs.paddingBottom) || 0), pl = Math.round(parseFloat(cs.paddingLeft) || 0);
        if (pt || pr || pb || pl) {
          if (pt === pb && pl === pr) {
            if (pt) cls.push(pt % 4 === 0 && pt <= 96 ? 'py-' + (pt / 4) : 'py-[' + pt + 'px]');
            if (pl) cls.push(pl % 4 === 0 && pl <= 96 ? 'px-' + (pl / 4) : 'px-[' + pl + 'px]');
          } else cls.push('p-[' + pt + 'px_' + pr + 'px_' + pb + 'px_' + pl + 'px]');
        }
        const mw = Math.round(parseFloat(cs.maxWidth) || 0);
        if (mw > 0 && mw <= 1600) {
          const mwMap = { 1280: 'max-w-7xl', 1152: 'max-w-6xl', 1024: 'max-w-5xl', 896: 'max-w-4xl', 768: 'max-w-3xl', 672: 'max-w-2xl' };
          cls.push(mwMap[mw] || 'max-w-[' + mw + 'px]');
          if (Math.abs((parseFloat(cs.marginLeft) || 0) - (parseFloat(cs.marginRight) || 0)) <= 2 && (parseFloat(cs.marginLeft) || 0) > 8) cls.push('mx-auto');
        }
        const bg = rgbToHex(cs.backgroundColor);
        if (bg) cls.push('bg-[' + bg + ']');
        const col = rgbToHex(cs.color);
        if (col && el.childNodes.length) cls.push('text-[' + col + ']');
        const fs = Math.round(parseFloat(cs.fontSize) || 0);
        if (fs && fs !== 16) cls.push('text-[' + fs + 'px]');
        const fw = parseInt(cs.fontWeight, 10);
        if (fw >= 700) cls.push('font-bold'); else if (fw === 600) cls.push('font-semibold'); else if (fw === 500) cls.push('font-medium');
        if (cs.textAlign === 'center') cls.push('text-center'); else if (cs.textAlign === 'right') cls.push('text-right');
        if (cs.textTransform === 'uppercase') cls.push('uppercase');
        const rad = Math.round(parseFloat(cs.borderTopLeftRadius) || 0);
        if (rad >= 999) cls.push('rounded-full'); else if (rad > 0) cls.push('rounded-[' + rad + 'px]');
        const bw = Math.round(parseFloat(cs.borderTopWidth) || 0);
        if (bw > 0 && cs.borderTopStyle !== 'none') {
          cls.push(bw === 1 ? 'border' : 'border-[' + bw + 'px]');
          const bc = rgbToHex(cs.borderTopColor);
          if (bc) cls.push('border-[' + bc + ']');
        }
        if (cs.overflow === 'hidden') cls.push('overflow-hidden');
        return cls.join(' ');
      };

      const inferComponentName = (el) => {
        const tag = (el.tagName || '').toLowerCase();
        const hint = ((el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
        if (tag === 'header' || /navbar|header|topbar/.test(hint)) return 'HeaderSection';
        if (tag === 'footer' || /footer/.test(hint)) return 'FooterSection';
        if (/pricing|plan|tariff/.test(hint)) return 'PricingSection';
        if (/hero|banner|jumbotron/.test(hint)) return 'HeroSection';
        if (/faq|accordion/.test(hint)) return 'FaqSection';
        if (/feature|benefit|bento/.test(hint)) return 'FeaturesSection';
        if (/testimonial|review/.test(hint)) return 'TestimonialsSection';
        if (/cta|call-to-action/.test(hint)) return 'CtaSection';
        return 'PickedSection';
      };

      const serializeSvg = (svgEl, indent) => {
        const r = svgEl.getBoundingClientRect();
        const w = Math.max(12, Math.min(200, Math.round(r.width || 20)));
        const h = Math.max(12, Math.min(200, Math.round(r.height || 20)));
        const vb = svgEl.getAttribute('viewBox') || ('0 0 ' + w + ' ' + h);
        const fill = svgEl.getAttribute('fill') || 'none';
        const paths = [];
        for (const p of svgEl.querySelectorAll('path,circle,rect,line,polyline,polygon')) {
          const pt = p.tagName.toLowerCase();
          const pa = [];
          for (const [from, to] of [['d', 'd'], ['cx', 'cx'], ['cy', 'cy'], ['r', 'r'], ['x', 'x'], ['y', 'y'], ['width', 'width'], ['height', 'height'], ['rx', 'rx'], ['x1', 'x1'], ['y1', 'y1'], ['x2', 'x2'], ['y2', 'y2'], ['points', 'points'], ['fill', 'fill'], ['stroke', 'stroke'], ['stroke-width', 'strokeWidth'], ['stroke-linecap', 'strokeLinecap'], ['stroke-linejoin', 'strokeLinejoin'], ['fill-rule', 'fillRule'], ['clip-rule', 'clipRule']]) {
            const v = p.getAttribute(from);
            if (v) pa.push(to + '="' + v.replace(/"/g, '&quot;') + '"');
          }
          if (pa.length) paths.push(indent + '  <' + pt + ' ' + pa.join(' ') + ' />');
          if (paths.length >= 16) break;
        }
        if (!paths.length) return indent + '<svg className="w-[' + w + 'px] h-[' + h + 'px]" viewBox="' + vb + '" fill="currentColor" />';
        return indent + '<svg className="w-[' + w + 'px] h-[' + h + 'px] shrink-0" viewBox="' + vb + '" fill="' + fill + '">\n' + paths.join('\n') + '\n' + indent + '</svg>';
      };

      const serializeJsx = (el, indent = '    ', depth = 0) => {
        if (!el || depth > 12) return '';
        const tag = el.tagName ? el.tagName.toLowerCase() : 'div';
        if (/^(script|style|noscript|template)$/i.test(tag)) return '';
        if (tag === 'svg') return serializeSvg(el, indent);
        const tw = elToTw(el);
        const attrs = [];
        if (tw) attrs.push('className="' + tw + '"');
        if (tag === 'a' && el.getAttribute('href')) attrs.push('href="' + el.getAttribute('href').replace(/"/g, '&quot;') + '"');
        if (tag === 'img') {
          attrs.push('src="' + (el.currentSrc || el.getAttribute('src') || '/placeholder.svg').replace(/"/g, '&quot;') + '"');
          attrs.push('alt="' + (el.getAttribute('alt') || '').replace(/"/g, '&quot;') + '"');
          return indent + '<img ' + attrs.join(' ') + ' />';
        }
        if (tag === 'input' || tag === 'hr' || tag === 'br') return indent + '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + ' />';
        const childOut = [];
        for (const ch of el.childNodes) {
          if (ch.nodeType === 3) {
            const t = (ch.nodeValue || '').trim().replace(/[{}<>]/g, '');
            if (t) childOut.push(indent + '  ' + t);
          } else if (ch.nodeType === 1) {
            const s = serializeJsx(ch, indent + '  ', depth + 1);
            if (s) childOut.push(s);
          }
        }
        const open = '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>';
        if (!childOut.length) return indent + '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + ' />';
        if (childOut.length === 1 && !childOut[0].trim().startsWith('<') && childOut[0].length < 70) {
          return indent + open + childOut[0].trim() + '</' + tag + '>';
        }
        return indent + open + '\n' + childOut.join('\n') + '\n' + indent + '</' + tag + '>';
      };

      const updateHighlight = (el) => {
        if (!el || el === document.documentElement || el === document.body) return;
        current = el;
        const r = el.getBoundingClientRect();
        box.style.display = 'block';
        box.style.left = r.left + 'px';
        box.style.top = r.top + 'px';
        box.style.width = r.width + 'px';
        box.style.height = r.height + 'px';
        const tag = el.tagName.toLowerCase();
        const cls = (typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
        badge.textContent = '<' + tag + (cls ? '.' + cls : '') + '> · ' + Math.round(r.width) + '×' + Math.round(r.height) + ' px';
        badge.style.display = 'block';
        badge.style.left = Math.max(8, Math.min(window.innerWidth - 260, r.left)) + 'px';
        badge.style.top = Math.max(8, r.top - 28) + 'px';
      };

      const cleanup = () => {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('keydown', onKey, true);
        root.remove();
      };

      const onMove = (e) => {
        const t = document.elementFromPoint(e.clientX, e.clientY);
        if (t && !root.contains(t)) { history.length = 0; updateHighlight(t); }
      };

      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
        else if (e.key === 'ArrowUp' && current && current.parentElement && current.parentElement !== document.body) {
          e.preventDefault();
          history.push(current);
          updateHighlight(current.parentElement);
        } else if (e.key === 'ArrowDown' && history.length) {
          e.preventDefault();
          updateHighlight(history.pop());
        }
      };

      const onClick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const target = current || document.elementFromPoint(e.clientX, e.clientY);
        cleanup();
        if (!target) return;
        const compName = inferComponentName(target);
        const jsxBody = serializeJsx(target, '    ', 0) || '    <div />';
        const code = "import React from 'react';\n\nexport default function " + compName + "() {\n  return (\n" + jsxBody + "\n  );\n}\n";
        let copied = false;
        try { await navigator.clipboard.writeText(code); copied = true; } catch (err) {
          const ta = document.createElement('textarea');
          ta.value = code;
          ta.style.cssText = 'position:fixed;left:-9999px;';
          document.body.appendChild(ta);
          ta.select();
          try { copied = document.execCommand('copy'); } catch (e2) {}
          ta.remove();
        }
        window.__sbLastPickedJsx = code;
        const prevToast = document.getElementById('__sb-picker-toast');
        if (prevToast) prevToast.remove();
        const toast = document.createElement('div');
        toast.id = '__sb-picker-toast';
        toast.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;background:#09090b;color:#f4f4f5;border:1px solid #10b981;border-radius:12px;padding:12px 14px;font:500 12px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 16px 40px rgba(0,0,0,0.55);max-width:460px;';
        const topRow = document.createElement('div');
        topRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
        const titleSpan = document.createElement('span');
        titleSpan.textContent = (copied ? '✔ ' : '⚡ ') + '<' + compName + ' /> (' + code.split('\n').length + ' строк JSX)';
        titleSpan.style.cssText = 'font-weight:600;color:#10b981;';
        const btnWrap = document.createElement('div');
        btnWrap.style.cssText = 'display:flex;gap:6px;align-items:center;';
        const mkBtn = (label, bg) => {
          const b = document.createElement('button');
          b.textContent = label;
          b.style.cssText = 'background:' + bg + ';color:#f4f4f5;border:1px solid #27272a;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;';
          return b;
        };
        const pre = document.createElement('pre');
        pre.textContent = code;
        pre.style.cssText = 'display:none;margin:10px 0 0;padding:10px;background:#18181b;color:#e4e4e7;border-radius:8px;font:11px/1.4 ui-monospace,Consolas,monospace;max-height:240px;overflow:auto;white-space:pre;';
        const btnView = mkBtn('👁 Код', '#18181b');
        btnView.onclick = () => { pre.style.display = pre.style.display === 'none' ? 'block' : 'none'; };
        const btnDl = mkBtn('💾 .tsx', '#0e7490');
        btnDl.onclick = () => {
          const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
          const u = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = u;
          a.download = compName + '.tsx';
          a.click();
          setTimeout(() => URL.revokeObjectURL(u), 2000);
        };
        const btnClose = mkBtn('✕', '#27272a');
        btnClose.onclick = () => toast.remove();
        btnWrap.append(btnView, btnDl, btnClose);
        topRow.append(titleSpan, btnWrap);
        toast.append(topRow, pre);
        document.body.appendChild(toast);
        setTimeout(() => { if (toast.isConnected && pre.style.display === 'none') toast.remove(); }, 10000);
      };

      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('click', onClick, true);
      window.addEventListener('keydown', onKey, true);
      return true;
    },
  };
  Object.defineProperty(window, '__sbCapture', { value: api, configurable: true, enumerable: false, writable: true });
})();
