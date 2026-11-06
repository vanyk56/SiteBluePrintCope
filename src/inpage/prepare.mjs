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
// Scroll-reveal is detected by behaviour (computed state), not by class names: in-flow elements that are hidden
// (opacity ~0 or visibility:hidden) at the start and turn visible while they are in the viewport. Pages that hide them
// again once they leave the viewport (IntersectionObserver toggles, AOS `mirror`, whileInView without `once`) would come
// out blank in a full-page screenshot and in the extracted styles, so their revealed state is put back after the scroll:
// the class/style attributes seen while visible, and — if the page keeps them hidden anyway — the computed values.
// Returns { steps, revealed, restored }.
export async function autoScrollInPage({ maxSteps = 90, budgetMs = 25000, restore = false, reveal = true } = {}) {
  const t0 = Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const H = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const step = Math.max(300, Math.round(innerHeight * 0.7));
  const to = (top) => window.scrollTo({ top, left: 0, behavior: 'instant' });
  const start = window.scrollY;
  const loadingNear = () => [...document.images].filter((i) => { if (i.complete) return false; const r = i.getBoundingClientRect(); return r.width > 0 && r.bottom > -300 && r.top < innerHeight + 600; });
  // --- scroll-reveal tracking ---
  if (!window.__sbRevealMap) window.__sbRevealMap = new WeakMap();
  const op = (cs) => parseFloat(cs.opacity);
  const hidden = (cs) => op(cs) < 0.05 || cs.visibility === 'hidden';
  const SKIP = 'dialog,[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="tooltip"],[aria-hidden="true"],[hidden],template,details:not([open])';
  const IGNORE = /^(SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE|OPTION|OPTGROUP|BR|WBR|SOURCE|TRACK|PATH|G|DEFS|STOP|USE)$/i;
  const cands = new Set(); const seen = new WeakSet(); const snaps = new Map(); const initTf = new Map();
  let scannedCount = 0, rescans = 0;
  const floating = (el) => { for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) { const p = getComputedStyle(e).position; if (p === 'fixed' || p === 'sticky') return true; } return false; };
  const finishOwn = (el) => { try { for (const a of el.getAnimations()) { const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null; if (t && Number.isFinite(t.endTime) && t.endTime < 60000 && a.playState !== 'finished') a.finish(); } } catch (e) {} };
  const scan = () => {
    if (!reveal || !document.body) return;
    const all = document.body.getElementsByTagName('*'); scannedCount = all.length;
    for (let i = 0; i < all.length && i < 25000; i++) {
      const el = all[i]; if (seen.has(el)) continue; seen.add(el);
      if (IGNORE.test(el.tagName)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.display === 'contents' || !hidden(cs)) continue;
      if (cs.position === 'absolute' || cs.position === 'fixed' || cs.position === 'sticky') continue;
      // visibility is inherited: only the topmost hidden element of a subtree is a candidate
      if (op(cs) >= 0.05 && el.parentElement && getComputedStyle(el.parentElement).visibility === 'hidden') continue;
      const r = el.getBoundingClientRect(); if (r.width < 4 || r.height < 4) continue;
      if (el.closest(SKIP) || floating(el.parentElement)) continue;
      cands.add(el);
      initTf.set(el, cs.transform || 'none');
      if (cands.size > 3000) return;
    }
  };
  // candidates in the viewport now: finish their transitions, remember the attributes of the visible state
  const check = () => {
    let pending = 0;
    for (const el of cands) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= innerHeight || r.width < 1) continue;
      finishOwn(el);
      const cs = getComputedStyle(el);
      const o = op(cs);
      if (cs.visibility === 'hidden' || o < 0.5) { if (o >= 0.05 && cs.visibility !== 'hidden') pending++; continue; }
      snaps.set(el, { cls: el.getAttribute('class'), style: el.getAttribute('style'), opacity: cs.opacity, transform: cs.transform, visibility: cs.visibility });
      if (!window.__sbRevealMap.has(el)) {
        const tf0 = initTf.get(el) || 'none';
        let preset = 'fade-up';
        const m = /^matrix\(([^)]+)\)$/.exec(tf0);
        if (m) {
          const p = m[1].split(',').map(Number);
          const sx = Math.hypot(p[0], p[1]), tx = p[4] || 0, ty = p[5] || 0;
          if (Math.abs(sx - 1) > 0.06 && sx < 1) preset = 'zoom-in';
          else if (ty > 6) preset = 'fade-up';
          else if (ty < -6) preset = 'fade-down';
          else if (tx > 6) preset = 'fade-left';
          else if (tx < -6) preset = 'fade-right';
          else preset = 'fade-in';
        }
        window.__sbRevealMap.set(el, { preset, durationMs: 650, delayMs: 0 });
      }
    }
    return pending;
  };
  scan();
  let y = 0, n = 0;
  while (y < H() && n < maxSteps && Date.now() - t0 < budgetMs) {
    y += step; to(y); n++;
    await sleep(120);
    const p = loadingNear();
    if (p.length) await Promise.race([Promise.all(p.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))), sleep(900)]);
    if (cands.size || reveal) {
      // JS tweens (rAF-driven, invisible to getAnimations) get one short extra wait
      if (check()) { await sleep(350); check(); }
      // content rendered while scrolling (lazy sections, infinite lists): look for new candidates now and then
      if (reveal && rescans < 6 && document.body && document.body.getElementsByTagName('*').length > scannedCount * 1.05 + 20) { rescans++; scan(); check(); }
    }
  }
  await sleep(250);
  to(restore ? start : 0);
  await sleep(350);
  if (!restore && window.scrollY !== 0) { document.documentElement.style.scrollBehavior = 'auto'; to(0); await sleep(200); }
  // --- put back the revealed state of elements the page hid again ---
  let restored = 0;
  if (snaps.size) {
    const back = [];
    for (const [el, s] of snaps) {
      if (!el.isConnected) continue;
      const cs = getComputedStyle(el);
      if (!hidden(cs) && op(cs) >= 0.5) continue;
      back.push({ el, s, cls: el.getAttribute('class'), style: el.getAttribute('style') });
      if (s.cls === null) el.removeAttribute('class'); else el.setAttribute('class', s.cls);
      if (s.style === null) el.removeAttribute('style'); else el.setAttribute('style', s.style);
    }
    await frames();
    for (const b of back) {
      const { el, s } = b;
      finishOwn(el);
      let cs = getComputedStyle(el);
      if (hidden(cs) || op(cs) < 0.5) {
        // the hidden state lives outside the attributes (framework state, inline style re-applied): pin the visible values
        el.style.setProperty('opacity', s.opacity, 'important');
        if (s.visibility !== 'hidden') el.style.setProperty('visibility', 'visible', 'important');
        el.style.setProperty('transform', s.transform || 'none', 'important');
        el.style.setProperty('transition', 'none', 'important');
        cs = getComputedStyle(el);
      }
      // fade carousels / stacked slides: two visible siblings on the same spot means this one is meant to be hidden
      const r = el.getBoundingClientRect(); let clash = false;
      if (el.parentElement && r.width > 0) {
        let k = 0;
        for (const sb of el.parentElement.children) {
          if (sb === el || ++k > 40) continue;
          const c2 = getComputedStyle(sb); if (hidden(c2) || c2.display === 'none') continue;
          const r2 = sb.getBoundingClientRect();
          const ix = Math.max(0, Math.min(r.right, r2.right) - Math.max(r.left, r2.left)); const iy = Math.max(0, Math.min(r.bottom, r2.bottom) - Math.max(r.top, r2.top));
          if (ix * iy > 0.5 * Math.min(r.width * r.height, r2.width * r2.height)) { clash = true; break; }
        }
      }
      if (clash) {
        if (b.cls === null) el.removeAttribute('class'); else el.setAttribute('class', b.cls);
        if (b.style === null) el.removeAttribute('style'); else el.setAttribute('style', b.style);
        continue;
      }
      restored++;
    }
    await frames();
  }
  return { steps: n, revealed: snaps.size, restored };
}

