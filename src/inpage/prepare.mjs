/* In-page preparation helpers shared by the Playwright crawler (page.evaluate(fn, arg)) and the browser
 * extension (bundled into extension/lib/inpage.js by scripts/build-extension.mjs).
 * Every function must stay self-contained: it is serialized with Function.prototype.toString. */

// Lazy images: native loading="lazy" -> eager, data-src / data-srcset -> src / srcset (JS lazy loaders).
export function forceLazyInPage() {
  let n = 0;
  const PH = /(placeholder|blank|spacer|transparent)[^/]*\.(gif|png|svg)(\?|$)/i;
  for (const img of document.querySelectorAll('img')) {
    if (img.loading === 'lazy') { img.loading = 'eager'; n++; }
    for (const [from, to] of [['data-src', 'src'], ['data-lazy-src', 'src'], ['data-original', 'src'], ['data-srcset', 'srcset'], ['data-lazy-srcset', 'srcset']]) {
      const v = img.getAttribute(from); const cur = img.getAttribute(to);
      if (v && v !== cur && (!cur || cur.startsWith('data:') || PH.test(cur))) { img.setAttribute(to, v); n++; }
    }
  }
  for (const s of document.querySelectorAll('source[data-srcset]')) if (!s.getAttribute('srcset')) { s.setAttribute('srcset', s.getAttribute('data-srcset')); n++; }
  return n;
}

// Scroll the whole page step by step (IntersectionObserver lazy-loading, scroll-reveal), then back to the top.
export async function autoScrollInPage({ maxSteps = 90, budgetMs = 25000, restore = false } = {}) {
  const t0 = Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const H = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const step = Math.max(300, Math.round(innerHeight * 0.7));
  const to = (top) => window.scrollTo({ top, left: 0, behavior: 'instant' });
  const start = window.scrollY;
  const loadingNear = () => [...document.images].filter((i) => { if (i.complete) return false; const r = i.getBoundingClientRect(); return r.width > 0 && r.bottom > -300 && r.top < innerHeight + 600; });
  let y = 0, n = 0;
  while (y < H() && n < maxSteps && Date.now() - t0 < budgetMs) {
    y += step; to(y); n++;
    await sleep(120);
    const p = loadingNear();
    if (p.length) await Promise.race([Promise.all(p.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))), sleep(900)]);
  }
  await sleep(250);
  to(restore ? start : 0);
  await sleep(350);
  if (!restore && window.scrollY !== 0) { document.documentElement.style.scrollBehavior = 'auto'; to(0); await sleep(200); }
  return n;
}

// Wait for web fonts and pending images (stops when nothing changes for 3 s).
export async function waitAssetsInPage(ms = 12000) {
  const t0 = Date.now(); const sleep = (x) => new Promise((r) => setTimeout(r, x));
  const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  await Promise.race([fonts, sleep(Math.min(ms, 4000))]);
  let last = -1, stall = 0;
  while (Date.now() - t0 < ms) {
    const left = [...document.images].filter((i) => !i.complete).length;
    if (!left) break;
    if (left === last) { stall += 250; if (stall >= 3000) break; } else { stall = 0; last = left; }
    await sleep(250);
  }
}

// Finite CSS transitions / animations (scroll-reveal, entrance effects) jump to their end state.
export async function finishAnimationsInPage() {
  let n = 0;
  for (const a of document.getAnimations ? document.getAnimations() : []) {
    try {
      if (a.playState === 'finished') continue;
      const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
      if (!t || !Number.isFinite(t.endTime) || t.endTime > 60000) continue;
      a.finish(); n++;
    } catch (e) {}
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return n;
}

// External SVG sprites (<use href="/sprite.svg#icon">): fetch the sprite, put its <symbol>s into one hidden
// container and point the <use> elements at the local ids, so the extractor and the snapshot see real markup.
// Returns a token for restoreSpritesInPage() (the page is put back exactly as it was after the capture).
export async function inlineSpritesInPage({ maxFiles = 12, timeoutMs = 8000 } = {}) {
  const uses = [...document.querySelectorAll('use')].map((u) => ({ u, ref: u.getAttribute('href') || u.getAttribute('xlink:href') || '' })).filter((x) => x.ref && x.ref[0] !== '#' && x.ref.includes('#'));
  if (!uses.length) return { files: 0, symbols: 0, uses: 0 };
  const byFile = new Map();
  for (const x of uses) { let abs; try { abs = new URL(x.ref, location.href); } catch (e) { continue; } const file = abs.href.split('#')[0]; if (!byFile.has(file)) byFile.set(file, []); byFile.get(file).push({ ...x, id: abs.hash.slice(1) }); }
  const NS = 'http://www.w3.org/2000/svg';
  let box = document.getElementById('__sb_sprites');
  if (!box) { box = document.createElementNS(NS, 'svg'); box.setAttribute('id', '__sb_sprites'); box.setAttribute('aria-hidden', 'true'); box.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden'); box.setAttribute('data-sb-temp', '1'); document.body.appendChild(box); }
  let files = 0, symbols = 0, rewired = 0; const failed = [];
  for (const [file, list] of [...byFile].slice(0, maxFiles)) {
    let text = '';
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(file, { credentials: new URL(file).origin === location.origin ? 'include' : 'omit', signal: ctl.signal });
      clearTimeout(tm);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      text = await r.text();
    } catch (e) { failed.push(file); continue; }
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.querySelector('parsererror')) { failed.push(file); continue; }
    files++;
    const prefix = '__sb_' + files + '_';
    for (const x of list) {
      const sym = x.id && doc.getElementById(x.id);
      if (!sym) continue;
      const localId = prefix + x.id;
      if (!document.getElementById(localId)) { const node = document.importNode(sym, true); node.setAttribute('id', localId); box.appendChild(node); symbols++; }
      x.u.setAttribute('data-sb-href', x.ref);
      x.u.setAttribute('href', '#' + localId); x.u.removeAttribute('xlink:href');
      rewired++;
    }
  }
  return { files, symbols, uses: rewired, failed };
}
export function restoreSpritesInPage() {
  for (const u of document.querySelectorAll('use[data-sb-href]')) { u.setAttribute('href', u.getAttribute('data-sb-href')); u.removeAttribute('data-sb-href'); }
  const box = document.getElementById('__sb_sprites'); if (box && box.getAttribute('data-sb-temp')) box.remove();
}