// Motion kill-switch for screenshots: transitions/animations take no time, smooth scrolling and the text caret are off.
// Both the original and the clone are photographed in this state (removed again by unfreezeMotionInPage).
export function freezeMotionInPage() {
  if (document.getElementById('__sb-freeze')) return false;
  const st = document.createElement('style'); st.id = '__sb-freeze';
  st.textContent = '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important;scroll-behavior:auto!important;caret-color:transparent!important}html{scroll-behavior:auto!important}';
  (document.head || document.documentElement).appendChild(st);
  return true;
}
export function unfreezeMotionInPage() { const st = document.getElementById('__sb-freeze'); if (st) st.remove(); return !!st; }

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
// Before finishing them, snapshots active Web Animations API / CSS animations into window.__sbCapturedAnims.
export async function finishAnimationsInPage() {
  let n = 0;
  if (!window.__sbCapturedAnims) window.__sbCapturedAnims = [];
  for (const a of document.getAnimations ? document.getAnimations() : []) {
    try {
      const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
      if (a.effect && window.__sbCapturedAnims.length < 150) {
        const kfs = a.effect.getKeyframes ? a.effect.getKeyframes().slice(0, 10) : [];
        const target = a.effect.target;
        const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
        window.__sbCapturedAnims.push({
          name: a.animationName || a.transitionProperty || a.id || 'web-anim',
          kind: a.animationName ? 'css-keyframes' : a.transitionProperty ? 'css-transition' : 'waapi',
          tag,
          duration: t ? Number(t.duration) || 0 : 0,
          delay: t ? Number(t.delay) || 0 : 0,
          easing: (t && t.easing) || 'ease',
          iterations: t ? (Number.isFinite(t.iterations) ? t.iterations : 'infinite') : 1,
          keyframes: kfs.map((k) => {
            const o = { offset: k.offset, easing: k.easing };
            for (const p of ['opacity', 'transform', 'translate', 'scale', 'rotate', 'filter', 'backgroundColor', 'color']) {
              if (k[p] !== undefined && k[p] !== '') o[p] = k[p];
            }
            return o;
          }),
        });
      }
      if (a.playState === 'finished') continue;
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