// Texts of the page's stylesheets (<link rel=stylesheet>, @import): from the HTTP cache, CORS or the CSSOM.
export async function collectCssInPage({ max = 60, maxBytes = 6e6 } = {}) {
  const out = []; const seen = new Set();
  const sheets = [];
  const walk = (sh, depth) => {
    if (!sh || depth > 3) return;
    if (sh.href && !seen.has(sh.href)) { seen.add(sh.href); sheets.push(sh); }
    let rules = null; try { rules = sh.cssRules; } catch (e) {}
    if (rules) for (const r of rules) if (r.styleSheet) walk(r.styleSheet, depth + 1);
  };
  for (const sh of document.styleSheets) walk(sh, 0);
  for (const sh of sheets.slice(0, max)) {
    let text = '';
    try { const r = await fetch(sh.href, { credentials: new URL(sh.href).origin === location.origin ? 'include' : 'omit', cache: 'force-cache' }); if (r.ok) text = await r.text(); } catch (e) {}
    if (!text) { try { text = [...sh.cssRules].map((r) => r.cssText).join('\n'); } catch (e) { text = ''; } }
    if (text && text.length < maxBytes) out.push({ url: sh.href, text, cors: !text });
    else if (!text) out.push({ url: sh.href, text: '', blocked: true });
  }
  return out;
}

// Script URLs + inline snippets for the tracker report (trackers are reported, never cloned).
export function scanTrackersInPage() {
  const sc = [...document.scripts];
  return {
    srcs: sc.map((x) => x.src).filter(Boolean).concat([...document.querySelectorAll('iframe[src], img[src][width="1"], img[src][height="1"]')].map((f) => f.src)).slice(0, 400),
    inline: (sc.filter((x) => !x.src).map((x) => x.textContent.slice(0, 30000)).join('\n') + '\n' + [...document.querySelectorAll('noscript')].map((n) => n.textContent).join('\n')).slice(0, 600000),
  };
}

// Framework state embedded in the page (Next.js __NEXT_DATA__, Nuxt, Apollo, Redux preloaded state, JSON-LD):
// the data behind client-side catalogs/filters. Redacted by the CLI before it is written anywhere.
export function hydrationStateInPage({ maxChars = 2e6 } = {}) {
  const out = [];
  const add = (kind, value, extra) => { try { const s = typeof value === 'string' ? value : JSON.stringify(value); if (s && s.length <= maxChars) out.push({ kind, json: s, ...(extra || {}) }); } catch (e) {} };
  const nd = document.getElementById('__NEXT_DATA__'); if (nd) add('next-data', nd.textContent);
  for (const k of ['__NUXT__', '__APOLLO_STATE__', '__PRELOADED_STATE__', '__INITIAL_STATE__', '__INITIAL_DATA__', '__remixContext']) { try { if (window[k] && typeof window[k] === 'object') add('global', window[k], { name: k }); } catch (e) {} }
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) add('ld+json', s.textContent);
  let n = 0;
  for (const s of document.querySelectorAll('script[type="application/json"]')) { if (s.id === '__NEXT_DATA__' || ++n > 20) continue; add('json-script', s.textContent, { id: s.id || '' }); }
  const storage = {};
  for (const [name, st] of [['local', window.localStorage], ['session', window.sessionStorage]]) {
    try { storage[name] = Object.keys(st).slice(0, 200).map((k) => ({ key: k, bytes: (st.getItem(k) || '').length })); } catch (e) { storage[name] = []; }
  }
  return { blobs: out, storage };
}
